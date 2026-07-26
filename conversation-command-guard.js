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
      pendingHoldAcknowledgement: '',
      cancellationPending: false,
      pendingSaveSuccess: false,
      awaitingSummaryConfirmation: false,
      summaryConfirmed: false,
      assistantTranscript: '',
      callNames: new Map(),
      blockedCallIds: new Set(),
    });
  }
  return socketStates.get(socket);
}

function businessNameFromInstructions(value) {
  const match = clean(value).match(/^- Business name:\s*(.+)$/im);
  return clean(match?.[1]) || 'the business';
}

function extractLastQuestion(value) {
  const questions = clean(value).match(/[^.!?]*\?/g) || [];
  return clean(questions.at(-1));
}

function identifyQuestion(question, businessName) {
  const normalized = clean(question).toLowerCase();
  if (!normalized) return null;
  if (/would you like me to help you submit an estimate request/.test(normalized)) {
    return { id: 'estimate_offer', field: '', stage: RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE };
  }
  if (/first and last name/.test(normalized)) return { id: 'full_name', field: 'fullName', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
  if (/what service/.test(normalized)) return { id: 'service_type', field: 'serviceType', stage: RECEPTIONIST_COMMANDS.stages.INTAKE };
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

WebSocket.prototype.send = function conversationCommandSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return previousSend.call(this, data, ...args);
  const message = parseJson(data);
  if (!message) return previousSend.call(this, data, ...args);
  const state = stateFor(this);

  if (message.type === 'session.update') {
    state.businessName = businessNameFromInstructions(message?.session?.instructions);
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
        state.cancellationPending = true;
        state.awaitingSummaryConfirmation = false;
        state.summaryConfirmed = false;
      } else {
        if (state.awaitingSummaryConfirmation && isAffirmative(transcript)) {
          state.summaryConfirmed = true;
          state.awaitingSummaryConfirmation = false;
        }
        if (state.memory.currentField && !looksLikeQuestion(transcript)) {
          state.memory.fieldAnswers[state.memory.currentField] = transcript;
        }
      }
    }

    if (message?.type === 'response.function_call_arguments.done' || message?.type === 'response.output_item.done') {
      const call = toolCallFromMessage(message);
      if (call.name && call.callId) state.callNames.set(call.callId, call.name);
      if (call.name === 'submit_estimate_lead') {
        if (!state.summaryConfirmed) {
          blockedSubmitOutput(this, state, call.callId);
          return false;
        }
        Object.assign(state.memory.fieldAnswers, call.args || {});
        state.memory.stage = RECEPTIONIST_COMMANDS.stages.SAVING;
      }
      if (call.name === 'record_contact_consent' && call.args?.agreed === true) {
        state.memory.fieldAnswers.contactConsent = true;
        state.memory.stage = RECEPTIONIST_COMMANDS.stages.CONFIRMATION;
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
  behavior: 'injects structured call memory, resets cancelled intake, enforces final confirmation, and adapts fixed hold acknowledgements',
});
