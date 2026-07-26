import { AsyncLocalStorage } from 'node:async_hooks';
import { WebSocket, WebSocketServer } from 'ws';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const HANGUP_FALLBACK_MS = 7000;
const callContext = new AsyncLocalStorage();
const previousFetch = globalThis.fetch;
const previousHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
const previousOn = WebSocket.prototype.on;
const previousSend = WebSocket.prototype.send;
const previousEmit = WebSocket.prototype.emit;
const openAiLinks = new WeakMap();
const telnyxLinks = new WeakMap();

export const TERMINAL_CANCELLATION_LINE = "Okay. I've canceled the estimate request. Goodbye.";

function clean(value) {
  return String(value || '').trim();
}

function parseJson(value) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  } catch {
    return null;
  }
}

function isOpenAiRealtimeSocket(socket) {
  return clean(socket?.url || socket?._url).includes('api.openai.com/v1/realtime');
}

function cancellationInstructions(value = '') {
  return /i(?:'|’)ve canceled the estimate request/i.test(clean(value));
}

export function rewriteCancellationInstructions(value = '') {
  const instructions = clean(value);
  if (!cancellationInstructions(instructions)) return instructions;
  return `Say exactly this and nothing else: ${JSON.stringify(TERMINAL_CANCELLATION_LINE)}`;
}

function acknowledgeBlockedSend(args) {
  const callback = [...args].reverse().find((value) => typeof value === 'function');
  if (callback) queueMicrotask(() => callback());
}

function clearHangupTimer(link) {
  if (link.hangupTimer) clearTimeout(link.hangupTimer);
  link.hangupTimer = null;
}

async function hangupCancelledCall(link, trigger) {
  if (!link || link.hangupRequested) return;
  link.hangupRequested = true;
  clearHangupTimer(link);

  if (!link.callControlId || !process.env.TELNYX_API_KEY) {
    try {
      link.telnyxSocket?.close();
    } catch {
      // The media socket may already be closed.
    }
    return;
  }

  try {
    const response = await previousFetch(
      `${TELNYX_API_BASE}/calls/${encodeURIComponent(link.callControlId)}/actions/hangup`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(3500),
      },
    );
    if (!response.ok) throw new Error(`Telnyx hangup returned ${response.status}`);
    console.log('[Cancellation finalizer]', {
      action: 'ended cancelled estimate call',
      trigger,
      callId: link.callControlId,
    });
  } catch (error) {
    console.error('[Cancellation finalizer] Hangup failed', error.message);
    try {
      link.telnyxSocket?.close();
    } catch {
      // The call may already have ended.
    }
  }
}

function armFallbackHangup(link) {
  clearHangupTimer(link);
  link.hangupTimer = setTimeout(
    () => hangupCancelledCall(link, 'fallback-timeout'),
    HANGUP_FALLBACK_MS,
  );
  link.hangupTimer.unref?.();
}

function parseUpgradeCallId(request) {
  try {
    const url = new URL(request?.url || '/', `http://${request?.headers?.host || 'localhost'}`);
    return clean(url.searchParams.get('callControlId'));
  } catch {
    return '';
  }
}

WebSocketServer.prototype.handleUpgrade = function cancellationFinalizerHandleUpgrade(request, socket, head, callback) {
  const callControlId = parseUpgradeCallId(request);
  return previousHandleUpgrade.call(this, request, socket, head, (websocket, upgradeRequest) => {
    if (!callControlId) return callback(websocket, upgradeRequest);

    const link = {
      callControlId,
      telnyxSocket: websocket,
      openAiSocket: null,
      terminalCancellation: false,
      cancellationResponseQueued: false,
      cancellationResponseActive: false,
      hangupOnMark: false,
      hangupRequested: false,
      hangupTimer: null,
    };
    telnyxLinks.set(websocket, link);

    const linkedEmit = websocket.emit;
    websocket.emit = function cancellationFinalizerTelnyxEmit(eventName, ...args) {
      return callContext.run(link, () => {
        if (eventName === 'message' && args[0]) {
          const message = parseJson(args[0]);
          const event = message?.event || message?.event_type || message?.type;
          if (event === 'mark' && link.hangupOnMark) {
            link.hangupOnMark = false;
            hangupCancelledCall(link, 'playback-mark');
          }
        }
        if (eventName === 'close') clearHangupTimer(link);
        return linkedEmit.call(this, eventName, ...args);
      });
    };

    return callback(websocket, upgradeRequest);
  });
};

WebSocket.prototype.on = function cancellationFinalizerOn(eventName, listener) {
  if (isOpenAiRealtimeSocket(this) && !openAiLinks.has(this)) {
    const link = callContext.getStore();
    if (link?.callControlId && link?.telnyxSocket) {
      link.openAiSocket = this;
      openAiLinks.set(this, link);
    }
  }
  return previousOn.call(this, eventName, listener);
};

WebSocket.prototype.send = function cancellationFinalizerSend(data, ...args) {
  const link = openAiLinks.get(this);
  if (!link) return previousSend.call(this, data, ...args);

  const message = parseJson(data);
  if (!message || message.type !== 'response.create') {
    return previousSend.call(this, data, ...args);
  }

  const instructions = clean(message?.response?.instructions);
  const rewritten = rewriteCancellationInstructions(instructions);
  if (rewritten !== instructions) {
    link.terminalCancellation = true;
    link.cancellationResponseQueued = true;
    const outgoing = {
      ...message,
      response: {
        ...(message.response || {}),
        output_modalities: ['audio'],
        instructions: rewritten,
      },
    };
    console.log('[Cancellation finalizer]', {
      action: 'converted cancellation into terminal response',
      callId: link.callControlId,
    });
    return previousSend.call(this, JSON.stringify(outgoing), ...args);
  }

  if (link.terminalCancellation) {
    acknowledgeBlockedSend(args);
    console.log('[Cancellation finalizer]', {
      action: 'blocked response after cancellation',
      callId: link.callControlId,
    });
    return undefined;
  }

  return previousSend.call(this, data, ...args);
};

WebSocket.prototype.emit = function cancellationFinalizerEmit(eventName, ...args) {
  const link = openAiLinks.get(this);
  if (eventName === 'message' && link && args[0]) {
    const message = parseJson(args[0]);

    if (message?.type === 'response.created' && link.cancellationResponseQueued) {
      link.cancellationResponseQueued = false;
      link.cancellationResponseActive = true;
    }

    if (message?.type === 'response.done' && link.cancellationResponseActive) {
      link.cancellationResponseActive = false;
      link.hangupOnMark = true;
      armFallbackHangup(link);
    }

    if (message?.type === 'response.cancelled' && link.cancellationResponseActive) {
      link.cancellationResponseActive = false;
      armFallbackHangup(link);
    }

    if (
      link.terminalCancellation
      && message?.type === 'conversation.item.input_audio_transcription.completed'
    ) {
      return false;
    }
  }

  return previousEmit.call(this, eventName, ...args);
};

console.log('[Cancellation finalizer]', {
  enabled: true,
  behavior: 'turns every cancellation into a terminal goodbye, blocks later questions, and hangs up after playback',
});
