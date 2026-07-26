import { WebSocket } from 'ws';
import {
  CANCELLATION_PATTERN,
  HOLD_PATTERN,
  RECEPTIONIST_COMMANDS,
  callMemorySummary,
  createCallMemory,
  holdAcknowledgementFor,
  rememberAssistant,
  rememberCaller,
  resetIntakeMemory,
} from './receptionist-customization.js';

const previousSend = WebSocket.prototype.send;
const previousEmit = WebSocket.prototype.emit;
const socketStates = new WeakMap();
const WEEKDAY_PATTERN = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

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
      memory: createCallMemory(),
      businessName: 'the business',
      estimateWindow: { earliest: '', latest: '' },
      pendingHoldAcknowledgement: '',
      cancellationPending: false,
      pendingSaveSuccess: false,
      awaitingSummaryConfirmation: false,
      summaryConfirmed: false,
      contactConsentRefusals: 0,
      assistantTranscript: '',
      callNames: new Map(),
      blockedCallIds: new Set(),
      handledConsentCalls: new Set(),
    });
  }
  return socketStates.get(socket);
}

function businessNameFromInstructions(value) {
  const match = clean(value).match(/^- Business name:\s*(.+)$/im);
  return clean(match?.[1]) || 'the business';
}

function estimateWindowFromInstructions(value) {
  const match = clean(value).match(/Estimate times may be requested from\s+(.+?)\s+through\s+(.+?)\./i);
  return {
    earliest: clean(match?.[1]),
    latest: clean(match?.[2]),
  };
}

function extractLastQuestion(value) {
  const questions = clean(value).match(/[^.!?]*\?/g) || [];
  return clean(questions.at(-1));
}

export function identifyQuestion(question, businessName = 'the business') {
  const normalized = clean(question).toLowerCase();
  if (!normalized) return null;
  if (/would you like me to help you submit an estimate request/.test(normalized)) {
    return { id: 'estimate_offer', field: '', stage: RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE };
  }
  if (/first and last name/.test(normalized)) return { id: 'full_name', field: 'fullName', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/what service/.test(normalized)) return { id: 'service_type', field: 'serviceType', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/project address/.test(normalized)) return { id: 'project_location', field: 'projectLocation', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/(?:date|day)/.test(normalized) && /time/.test(normalized) && /estimate/.test(normalized)) {
    return { id: 'estimate_schedule', field: 'preferredSchedule', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  }
  if (/city or town/.test(normalized)) return { id: 'city_or_town', field: 'cityOrTown', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/what state/.test(normalized)) return { id: 'state', field: 'state', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/street number/.test(normalized)) return { id: 'street_number', field: 'streetNumber', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/street name/.test(normalized)) return { id: 'street_name', field: 'streetName', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/exact date|upcoming day|preferred.*date/.test(normalized)) return { id: 'preferred_date', field: 'preferredDateOrDay', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/what time|time would you prefer/.test(normalized)) return { id: 'preferred_time', field: 'preferredTime', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/additional notes.*know/.test(normalized)) return { id: 'additional_notes_offer', field: 'additionalNotesRequested', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/what additional notes/.test(normalized)) return { id: 'additional_notes_details', field: 'additionalNotes', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/agree to be contacted/.test(normalized)) return { id: 'contact_consent', field: 'contactConsent', stage: RECEPTIONIST_COMMANDS.stages.CONSENT };
  if (/does all of that sound correct|is all of that correct|is that information correct/.test(normalized)) {
    return { id: 'final_confirmation', field: '', stage: RECEPTIONIST_COMMANDS.stages.CONFIRMATION };
  }
  if (/do you have any (?:other )?questions/.test(normalized)) {
    const after = normalized.includes(clean(businessName).toLowerCase()) || /any other questions/.test(normalized);
    return { id: after ? 'after_save' : 'business_questions', field: '', stage: after ? RECEPTIONIST_COMMANDS.stages.AFTER_ESTIMATE : RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE };
  }
  return null;
}

function looksLikeQuestion(value) {
  const text = clean(value).toLowerCase();
  return /\?$/.test(text) || /^(?:why|what|when|where|who|how|are|is|do|does|did|can|could|would|will|have|has)\b/.test(text);
}

function isAffirmative(value) {
  return /^(?:yes|yeah|yep|yup|sure|correct|right|that'?s correct|sounds right|all correct|okay|ok|please do|go ahead)\b/i.test(clean(value));
}

function clockMinutes(value) {
  const match = clean(value).toLowerCase().replace(/\./g, '').match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 1 || hour > 12) return null;
  if (hour === 12) hour = 0;
  if (match[3] === 'pm') hour += 12;
  return hour * 60 + minute;
}

function displayClock(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function normalizeSpokenTime(hourValue, minuteValue, meridiemValue, estimateWindow = {}) {
  const hour = Number(hourValue);
  const minute = Number(minuteValue || 0);
  const meridiem = clean(meridiemValue).toLowerCase().replace(/\./g, '');
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';

  if (meridiem === 'am' || meridiem === 'pm') {
    if (hour < 1 || hour > 12) return '';
    let normalizedHour = hour % 12;
    if (meridiem === 'pm') normalizedHour += 12;
    return displayClock(normalizedHour * 60 + minute);
  }

  if (hour > 12) return displayClock(hour * 60 + minute);
  if (hour === 0) return displayClock(minute);

  const candidates = [hour * 60 + minute, (hour % 12 + 12) * 60 + minute];
  const earliest = clockMinutes(estimateWindow.earliest);
  const latest = clockMinutes(estimateWindow.latest);
  if (earliest !== null && latest !== null) {
    const inside = candidates.filter((candidate) => candidate >= earliest && candidate <= latest);
    if (inside.length === 1) return displayClock(inside[0]);
    if (inside.length > 1) return displayClock(inside[0]);
  }

  return displayClock(candidates[1]);
}

export function parsePreferredScheduleAnswer(value, estimateWindow = {}) {
  const text = clean(value);
  const weekday = text.match(WEEKDAY_PATTERN)?.[1] || '';
  const isoDate = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || '';
  const usDate = text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/)?.[0] || '';
  const preferredDateOrDay = weekday
    ? weekday.charAt(0).toUpperCase() + weekday.slice(1).toLowerCase()
    : isoDate || usDate;

  const timeMatch = text.match(/\b(?:at|around|by)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i)
    || text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
    || (weekday ? text.match(new RegExp(`${weekday}\\s+(\\d{1,2})(?::([0-5]\\d))?\\b`, 'i')) : null);
  const preferredTime = timeMatch
    ? normalizeSpokenTime(timeMatch[1], timeMatch[2], timeMatch[3], estimateWindow)
    : '';

  return { preferredDateOrDay, preferredTime };
}

export function nextConsentRefusalAction(previousRefusals = 0) {
  const refusalCount = Math.max(0, Number(previousRefusals) || 0) + 1;
  return { refusalCount, cancel: refusalCount >= 2 };
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

function sendStateContext(socket, state) {
  previousSend.call(socket, JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: callMemorySummary(state.memory) }],
    },
  }));
}

function controlledResponse(line) {
  return {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions: `Say exactly this and nothing else: ${JSON.stringify(line)} Then stop and wait.`,
    },
  };
}

function cancellationLine(state) {
  return `Okay, no problem. I've canceled the estimate request. Do you have any questions about ${state.businessName} or its services?`;
}

function consentRetryLine(state) {
  return `I need your consent so ${state.businessName} can contact you about this estimate request. Do you agree to be contacted by ${state.businessName} about this estimate request?`;
}

function successLine(state) {
  return `Perfect. Your estimate request has been sent to ${state.businessName}. They will follow up with you shortly. Before I go, do you have any questions about ${state.businessName}?`;
}

function summaryInstructions(state) {
  state.awaitingSummaryConfirmation = true;
  state.summaryConfirmed = false;
  state.memory.stage = RECEPTIONIST_COMMANDS.stages.CONFIRMATION;
  state.memory.lastQuestionId = 'final_confirmation';
  state.memory.lastQuestionText = 'Does all of that sound correct?';
  state.memory.currentField = '';
  return `Say exactly: "Okay, before I send this in, I want to make sure I have everything correct." Then give one concise complete summary of the caller's full name, service, full project address, preferred estimate date and time, optional additional notes if any, and that contact consent was granted. Never say caller ID or an email address. End by asking exactly: "Does all of that sound correct?" Then stop and wait. Do not call submit_estimate_lead yet.`;
}

function replaceHoldAcknowledgement(message, state) {
  if (!state.pendingHoldAcknowledgement) return message;
  const instructions = clean(message?.response?.instructions);
  if (!/okay, i['’]ll wait/i.test(instructions)) return message;
  const replacement = state.pendingHoldAcknowledgement;
  state.pendingHoldAcknowledgement = '';
  return {
    ...message,
    response: {
      ...(message.response || {}),
      instructions: instructions.replace(/Okay, I['’]ll wait\./i, replacement),
    },
  };
}

function replaceConsentSaveInstruction(message, state) {
  const instructions = clean(message?.response?.instructions);
  if (!/great, give me one second to save that/i.test(instructions)) return message;
  return {
    ...message,
    response: {
      ...(message.response || {}),
      instructions: summaryInstructions(state),
    },
  };
}

function replaceSuccessfulSaveInstruction(message, state) {
  if (!state.pendingSaveSuccess) return message;
  const instructions = clean(message?.response?.instructions);
  if (!/do you have any questions about/i.test(instructions)) return message;
  state.pendingSaveSuccess = false;
  state.memory.leadSaved = true;
  state.memory.stage = RECEPTIONIST_COMMANDS.stages.AFTER_ESTIMATE;
  state.memory.lastQuestionId = 'after_save';
  state.memory.lastQuestionText = `Do you have any questions about ${state.businessName}?`;
  return controlledResponse(successLine(state));
}

function rememberFunctionOutput(state, message) {
  const item = message?.item || {};
  if (item?.type !== 'function_call_output') return;
  const callId = clean(item.call_id);
  const name = state.callNames.get(callId);
  let output = {};
  try {
    output = JSON.parse(item.output || '{}');
  } catch {
    output = {};
  }
  if (name === 'record_contact_consent' && output.ok && output.agreed === true) {
    state.memory.stage = RECEPTIONIST_COMMANDS.stages.CONFIRMATION;
  }
  if (name === 'submit_estimate_lead' && output.ok) {
    state.pendingSaveSuccess = true;
    state.memory.leadSaved = true;
    state.memory.stage = RECEPTIONIST_COMMANDS.stages.AFTER_ESTIMATE;
  }
}

function blockedSubmitOutput(socket, state, callId) {
  if (!callId || state.blockedCallIds.has(callId)) return;
  state.blockedCallIds.add(callId);
  previousSend.call(socket, JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({ ok: false, error: 'final_summary_confirmation_required' }),
    },
  }));
  previousSend.call(socket, JSON.stringify({
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions: summaryInstructions(state),
    },
  }));
}

function handleConsentRefusal(socket, state, call) {
  if (!call.callId || state.handledConsentCalls.has(call.callId)) return false;
  state.handledConsentCalls.add(call.callId);
  const action = nextConsentRefusalAction(state.contactConsentRefusals);
  state.contactConsentRefusals = action.refusalCount;

  previousSend.call(socket, JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: call.callId,
      output: JSON.stringify({
        ok: true,
        agreed: false,
        refusals: action.refusalCount,
        cancelled: action.cancel,
      }),
    },
  }));

  if (!action.cancel) {
    state.memory.stage = RECEPTIONIST_COMMANDS.stages.CONSENT;
    state.memory.lastQuestionId = 'contact_consent';
    state.memory.lastQuestionText = `Do you agree to be contacted by ${state.businessName} about this estimate request?`;
    state.memory.currentField = 'contactConsent';
    previousSend.call(socket, JSON.stringify(controlledResponse(consentRetryLine(state))));
    return false;
  }

  resetIntakeMemory(state.memory);
  state.contactConsentRefusals = 0;
  state.pendingSaveSuccess = false;
  state.awaitingSummaryConfirmation = false;
  state.summaryConfirmed = false;
  sendStateContext(socket, state);
  previousSend.call(socket, JSON.stringify(controlledResponse(cancellationLine(state))));
  return false;
}

function rememberFieldAnswer(state, transcript) {
  const field = state.memory.currentField;
  if (!field || looksLikeQuestion(transcript)) return;

  if (field === 'preferredSchedule' || field === 'preferredDateOrDay' || field === 'preferredTime') {
    const parsed = parsePreferredScheduleAnswer(transcript, state.estimateWindow);
    if (parsed.preferredDateOrDay) state.memory.fieldAnswers.preferredDateOrDay = parsed.preferredDateOrDay;
    if (parsed.preferredTime) state.memory.fieldAnswers.preferredTime = parsed.preferredTime;
    if (parsed.preferredDateOrDay || parsed.preferredTime) return;
  }

  state.memory.fieldAnswers[field] = transcript;
}

WebSocket.prototype.send = function conversationCommandSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return previousSend.call(this, data, ...args);
  const message = parseJson(data);
  if (!message) return previousSend.call(this, data, ...args);
  const state = stateFor(this);

  if (message.type === 'session.update') {
    state.businessName = businessNameFromInstructions(message?.session?.instructions);
    state.estimateWindow = estimateWindowFromInstructions(message?.session?.instructions);
    return previousSend.call(this, data, ...args);
  }

  if (message.type === 'conversation.item.create') {
    rememberFunctionOutput(state, message);
    return previousSend.call(this, data, ...args);
  }

  if (message.type !== 'response.create') return previousSend.call(this, data, ...args);

  let outgoing = message;
  outgoing = replaceHoldAcknowledgement(outgoing, state);
  outgoing = replaceConsentSaveInstruction(outgoing, state);
  outgoing = replaceSuccessfulSaveInstruction(outgoing, state);

  const instructions = clean(outgoing?.response?.instructions);
  if (!instructions && state.cancellationPending) {
    state.cancellationPending = false;
    sendStateContext(this, state);
    return previousSend.call(this, JSON.stringify(controlledResponse(cancellationLine(state))), ...args);
  }

  if (!instructions) sendStateContext(this, state);
  return previousSend.call(this, JSON.stringify(outgoing), ...args);
};

WebSocket.prototype.emit = function conversationCommandEmit(eventName, ...args) {
  if (eventName === 'message' && isOpenAiRealtimeSocket(this) && args[0]) {
    const message = parseJson(args[0]);
    const state = stateFor(this);

    if (message?.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = clean(message.transcript);
      rememberCaller(state.memory, transcript);
      if (HOLD_PATTERN.test(transcript)) {
        state.pendingHoldAcknowledgement = holdAcknowledgementFor(transcript);
        state.memory.stage = RECEPTIONIST_COMMANDS.stages.HOLD;
      } else if (CANCELLATION_PATTERN.test(transcript)) {
        resetIntakeMemory(state.memory);
        state.contactConsentRefusals = 0;
        state.cancellationPending = true;
        state.awaitingSummaryConfirmation = false;
        state.summaryConfirmed = false;
      } else {
        if (state.awaitingSummaryConfirmation && isAffirmative(transcript)) {
          state.summaryConfirmed = true;
          state.awaitingSummaryConfirmation = false;
        }
        rememberFieldAnswer(state, transcript);
      }
    }

    if (message?.type === 'response.function_call_arguments.done' || message?.type === 'response.output_item.done') {
      const call = toolCallFromMessage(message);
      if (call.name && call.callId) state.callNames.set(call.callId, call.name);
      if (call.name === 'record_contact_consent' && call.args?.agreed !== true) {
        return handleConsentRefusal(this, state, call);
      }
      if (call.name === 'record_contact_consent' && call.args?.agreed === true) {
        state.contactConsentRefusals = 0;
        state.memory.fieldAnswers.contactConsent = true;
        state.memory.stage = RECEPTIONIST_COMMANDS.stages.CONFIRMATION;
      }
      if (call.name === 'submit_estimate_lead') {
        if (!state.summaryConfirmed) {
          blockedSubmitOutput(this, state, call.callId);
          return false;
        }
        Object.assign(state.memory.fieldAnswers, call.args || {});
        state.memory.stage = RECEPTIONIST_COMMANDS.stages.SAVING;
      }
    }

    if (message?.type === 'response.audio_transcript.delta' || message?.type === 'response.output_audio_transcript.delta') {
      state.assistantTranscript += String(message.delta || '');
    }

    if (message?.type === 'response.audio_transcript.done' || message?.type === 'response.output_audio_transcript.done') {
      const transcript = clean(message.transcript) || clean(state.assistantTranscript);
      state.assistantTranscript = '';
      rememberAssistant(state.memory, transcript);
      const question = extractLastQuestion(transcript);
      const identified = identifyQuestion(question, state.businessName);
      if (identified) {
        state.memory.lastQuestionId = identified.id;
        state.memory.lastQuestionText = question;
        state.memory.currentField = identified.field;
        state.memory.stage = identified.stage;
        if (identified.id === 'estimate_offer') state.memory.estimateOfferCount += 1;
        if (identified.id === 'final_confirmation') {
          state.awaitingSummaryConfirmation = true;
          state.summaryConfirmed = false;
        }
      }
    }
  }

  return previousEmit.call(this, eventName, ...args);
};

console.log('[Conversation commands]', {
  enabled: true,
  behavior: 'injects structured call memory, captures combined schedule answers, retries consent once, cancels refused intake, enforces final confirmation, and adapts fixed hold acknowledgements',
});
