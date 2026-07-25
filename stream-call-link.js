import { WebSocketServer } from 'ws';

const originalFetch = globalThis.fetch;
const originalHandleUpgrade = WebSocketServer.prototype.handleUpgrade;

function clean(value) {
  return String(value || '').trim();
}

function streamingCallId(input) {
  const raw = typeof input === 'string' || input instanceof URL
    ? String(input)
    : clean(input?.url);
  const match = raw.match(/\/calls\/([^/]+)\/actions\/streaming_start(?:\?|$)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function linkedStreamUrl(value, callControlId) {
  const url = new URL(String(value));
  url.searchParams.set('callControlId', callControlId);
  return url.toString();
}

globalThis.fetch = async function arkLinkedFetch(input, init = {}) {
  const callControlId = streamingCallId(input);
  if (!callControlId || !init?.body) return originalFetch(input, init);

  try {
    const payload = JSON.parse(String(init.body));
    if (!payload?.stream_url) return originalFetch(input, init);
    const nextPayload = {
      ...payload,
      stream_url: linkedStreamUrl(payload.stream_url, callControlId),
    };
    return originalFetch(input, { ...init, body: JSON.stringify(nextPayload) });
  } catch {
    return originalFetch(input, init);
  }
};

WebSocketServer.prototype.handleUpgrade = function arkLinkedHandleUpgrade(request, socket, head, callback) {
  let linkedCallControlId = '';
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    linkedCallControlId = clean(requestUrl.searchParams.get('callControlId'));
  } catch {
    linkedCallControlId = '';
  }

  return originalHandleUpgrade.call(this, request, socket, head, (websocket, upgradeRequest) => {
    if (linkedCallControlId) {
      const originalEmit = websocket.emit;
      websocket.emit = function arkLinkedEmit(eventName, ...args) {
        if (eventName === 'message' && args[0]) {
          try {
            const message = JSON.parse(args[0].toString());
            const event = message.event || message.event_type || message.type;
            if (event === 'start' || event === 'connected' || event === 'streaming.started') {
              message.call_control_id = message.call_control_id || linkedCallControlId;
              message.start = {
                ...(message.start || {}),
                call_control_id: message.start?.call_control_id || linkedCallControlId,
              };
              args[0] = Buffer.from(JSON.stringify(message));
            }
          } catch {
            // Leave non-JSON media untouched.
          }
        }
        return originalEmit.call(this, eventName, ...args);
      };
    }
    callback(websocket, upgradeRequest);
  });
};

console.log('[Telnyx stream link]', {
  enabled: true,
  behavior: 'carries the webhook call ID into the media WebSocket',
});
