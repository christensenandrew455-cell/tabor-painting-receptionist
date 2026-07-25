import { AsyncLocalStorage } from 'node:async_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import {
  THINKING_CUE_DELAY_MS,
  THINKING_CUE_PLAYBACK_MS,
  THINKING_CUES,
  thinkingCueDelayMs,
  thinkingCueForSequence,
  shouldHoldTelnyxEvent,
} from './thinking-cue-policy.js';
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const AUDIO_FRAME_MS = 20;
const callContext = new AsyncLocalStorage();
const originalFetch = globalThis.fetch;
const previousHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
const previousOn = WebSocket.prototype.on;
const previousSend = WebSocket.prototype.send;
const previousEmit = WebSocket.prototype.emit;
const openAiStates = new WeakMap();
const telnyxLinks = new WeakMap();
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
function clearTimer(timer) {
  if (timer) clearTimeout(timer);
  return null;
}
function stopMediaFlush(state) {
  state.mediaFlushTimer = clearTimer(state.mediaFlushTimer);
}
function clearQueuedMedia(state) {
  stopMediaFlush(state);
  state.mediaQueue.length = 0;
}
function sendQueuedMedia(state) {
  state.mediaFlushTimer = null;
  if (state.cueActive || !state.telnyxSocket || state.telnyxSocket.readyState !== WebSocket.OPEN) return;
  const next = state.mediaQueue.shift();
  if (!next) return;
  previousSend.call(state.telnyxSocket, next.data, ...next.args);
  if (state.mediaQueue.length) {
    state.mediaFlushTimer = setTimeout(() => sendQueuedMedia(state), AUDIO_FRAME_MS);
  }
}
function releaseCue(state) {
  state.cueReleaseTimer = clearTimer(state.cueReleaseTimer);
  state.cueRequestController?.abort();
  state.cueRequestController = null;
  state.cueActive = false;
  state.cuePlaybackAccepted = false;
  if (state.mediaQueue.length && !state.mediaFlushTimer) {
    state.mediaFlushTimer = setTimeout(() => sendQueuedMedia(state), 0);
  }
}
async function stopTelnyxPlayback(state) {
  if (!state.callControlId || !process.env.TELNYX_API_KEY) return;
  try {
    await originalFetch(`${TELNYX_API_BASE}/calls/${encodeURIComponent(state.callControlId)}/actions/playback_stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    // The caller has already resumed; do not delay the call for a failed stop command.
  }
}
function cancelCue(state, { stopPlayback = false, discardMedia = false } = {}) {
  state.cueTimer = clearTimer(state.cueTimer);
  state.cueReleaseTimer = clearTimer(state.cueReleaseTimer);
  const wasActive = state.cueActive;
  const playbackAccepted = state.cuePlaybackAccepted;
  state.cueRequestController?.abort();
  state.cueRequestController = null;
  state.cueActive = false;
  state.cuePlaybackAccepted = false;
  state.turnAwaitingAudio = false;
  if (discardMedia) clearQueuedMedia(state);
  else if (state.mediaQueue.length && !state.mediaFlushTimer) {
    state.mediaFlushTimer = setTimeout(() => sendQueuedMedia(state), 0);
  }
  if (stopPlayback && wasActive && playbackAccepted) stopTelnyxPlayback(state);
}
async function issueSpeak(state, cue) {
  if (!state.callControlId || !process.env.TELNYX_API_KEY) return false;
  const url = `${TELNYX_API_BASE}/calls/${encodeURIComponent(state.callControlId)}/actions/speak`;
  const common = {
    payload: cue,
    payload_type: 'text',
    language: 'en-US',
    target_legs: 'self',
    command_id: `thinking-cue-${state.turnSequence}-${state.cueSequence}`,
  };
  const attempts = [
    {
      ...common,
      voice: 'Telnyx.NaturalHD.astra',
      service_level: 'premium',
      voice_settings: { voice_speed: 0.86 },
    },
    {
      ...common,
      voice: 'female',
      service_level: 'basic',
    },
  ];
  for (const body of attempts) {
    if (!state.cueActive) return false;
    const controller = new AbortController();
    state.cueRequestController = controller;
    const timeout = setTimeout(() => controller.abort(), 900);
    try {
      const response = await originalFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok && state.cueActive) return true;
    } catch {
      // Try the basic Telnyx voice before giving up on the cue.
    } finally {
      clearTimeout(timeout);
      if (state.cueRequestController === controller) state.cueRequestController = null;
    }
  }
  return false;
}
function scheduleThinkingCue(state) {
  state.cueTimer = clearTimer(state.cueTimer);
  if (state.cueSentForTurn || !state.turnAwaitingAudio || !state.callControlId) return;
  const delay = thinkingCueDelayMs({ speechStoppedAt: state.lastSpeechStoppedAt });
  state.cueTimer = setTimeout(async () => {
    state.cueTimer = null;
    if (
      state.cueSentForTurn
      || !state.turnAwaitingAudio
      || state.assistantAudioStarted
      || state.callerSpeaking
      || !state.openAiSocket
      || state.openAiSocket.readyState !== WebSocket.OPEN
    ) return;
    state.cueSentForTurn = true;
    state.cueActive = true;
    state.cueSequence += 1;
    const cue = thinkingCueForSequence(state.cueSequence - 1);
    const accepted = await issueSpeak(state, cue);
    if (!accepted || !state.cueActive) {
      releaseCue(state);
      console.log('[Thinking cue]', { action: 'skipped after Telnyx speak failure' });
      return;
    }
    state.cuePlaybackAccepted = true;
    state.cueReleaseTimer = setTimeout(() => releaseCue(state), THINKING_CUE_PLAYBACK_MS);
    console.log('[Thinking cue]', {
      action: 'played fixed latency cue',
      delayMs: THINKING_CUE_DELAY_MS,
      cue,
      callId: state.callControlId,
    });
  }, delay);
}
function stateForOpenAi(socket, link) {
  if (!openAiStates.has(socket)) {
    const state = {
      openAiSocket: socket,
      telnyxSocket: link.telnyxSocket,
      callControlId: link.callControlId,
      lastSpeechStoppedAt: 0,
      callerSpeaking: false,
      turnSequence: 0,
      turnAwaitingAudio: false,
      assistantAudioStarted: false,
      cueSentForTurn: false,
      cueSequence: 0,
      cueTimer: null,
      cueActive: false,
      cueReleaseTimer: null,
      cueRequestController: null,
      cuePlaybackAccepted: false,
      mediaQueue: [],
      mediaFlushTimer: null,
    };
    openAiStates.set(socket, state);
    link.state = state;
  }
  return openAiStates.get(socket);
}
WebSocketServer.prototype.handleUpgrade = function thinkingCueHandleUpgrade(request, socket, head, callback) {
  let callControlId = '';
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    callControlId = clean(requestUrl.searchParams.get('callControlId'));
  } catch {
    callControlId = '';
  }
  return previousHandleUpgrade.call(this, request, socket, head, (websocket, upgradeRequest) => {
    if (!callControlId) return callback(websocket, upgradeRequest);
    const link = { callControlId, telnyxSocket: websocket, state: null };
    telnyxLinks.set(websocket, link);
    const linkedEmit = websocket.emit;
    websocket.emit = function thinkingCueTelnyxEmit(eventName, ...args) {
      if (eventName !== 'message') return linkedEmit.call(this, eventName, ...args);
      return callContext.run(link, () => linkedEmit.call(this, eventName, ...args));
    };
    return callback(websocket, upgradeRequest);
  });
};
WebSocket.prototype.on = function thinkingCueOn(eventName, listener) {
  if (isOpenAiRealtimeSocket(this) && !openAiStates.has(this)) {
    const link = callContext.getStore();
    if (link?.callControlId && link?.telnyxSocket) stateForOpenAi(this, link);
  }
  return previousOn.call(this, eventName, listener);
};
WebSocket.prototype.send = function thinkingCueSend(data, ...args) {
  const openAiState = openAiStates.get(this);
  if (openAiState) {
    const message = parseJson(data);
    let outgoingData = data;
    if (message?.type === 'response.create') {
      const instructions = clean(message?.response?.instructions);
      const responseKind = instructions ? 'controlled' : 'natural';
      const taggedMessage = {
        ...message,
        response: {
          ...(message.response || {}),
          metadata: {
            ...(message?.response?.metadata || {}),
            ark_response_kind: responseKind,
            ark_turn_sequence: String(openAiState.turnSequence),
          },
        },
      };
      outgoingData = JSON.stringify(taggedMessage);
    }
    if (message?.type === 'response.cancel') {
      cancelCue(openAiState, { stopPlayback: true, discardMedia: true });
    }
    return previousSend.call(this, outgoingData, ...args);
  }
  const link = telnyxLinks.get(this);
  const state = link?.state;
  if (state) {
    const message = parseJson(data);
    if (message?.event === 'clear') {
      cancelCue(state, { stopPlayback: true, discardMedia: true });
      return previousSend.call(this, data, ...args);
    }
    if (shouldHoldTelnyxEvent(message, state.cueActive, state.mediaQueue.length)) {
      state.mediaQueue.push({ data, args });
      return undefined;
    }
  }
  return previousSend.call(this, data, ...args);
};
WebSocket.prototype.emit = function thinkingCueEmit(eventName, ...args) {
  const state = openAiStates.get(this);
  if (eventName === 'message' && state && args[0]) {
    const message = parseJson(args[0]);
    if (message?.type === 'input_audio_buffer.speech_started') {
      state.callerSpeaking = true;
      state.turnSequence += 1;
      state.cueSentForTurn = false;
      cancelCue(state, { stopPlayback: true, discardMedia: true });
    }
    if (message?.type === 'input_audio_buffer.speech_stopped') {
      state.callerSpeaking = false;
      state.lastSpeechStoppedAt = Date.now();
    }
    if (message?.type === 'response.created') {
      const responseKind = clean(message?.response?.metadata?.ark_response_kind);
      state.assistantAudioStarted = false;
      if (responseKind === 'natural') {
        state.turnAwaitingAudio = true;
        scheduleThinkingCue(state);
      }
    }
    if (message?.type === 'response.audio.delta' || message?.type === 'response.output_audio.delta') {
      if (!state.assistantAudioStarted) {
        state.assistantAudioStarted = true;
        if (state.cueActive && !state.cuePlaybackAccepted) {
          cancelCue(state, { discardMedia: false });
        } else if (!state.cueActive) {
          state.turnAwaitingAudio = false;
          state.cueTimer = clearTimer(state.cueTimer);
        }
      }
    }
    if (message?.type === 'response.cancelled') {
      cancelCue(state, { stopPlayback: true, discardMedia: true });
    }
    if (message?.type === 'response.done') {
      if (state.assistantAudioStarted && !state.cueActive) state.turnAwaitingAudio = false;
    }
  }
  return previousEmit.call(this, eventName, ...args);
};
console.log('[Thinking cue]', {
  enabled: true,
  delayMs: THINKING_CUE_DELAY_MS,
  cues: THINKING_CUES,
  behavior: 'plays one fixed Telnyx cue only when a caller response has no assistant audio after the delay',
});
