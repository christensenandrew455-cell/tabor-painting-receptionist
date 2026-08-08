import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { cleanText } from './business-context.js';
import { createOpenAiReceptionist } from './openai-receptionist.js';

const SUBMISSION_START_RESPONSE = "I'm submitting your estimate request now.";
const NOTES_AND_QUESTIONS_PROMPT = "Do you have any notes for the project or any questions about the business? I may be able to answer some, and if not, I'll add them to the notes.";
const MAX_REPAIR_ATTEMPTS = 3;

const PROCESS_NARRATION_PATTERNS = Object.freeze([
  /\blet me think\b/i,
  /\bbest way to help\b/i,
  /\blet(?:'s| us) move on\b/i,
  /\bmove on to\b/i,
  /\bnext (?:step|detail)\b/i,
  /\blet me (?:pull|update|refresh|clarify|check|double[- ]check|make sure|grab|prepare|put together)\b/i,
  /\bi(?:'|’)ll (?:grab|update|refresh|check|double[- ]check|pull|prepare|put together)\b/i,
  /\bquick recap\b/i,
  /\bget (?:the )?estimate summary ready\b/i,
  /\bi(?:'|’)m (?:still )?(?:getting|a bit )?confused\b/i,
  /\bpackage the estimate request\b/i,
]);

const STANDALONE_ACKNOWLEDGMENT = /^(?:okay|ok|great|got it|okay great|okay got it|sounds good|thanks|thank you)[.!]*$/i;

function normalized(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

function spokenBusinessName(value) {
  return cleanText(value).replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || 'the business';
}

export function shouldBlockReceptionistOutput(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (normalized(text) === normalized(SUBMISSION_START_RESPONSE)) return false;
  if (STANDALONE_ACKNOWLEDGMENT.test(text)) return true;
  if (PROCESS_NARRATION_PATTERNS.some((pattern) => pattern.test(text))) return true;

  if (
    /complete project address/i.test(text)
    && (\bzip\b/i.test(text) || /including\s+(?:street|address|city|state)/i.test(text))
  ) return true;

  return false;
}

function isMeaningfulCallerTranscript(value) {
  const text = cleanText(value);
  if (!text || !/[A-Za-z0-9]/.test(text)) return false;
  const valueNormalized = normalized(text).replace(/[.]+$/g, '').trim();
  if (!valueNormalized) return false;
  if (/^(?:um+|uh+|erm+|er+|hmm+|hm+|mm+|mmm+|ah+|eh+|well|like|ay)$/.test(valueNormalized)) {
    return false;
  }
  return !/\b(?:um+|uh+|erm+|er+)\s*$/.test(valueNormalized);
}

function classifyPendingField(value) {
  const text = normalized(value);
  if (/\bwhat service were you looking for\b/.test(text)) return 'service';
  if (/\bwhat name should i use for the estimate request\b/.test(text)) return 'name';
  if (/\bwhat'?s the complete project address\b/.test(text)) return 'address';
  if (/\bwhat date and time would work best for the estimate\b/.test(text)) return 'schedule';
  if (/\bdo you have any notes for the project or any questions about the business\b/.test(text)) return 'notes';
  if (/\bdo you consent to being contacted by\b/.test(text)) return 'consent';
  if (/\bdoes that all sound right\b/.test(text)) return 'summary';
  return '';
}

function isClearNegative(value) {
  return /^(?:no|nope|nah|none|nothing|no notes|no questions|nothing else)\b/i.test(cleanText(value));
}

function isClearAffirmative(value) {
  return /^(?:yes|yeah|yep|yup|correct|right|that(?:'s| is) right)\b/i.test(cleanText(value));
}

function looksLikeBusinessQuestion(value) {
  const text = cleanText(value);
  return /\?$/.test(text)
    || /^(?:what|when|where|why|how|do|does|can|could|is|are|will|would)\b/i.test(text);
}

export function repairInstructionForBlockedOutput({
  answeredField = '',
  callerTranscript = '',
  businessName = 'the business',
} = {}) {
  const business = spokenBusinessName(businessName);
  switch (answeredField) {
    case 'service':
      return 'Say exactly: "What name should I use for the estimate request?" Do not add anything before or after it.';
    case 'name':
      return 'Say exactly: "What\'s the complete project address?" Do not add anything before or after it.';
    case 'address':
      return 'Say exactly: "What date and time would work best for the estimate?" Do not add anything before or after it.';
    case 'schedule':
      return `Say exactly: "${NOTES_AND_QUESTIONS_PROMPT}" Do not add anything before or after it.`;
    case 'notes':
      if (isClearNegative(callerTranscript)) {
        return `Say exactly: "Okay, thanks. One more question. Do you consent to being contacted by ${business}?" Do not add anything before or after it.`;
      }
      if (!looksLikeBusinessQuestion(callerTranscript)) {
        return `Say exactly: "Okay, thanks for the notes. One more question. Do you consent to being contacted by ${business}?" Do not add anything before or after it.`;
      }
      return 'Answer only the caller\'s business question from the supplied business data, then ask only the single intake question that is still pending. Do not acknowledge, narrate, explain your process, or announce a next step.';
    case 'consent':
      if (isClearAffirmative(callerTranscript)) {
        return 'Call prepare_estimate_summary now using only details the caller already provided. Do not speak any preamble, acknowledgement, process narration, or transition before the tool call.';
      }
      return 'Respond only to the caller\'s contact-consent answer. Do not narrate your process or announce a next step.';
    case 'summary':
      if (isClearAffirmative(callerTranscript)) {
        return `Say exactly: "${SUBMISSION_START_RESPONSE}" Then immediately call submit_estimate_request with caller_confirmed true. Do not add anything before or after the required sentence.`;
      }
      return 'Ask only for the specific detail the caller corrected or said was wrong. Do not recap, narrate your process, or announce that you are updating anything.';
    default:
      return 'Respond with only the single next required question or answer. Do not use a standalone acknowledgement, process narration, reassurance, recap, or transition sentence.';
  }
}

function extractResponseTranscript(response = {}) {
  const parts = [];
  for (const item of response.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.transcript) parts.push(String(content.transcript));
    }
  }
  return cleanText(parts.join(' '));
}

function outputItemIds(response = {}) {
  return (response.output || [])
    .map((item) => cleanText(item?.id))
    .filter(Boolean);
}

function hardenOutgoingEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.type === 'session.update' && typeof event.session?.instructions === 'string') {
    const oldAcknowledgmentRule = 'Light acknowledgments such as "Okay," "Great," "Got it," "Okay, great," or "Sounds good" are encouraged and may naturally begin many questions or answers. Do not force one onto every turn, and vary them so the conversation does not sound repetitive.';
    const hardAcknowledgmentRule = 'During estimate intake, never use a standalone acknowledgement. After a caller clearly answers a field, either ask the next required question directly or perform the required tool action. Do not say "Okay," "Got it," "Great," or similar filler unless it is part of an exact required sentence such as the contact-consent wording.';
    event.session.instructions = event.session.instructions
      .replace(oldAcknowledgmentRule, hardAcknowledgmentRule)
      + '\nHARD OUTPUT RULE: Process narration is prohibited. Never say "let me think", "best way to help", "let\'s move on", "next step", "let me update", "let me clarify", "quick recap", or any similar statement. Ask the next required question directly.';
  }

  if (
    event.type === 'response.create'
    && typeof event.response?.instructions === 'string'
    && /^Explain this problem briefly and ask only for what is needed to correct it:/i.test(event.response.instructions)
  ) {
    event.response.instructions = event.response.instructions.replace(
      /^Explain this problem briefly and ask only for what is needed to correct it:/i,
      'Ask only for what is needed to correct this. Do not explain internal validation, reasoning, workflow, or process:',
    );
  }
  return event;
}

function createGuardedWebSocketClass({ context, InnerWebSocketClass }) {
  const businessName = spokenBusinessName(context?.businessName);

  return class GuardedRealtimeWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.inner = new InnerWebSocketClass(url, options);
      this.responses = new Map();
      this.pendingIntakeField = '';
      this.lastAnsweredField = '';
      this.latestCallerTranscript = '';
      this.repairAttempts = 0;

      this.inner.on('open', (...args) => this.emit('open', ...args));
      this.inner.on('error', (...args) => this.emit('error', ...args));
      this.inner.on('close', (...args) => this.emit('close', ...args));
      this.inner.on('message', (raw) => this.handleIncoming(raw));
    }

    get readyState() {
      return this.inner.readyState;
    }

    send(value) {
      let event;
      try {
        event = JSON.parse(String(value));
      } catch {
        return this.inner.send(value);
      }
      return this.inner.send(JSON.stringify(hardenOutgoingEvent(event)));
    }

    close(...args) {
      return this.inner.close(...args);
    }

    responseState(responseId) {
      const id = cleanText(responseId);
      if (!this.responses.has(id)) {
        this.responses.set(id, {
          id,
          audioEvents: [],
          transcriptEvents: [],
          transcript: '',
          transcriptForwarded: false,
          approved: false,
          blocked: false,
          itemIds: new Set(),
        });
      }
      return this.responses.get(id);
    }

    emitJson(event) {
      this.emit('message', Buffer.from(JSON.stringify(event)));
    }

    approveResponse(state, transcript, transcriptDoneEvent = null) {
      if (state.blocked) return false;
      const spoken = cleanText(transcript);
      if (shouldBlockReceptionistOutput(spoken)) {
        state.blocked = true;
        state.audioEvents.length = 0;
        state.transcriptEvents.length = 0;
        return false;
      }

      state.approved = true;
      state.transcript = spoken;
      for (const event of state.audioEvents.splice(0)) this.emitJson(event);
      for (const event of state.transcriptEvents.splice(0)) this.emitJson(event);
      if (transcriptDoneEvent && !state.transcriptForwarded) {
        this.emitJson(transcriptDoneEvent);
        state.transcriptForwarded = true;
      }
      const pending = classifyPendingField(spoken);
      if (pending) this.pendingIntakeField = pending;
      this.repairAttempts = 0;
      return true;
    }

    blockAndRepair(event, state) {
      const response = event.response || {};
      for (const id of outputItemIds(response)) state.itemIds.add(id);

      this.emitJson({
        ...event,
        response: {
          ...response,
          output: [],
        },
      });

      for (const itemId of state.itemIds) {
        this.inner.send(JSON.stringify({
          type: 'conversation.item.delete',
          item_id: itemId,
        }));
      }

      if (this.repairAttempts >= MAX_REPAIR_ATTEMPTS) return;
      this.repairAttempts += 1;
      const instructions = repairInstructionForBlockedOutput({
        answeredField: this.lastAnsweredField,
        callerTranscript: this.latestCallerTranscript,
        businessName,
      });
      this.inner.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions,
        },
      }));
    }

    handleIncoming(raw) {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        this.emit('message', raw);
        return;
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const callerTranscript = cleanText(event.transcript);
        this.latestCallerTranscript = callerTranscript;
        if (isMeaningfulCallerTranscript(callerTranscript) && this.pendingIntakeField) {
          this.lastAnsweredField = this.pendingIntakeField;
        }
        this.emitJson(event);
        return;
      }

      if (event.type === 'response.created') {
        this.responseState(event.response?.id);
        this.emitJson(event);
        return;
      }

      if (event.type === 'response.output_audio.delta' && event.delta) {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        if (state.blocked) return;
        if (state.approved) this.emitJson(event);
        else state.audioEvents.push(event);
        return;
      }

      if (event.type === 'response.output_audio_transcript.delta') {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        state.transcript += String(event.delta || '');
        if (state.blocked) return;
        if (state.approved) this.emitJson(event);
        else state.transcriptEvents.push(event);
        return;
      }

      if (event.type === 'response.output_audio_transcript.done') {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        const transcript = cleanText(event.transcript || state.transcript);
        state.transcript = transcript;
        this.approveResponse(state, transcript, event);
        return;
      }

      if (event.type === 'response.done') {
        const responseId = cleanText(event.response?.id);
        const state = this.responseState(responseId);
        for (const id of outputItemIds(event.response)) state.itemIds.add(id);

        if (!state.transcript) state.transcript = extractResponseTranscript(event.response);
        if (!state.approved && !state.blocked && state.transcript) {
          this.approveResponse(state, state.transcript);
        }

        if (state.blocked) {
          this.blockAndRepair(event, state);
          this.responses.delete(responseId);
          return;
        }

        if (!state.approved) {
          for (const audioEvent of state.audioEvents.splice(0)) this.emitJson(audioEvent);
          for (const transcriptEvent of state.transcriptEvents.splice(0)) this.emitJson(transcriptEvent);
        }
        this.emitJson(event);
        this.responses.delete(responseId);
        return;
      }

      this.emitJson(event);
    }
  };
}

export function createGuardedOpenAiReceptionist(options = {}) {
  const {
    WebSocketClass: InnerWebSocketClass = WebSocket,
    context = {},
  } = options;
  const GuardedWebSocketClass = createGuardedWebSocketClass({
    context,
    InnerWebSocketClass,
  });
  return createOpenAiReceptionist({
    ...options,
    WebSocketClass: GuardedWebSocketClass,
  });
}
