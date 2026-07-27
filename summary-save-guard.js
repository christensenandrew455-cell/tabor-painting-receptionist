import { WebSocket } from 'ws';

export const FINAL_SUMMARY_CONFIRMATION_MARKER = 'FINAL SUMMARY CONFIRMED';

export function buildConfirmedSummarySaveInstructions(fieldAnswers = {}) {
  const payload = {
    fullName: String(fieldAnswers.fullName || '').trim(),
    serviceType: String(fieldAnswers.serviceType || '').trim(),
    cityOrTown: String(fieldAnswers.cityOrTown || '').trim(),
    state: String(fieldAnswers.state || '').trim(),
    streetNumber: String(fieldAnswers.streetNumber || '').trim(),
    streetName: String(fieldAnswers.streetName || '').trim(),
    preferredDateOrDay: String(fieldAnswers.preferredDateOrDay || '').trim(),
    preferredTime: String(fieldAnswers.preferredTime || '').trim(),
    additionalNotes: String(fieldAnswers.additionalNotes || '').trim(),
    contactConsent: fieldAnswers.contactConsent === true,
  };
  return `${FINAL_SUMMARY_CONFIRMATION_MARKER}\nSay exactly: "Okay, great. I'm sending your request now." In the same turn, call submit_estimate_lead exactly once with this JSON object: ${JSON.stringify(payload)}. Do not ask another question before the tool call.`;
}

export function shouldTriggerConfirmedSummarySave({ awaitingSummaryConfirmation = false, transcript = '' } = {}) {
  if (!awaitingSummaryConfirmation) return false;
  return /^(?:yes|yeah|yep|yup|sure|correct|right|that'?s correct|sounds right|all correct|okay|ok|please do|go ahead)\b/i.test(String(transcript || '').trim());
}

const previousSend = WebSocket.prototype.send;
const previousEmit = WebSocket.prototype.emit;
const states = new WeakMap();

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
  if (!states.has(socket)) states.set(socket, { awaitingSummaryConfirmation: false, fieldAnswers: {} });
  return states.get(socket);
}

function extractFieldAnswers(value = '') {
  const source = clean(value);
  const answers = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\-\s*([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (rawValue === 'true') answers[name] = true;
    else if (rawValue === 'false') answers[name] = false;
    else answers[name] = rawValue;
  }
  return answers;
}

WebSocket.prototype.send = function summarySaveSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return previousSend.call(this, data, ...args);
  const message = parseJson(data);
  if (!message) return previousSend.call(this, data, ...args);
  const state = stateFor(this);

  if (message.type === 'conversation.item.create' && message?.item?.role === 'system') {
    const content = Array.isArray(message.item.content) ? message.item.content : [];
    for (const entry of content) {
      if (entry?.type !== 'input_text') continue;
      const text = clean(entry.text);
      if (/^CURRENT CALL STATE\b/im.test(text)) {
        state.fieldAnswers = { ...state.fieldAnswers, ...extractFieldAnswers(text) };
      }
    }
  }

  return previousSend.call(this, data, ...args);
};

WebSocket.prototype.emit = function summarySaveEmit(eventName, ...args) {
  if (eventName === 'message' && isOpenAiRealtimeSocket(this) && args[0]) {
    const message = parseJson(args[0]);
    const state = stateFor(this);

    if (message?.type === 'response.audio_transcript.done' || message?.type === 'response.output_audio_transcript.done') {
      const transcript = clean(message.transcript);
      if (/does all of that sound correct\?/i.test(transcript)) state.awaitingSummaryConfirmation = true;
    }

    if (message?.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = clean(message.transcript);
      if (shouldTriggerConfirmedSummarySave({ awaitingSummaryConfirmation: state.awaitingSummaryConfirmation, transcript })) {
        state.awaitingSummaryConfirmation = false;
        const outgoing = {
          type: 'response.create',
          response: {
            output_modalities: ['audio'],
            instructions: buildConfirmedSummarySaveInstructions(state.fieldAnswers),
          },
        };
        previousSend.call(this, JSON.stringify(outgoing));
        return false;
      }
    }
  }

  return previousEmit.call(this, eventName, ...args);
};

console.log('[Summary save guard]', {
  enabled: true,
  behavior: 'submits the collected lead immediately after the caller confirms the final summary',
});
