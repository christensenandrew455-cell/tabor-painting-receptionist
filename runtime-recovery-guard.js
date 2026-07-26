import { WebSocketServer } from 'ws';
import {
  RUNTIME_HANDOFF_PARAM,
  RUNTIME_HANDOFF_TTL_MS,
  appendRuntimeHandoff,
  callEnvelopeFromTelnyxBody,
  decodeRuntimeHandoff,
  encodeRuntimeHandoff,
  runtimeDataFromOcmResponse,
} from './runtime-recovery-policy.js';

const originalFetch = globalThis.fetch;
const originalHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
const originalMapGet = Map.prototype.get;
const originalMapHas = Map.prototype.has;
const runtimeSnapshots = new Map();
const recoveredMetadata = new Map();
const activeMediaSockets = new Set();
const OCM_RUNTIME_PATH = '/api/receptionist/runtime';
const SHUTDOWN_DRAIN_MS = Math.min(
  120000,
  Math.max(5000, Number(process.env.SHUTDOWN_DRAIN_MS || 45000)),
);
let shuttingDown = false;
let shutdownStartedAt = 0;
let shutdownInterval = null;

function clean(value) {
  return String(value || '').trim();
}

function handoffSecret() {
  return clean(
    process.env.STREAM_HANDOFF_SECRET
    || process.env.TELNYX_API_KEY
    || process.env.OPENAI_API_KEY,
  );
}

function urlFromInput(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return clean(input?.url);
}

function streamingCallId(value) {
  const match = clean(value).match(/\/calls\/([^/]+)\/actions\/streaming_start(?:\?|$)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function scheduleExpiry(map, key, delay = RUNTIME_HANDOFF_TTL_MS) {
  const timer = setTimeout(() => map.delete(key), delay);
  timer.unref?.();
}

async function captureRuntimeSnapshot(input, init, response) {
  const url = urlFromInput(input);
  if (!url.includes(OCM_RUNTIME_PATH) || String(init?.method || 'GET').toUpperCase() !== 'POST') return;

  const envelope = callEnvelopeFromTelnyxBody(init?.body);
  if (!envelope.callControlId || !response?.ok) return;

  try {
    const data = JSON.parse(await response.clone().text());
    const runtimeData = runtimeDataFromOcmResponse(data);
    if (!runtimeData) return;
    runtimeSnapshots.set(envelope.callControlId, {
      runtimeData,
      callerPhone: envelope.callerPhone,
      calledPhone: runtimeData.calledPhone || envelope.calledPhone,
    });
    scheduleExpiry(runtimeSnapshots, envelope.callControlId);
    console.log('[Runtime recovery]', {
      action: 'captured encrypted handoff source',
      callId: envelope.callControlId,
      clientId: runtimeData.clientId,
    });
  } catch (error) {
    console.error('[Runtime recovery] Unable to capture runtime response', error.message);
  }
}

function decorateStreamingStart(input, init = {}) {
  const callControlId = streamingCallId(urlFromInput(input));
  if (!callControlId || !init?.body) return init;
  const metadata = runtimeSnapshots.get(callControlId);
  if (!metadata) return init;

  try {
    const payload = JSON.parse(String(init.body));
    if (!payload?.stream_url) return init;
    const token = encodeRuntimeHandoff({ callControlId, metadata }, handoffSecret());
    payload.stream_url = appendRuntimeHandoff(payload.stream_url, { callControlId, token });
    console.log('[Runtime recovery]', {
      action: 'attached encrypted runtime handoff',
      callId: callControlId,
      tokenCharacters: token.length,
    });
    return { ...init, body: JSON.stringify(payload) };
  } catch (error) {
    console.error('[Runtime recovery] Unable to attach runtime handoff', error.message);
    return init;
  }
}

globalThis.fetch = async function runtimeRecoveryFetch(input, init = {}) {
  const nextInit = decorateStreamingStart(input, init);
  const response = await originalFetch(input, nextInit);
  await captureRuntimeSnapshot(input, nextInit, response);
  return response;
};

Map.prototype.get = function runtimeRecoveryMapGet(key) {
  const ownValue = originalMapGet.call(this, key);
  if (ownValue !== undefined || originalMapHas.call(this, key)) return ownValue;

  const callControlId = clean(key);
  if (!callControlId || !originalMapHas.call(recoveredMetadata, callControlId)) return ownValue;
  const stack = new Error().stack || '';
  if (!/\binitializeFromStart\b/.test(stack)) return ownValue;

  const metadata = originalMapGet.call(recoveredMetadata, callControlId);
  console.log('[Runtime recovery]', {
    action: 'restored matched profile into replacement process',
    callId: callControlId,
    clientId: metadata?.runtimeData?.clientId || '',
  });
  return metadata;
};

function parseUpgradeUrl(request) {
  try {
    return new URL(request?.url || '/', `http://${request?.headers?.host || 'localhost'}`);
  } catch {
    return null;
  }
}

function rejectRestartingUpgrade(socket) {
  try {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n');
  } catch {
    // The connection may already be gone.
  }
  socket.destroy();
}

WebSocketServer.prototype.handleUpgrade = function runtimeRecoveryHandleUpgrade(request, socket, head, callback) {
  const requestUrl = parseUpgradeUrl(request);
  const isMediaStream = requestUrl?.pathname === '/media-stream';

  if (isMediaStream && shuttingDown) {
    rejectRestartingUpgrade(socket);
    return;
  }

  if (isMediaStream) {
    const token = clean(requestUrl.searchParams.get(RUNTIME_HANDOFF_PARAM));
    const queryCallId = clean(requestUrl.searchParams.get('callControlId'));
    if (token) {
      try {
        const payload = decodeRuntimeHandoff(token, handoffSecret());
        if (queryCallId && payload.callControlId !== queryCallId) {
          throw new Error('The stream call ID does not match the encrypted handoff.');
        }
        recoveredMetadata.set(payload.callControlId, payload.metadata);
        scheduleExpiry(recoveredMetadata, payload.callControlId, Math.max(1000, payload.expiresAt - Date.now()));
        console.log('[Runtime recovery]', {
          action: 'accepted encrypted runtime handoff',
          callId: payload.callControlId,
          clientId: payload.metadata?.runtimeData?.clientId || '',
        });
      } catch (error) {
        console.error('[Runtime recovery] Rejected invalid runtime handoff', error.message);
      }
    }
  }

  return originalHandleUpgrade.call(this, request, socket, head, (websocket, upgradeRequest) => {
    if (isMediaStream) {
      activeMediaSockets.add(websocket);
      websocket.once('close', () => activeMediaSockets.delete(websocket));
    }
    callback(websocket, upgradeRequest);
  });
};

function completeShutdown() {
  if (shutdownInterval) clearInterval(shutdownInterval);
  shutdownInterval = null;
  console.log('[Graceful shutdown]', {
    action: 'process exiting cleanly',
    activeMediaStreams: activeMediaSockets.size,
  });
  process.exit(0);
}

function beginGracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownStartedAt = Date.now();
  console.log('[Graceful shutdown]', {
    signal,
    action: 'draining existing media streams',
    activeMediaStreams: activeMediaSockets.size,
    drainMs: SHUTDOWN_DRAIN_MS,
  });

  shutdownInterval = setInterval(() => {
    if (activeMediaSockets.size === 0) {
      completeShutdown();
      return;
    }

    if (Date.now() - shutdownStartedAt < SHUTDOWN_DRAIN_MS) return;
    console.log('[Graceful shutdown]', {
      action: 'drain deadline reached; closing remaining streams for reconnect',
      activeMediaStreams: activeMediaSockets.size,
    });
    for (const websocket of activeMediaSockets) {
      try {
        websocket.close(1012, 'Service restarting');
      } catch {
        // Continue closing the remaining streams.
      }
    }
    const timer = setTimeout(completeShutdown, 750);
    timer.unref?.();
  }, 250);
}

process.once('SIGTERM', () => beginGracefulShutdown('SIGTERM'));
process.once('SIGINT', () => beginGracefulShutdown('SIGINT'));

console.log('[Runtime recovery]', {
  enabled: true,
  encryptedHandoff: true,
  shutdownDrainMs: SHUTDOWN_DRAIN_MS,
  behavior: 'restores matched ARK OCM call settings after a process replacement and drains active streams on SIGTERM',
});
