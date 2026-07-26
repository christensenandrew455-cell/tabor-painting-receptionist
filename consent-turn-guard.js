import { WebSocket } from 'ws';

const previousSend = WebSocket.prototype.send;
const previousEmit = WebSocket.prototype.emit;
const socketStates = new WeakMap();

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

function stateFor(socket) {
  if (!socketStates.has(socket)) {
    socketStates.set(socket, {
      callerTurn: 0,
      lastConsentTurn: -1,
      consentRefusals: 0,
      handledCallIds: new Set(),
    });
  }
  return socketStates.get(socket);
}

function toolCallFromMessage(message) {
  const item = message?.item || message?.output_item || {};
  const name = clean(message?.name || item?.name);
  const callId = clean(message?.call_id || item?.call_id || item?.id);
  const raw = message?.arguments || item?.arguments || '{}';
  let args = {};
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    args = {};
  }
  return { name, callId, args };
}

export function decideConsentTurn({
  callerTurn = 0,
  lastConsentTurn = -1,
  consentRefusals = 0,
  agreed = false,
} = {}) {
  if (agreed) {
    return {
      duplicate: false,
      lastConsentTurn: -1,
      consentRefusals: 0,
    };
  }

  const turn = Math.max(0, Number(callerTurn) || 0);
  if (turn === Number(lastConsentTurn)) {
    return {
      duplicate: true,
      lastConsentTurn: Number(lastConsentTurn),
      consentRefusals: Math.max(0, Number(consentRefusals) || 0),
    };
  }

  return {
    duplicate: false,
    lastConsentTurn: turn,
    consentRefusals: Math.max(0, Number(consentRefusals) || 0) + 1,
  };
}

function sendDuplicateToolOutput(socket, callId, state) {
  if (!callId || socket.readyState !== WebSocket.OPEN) return;
  previousSend.call(socket, JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({
        ok: true,
        agreed: false,
        refusals: state.consentRefusals,
        duplicateTurn: true,
      }),
    },
  }));
}

WebSocket.prototype.emit = function consentTurnEmit(eventName, ...args) {
  if (eventName !== 'message' || !isOpenAiRealtimeSocket(this) || !args[0]) {
    return previousEmit.call(this, eventName, ...args);
  }

  const message = parseJson(args[0]);
  if (!message) return previousEmit.call(this, eventName, ...args);
  const state = stateFor(this);

  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    state.callerTurn += 1;
  }

  if (message.type === 'response.function_call_arguments.done' || message.type === 'response.output_item.done') {
    const call = toolCallFromMessage(message);
    if (call.name === 'record_contact_consent') {
      if (call.callId && state.handledCallIds.has(call.callId)) return false;
      if (call.callId) state.handledCallIds.add(call.callId);

      const decision = decideConsentTurn({
        callerTurn: state.callerTurn,
        lastConsentTurn: state.lastConsentTurn,
        consentRefusals: state.consentRefusals,
        agreed: call.args?.agreed === true,
      });
      state.lastConsentTurn = decision.lastConsentTurn;
      state.consentRefusals = decision.consentRefusals;

      if (decision.duplicate) {
        sendDuplicateToolOutput(this, call.callId, state);
        console.log('[Consent turn guard]', {
          action: 'ignored duplicate consent tool call from the same caller answer',
          callerTurn: state.callerTurn,
          refusals: state.consentRefusals,
        });
        return false;
      }
    }
  }

  return previousEmit.call(this, eventName, ...args);
};

console.log('[Consent turn guard]', {
  enabled: true,
  behavior: 'counts one consent decision per caller answer so the first no always explains and retries',
});
