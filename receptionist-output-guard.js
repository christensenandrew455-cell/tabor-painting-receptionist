import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { cleanText } from './business-context.js';
import { createOpenAiReceptionist } from './openai-receptionist.js';

const OLD_SUBMISSION_START_RESPONSE = "I'm submitting your estimate request now.";
const SUBMISSION_START_RESPONSE = "Okay, thanks for confirming. I'm sending the estimate request in now.";
const SUBMISSION_FAILURE_RESPONSE = "I'm sorry, I can't send the estimate request.";
const OLD_NOTES_AND_QUESTIONS_PROMPT = "Do you have any notes for the project or any questions about the business? I may be able to answer some, and if not, I'll add them to the notes.";
const NOTES_AND_QUESTIONS_PROMPT = "Do you have any notes for the project or any questions about the business you'd like me to help with or pass along?";
const UNCLEAR_CALLER_RESPONSE = "I'm sorry, I didn't catch that.";
const MAX_REPAIR_ATTEMPTS = 3;

const CONDITIONAL_TRANSITION_PATTERNS = Object.freeze([
  /\b(?:one sec(?:ond)?|just a sec(?:ond)?|one moment|just a moment)\b/i,
  /\b(?:hold on|give me (?:a )?(?:sec(?:ond)?|moment))\b/i,
  /\blet(?:'s| us) (?:move on|keep (?:this|it) moving|keep going|continue)\b/i,
  /\bmove on to\b/i,
  /\b(?:let me|i(?:'|’)ll|we(?:'|’)ll) (?:get|grab|gather|collect|pull|bring|look|check|review|find|fetch)\b/i,
]);

const PROCESS_NARRATION_PATTERNS = Object.freeze([
  /\blet me think\b/i,
  /\bbest way to help\b/i,
  /\bnext (?:step|detail)\b/i,
  /\blet me (?:pull|update|refresh|clarify|check|double[- ]check|make sure|prepare|put together)\b/i,
  /\bi(?:'|’)ll (?:update|refresh|check|double[- ]check|pull|prepare|put together)\b/i,
  /\bquick recap\b/i,
  /\bget (?:the )?estimate summary ready\b/i,
  /\bi(?:'|’)m (?:still )?(?:getting|a bit )?confused\b/i,
  /\bpackage the estimate request\b/i,
  /\btake your time\b/i,
  /\bwhenever you(?:'re| are) ready\b/i,
  /\bno problem\b/i,
  /\byou(?:'re| are) fine\b/i,
  /\ball good\b/i,
]);

const STANDALONE_ACKNOWLEDGMENT = /^(?:okay|ok|great|got it|okay great|okay got it|sounds good|thanks|thank you)[.!]*$/i;

function normalized(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

function sameSpokenText(left, right) {
  return normalized(left) === normalized(right);
}

function spokenBusinessName(value) {
  return cleanText(value).replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || 'the business';
}

function trimSpeechPunctuation(value) {
  return cleanText(value).replace(/[.?!]+$/g, '').trim();
}

function hasConditionalTransition(value) {
  return CONDITIONAL_TRANSITION_PATTERNS.some((pattern) => pattern.test(value));
}

function transitionRemainder(value) {
  let remainder = cleanText(value);
  for (const pattern of CONDITIONAL_TRANSITION_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    remainder = remainder.replace(new RegExp(pattern.source, flags), ' ');
  }
  return cleanText(remainder.replace(/^[\s,.;:!—-]+|[\s,.;:!—-]+$/g, ' '));
}

function hasUsefulContinuationAfterTransition(value) {
  const remainder = transitionRemainder(value);
  if (!remainder) return false;
  return Boolean(classifyPendingField(remainder))
    || /\?\s*$/.test(remainder)
    || sameSpokenText(remainder, SUBMISSION_START_RESPONSE);
}

function asksForZipCode(value) {
  const text = cleanText(value);
  if (!/\bzip(?:\s+code)?\b/i.test(text)) return false;
  return /\b(?:what(?:'s| is)|need|provide|give|tell|share|confirm|enter|supply)\b[\s\S]{0,80}\bzip(?:\s+code)?\b/i.test(text)
    || /\bzip(?:\s+code)?\b[\s\S]{0,80}\?/i.test(text);
}

export function shouldBlockReceptionistOutput(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (sameSpokenText(text, SUBMISSION_START_RESPONSE)) return false;
  if (!/[A-Za-z0-9]/.test(text)) return true;
  if (STANDALONE_ACKNOWLEDGMENT.test(text)) return true;
  if (hasConditionalTransition(text) && !hasUsefulContinuationAfterTransition(text)) return true;
  if (PROCESS_NARRATION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (asksForZipCode(text)) return true;

  if (
    /complete project address/i.test(text)
    && /including\s+(?:street|address|city|state)/i.test(text)
  ) return true;

  return false;
}

export function callerTranscriptDisposition(value) {
  const text = cleanText(value);
  if (!text) return 'filler';
  if (!/[A-Za-z0-9]/.test(text)) return 'filler';

  const valueNormalized = normalized(text);
  if (!valueNormalized) return 'filler';
  if (/^(?:um+|uh+|erm+|er+|hmm+|hm+|mm+|mmm+|ah+|eh+|well|like|ay)$/.test(valueNormalized)) {
    return 'filler';
  }
  if (/\b(?:um+|uh+|erm+|er+)\s*$/.test(valueNormalized)) return 'filler';
  if (/^(?:a{2,}|e{2,}|o{2,})$/.test(valueNormalized)) return 'unclear';
  return 'meaningful';
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
  const text = normalized(value);
  return /^(?:no|nope|nah|none|nothing)\b/.test(text)
    || /\b(?:do not|don't|dont) have any\b/.test(text)
    || /\bno (?:notes|questions)\b/.test(text)
    || /\bnothing (?:else|to add)\b/.test(text);
}

function isClearAffirmative(value) {
  return /^(?:yes|yeah|yep|yup|correct|right|that(?:'s| is) right)\b/i.test(cleanText(value));
}

function looksLikeBusinessQuestion(value) {
  const text = cleanText(value);
  return /\?$/.test(text)
    || /^(?:what|when|where|why|how|do|does|can|could|is|are|will|would)\b/i.test(text);
}

function exactSpeechInstruction(text, extra = '') {
  return `Say exactly: ${JSON.stringify(text)} Do not add anything before or after it.${extra ? ` ${extra}` : ''}`;
}

export function buildPreparedSummarySpeech(summary = {}) {
  const name = trimSpeechPunctuation(summary.name);
  const service = trimSpeechPunctuation(summary.service);
  const address = trimSpeechPunctuation(summary.address);
  const preferredDateAndTime = trimSpeechPunctuation(summary.preferredDateAndTime);
  const notes = trimSpeechPunctuation(summary.notes);
  const notesSentence = !notes || /^none$/i.test(notes)
    ? 'There are no additional notes.'
    : `The notes are: ${notes}.`;

  return `Okay, here's the summary. ${name} is requesting ${service} at ${address}. The preferred date and time is ${preferredDateAndTime}. ${notesSentence} Does that all sound right?`;
}

function repairPlanForBlockedOutput({
  answeredField = '',
  callerTranscript = '',
  callerDisposition = 'meaningful',
  businessName = 'the business',
  notesResolvedNegative = false,
} = {}) {
  if (callerDisposition === 'filler') return { instructions: '', expectedTranscript: '' };
  if (callerDisposition === 'unclear') {
    return {
      instructions: exactSpeechInstruction(UNCLEAR_CALLER_RESPONSE),
      expectedTranscript: UNCLEAR_CALLER_RESPONSE,
    };
  }

  const business = spokenBusinessName(businessName);
  switch (answeredField) {
    case 'service': {
      const text = 'What name should I use for the estimate request?';
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'name': {
      const text = "What's the complete project address?";
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'address': {
      const text = 'What date and time would work best for the estimate?';
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'schedule':
      return {
        instructions: exactSpeechInstruction(NOTES_AND_QUESTIONS_PROMPT),
        expectedTranscript: NOTES_AND_QUESTIONS_PROMPT,
      };
    case 'notes':
      if (notesResolvedNegative || isClearNegative(callerTranscript)) {
        const text = `Okay, thanks. One more question. Do you consent to being contacted by ${business}?`;
        return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
      }
      if (!looksLikeBusinessQuestion(callerTranscript)) {
        const text = `Okay, thanks for the notes. One more question. Do you consent to being contacted by ${business}?`;
        return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
      }
      return {
        instructions: 'Answer only the caller\'s business question from the supplied business data, then ask only the single intake question that is still pending. Do not acknowledge, narrate, explain your process, or announce a next step.',
        expectedTranscript: '',
      };
    case 'consent':
      if (isClearAffirmative(callerTranscript)) {
        return {
          instructions: 'Call prepare_estimate_summary now using only details the caller already provided. Do not speak any preamble, acknowledgement, process narration, or transition before the tool call.',
          expectedTranscript: '',
        };
      }
      return {
        instructions: 'Respond only to the caller\'s contact-consent answer. Do not narrate your process or announce a next step.',
        expectedTranscript: '',
      };
    case 'summary':
      if (isClearAffirmative(callerTranscript)) {
        return {
          instructions: exactSpeechInstruction(
            SUBMISSION_START_RESPONSE,
            'Then immediately call submit_estimate_request with caller_confirmed true.',
          ),
          expectedTranscript: SUBMISSION_START_RESPONSE,
        };
      }
      return {
        instructions: 'Ask only for the specific detail the caller corrected or said was wrong. Do not recap, narrate your process, or announce that you are updating anything.',
        expectedTranscript: '',
      };
    default:
      return {
        instructions: 'Respond with only the single next required question or answer. Do not use a standalone acknowledgement, process narration, reassurance, recap, or transition sentence.',
        expectedTranscript: '',
      };
  }
}

export function repairInstructionForBlockedOutput(options = {}) {
  return repairPlanForBlockedOutput(options).instructions;
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

function hasFunctionCall(response = {}, name = '') {
  return (response.output || []).some(
    (item) => item?.type === 'function_call' && cleanText(item.name) === name,
  );
}

function replaceStringEverywhere(value, replacements) {
  if (typeof value === 'string') {
    return replacements.reduce(
      (current, [from, to]) => current.split(from).join(to),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => replaceStringEverywhere(item, replacements));
  if (!value || typeof value !== 'object') return value;
  for (const [key, child] of Object.entries(value)) {
    value[key] = replaceStringEverywhere(child, replacements);
  }
  return value;
}

function hardenSessionUpdate(event) {
  replaceStringEverywhere(event.session, [
    [OLD_SUBMISSION_START_RESPONSE, SUBMISSION_START_RESPONSE],
    [OLD_NOTES_AND_QUESTIONS_PROMPT, NOTES_AND_QUESTIONS_PROMPT],
  ]);

  if (typeof event.session?.instructions === 'string') {
    const oldAcknowledgmentRule = 'Light acknowledgments such as "Okay," "Great," "Got it," "Okay, great," or "Sounds good" are encouraged and may naturally begin many questions or answers. Do not force one onto every turn, and vary them so the conversation does not sound repetitive.';
    const hardAcknowledgmentRule = 'Natural acknowledgements are fine only when they are attached to a useful answer or question. Never send a standalone filler acknowledgement during intake.';

    event.session.instructions = event.session.instructions
      .replace(oldAcknowledgmentRule, hardAcknowledgmentRule)
      + `\nHARD OUTPUT RULE: Never end a turn with process-only narration. Any brief transition such as "one sec", "let's keep moving", "let me get the details", or a natural variation is allowed only when the same spoken response immediately continues with the actual next question or spoken action. Never stop after the transition. Still never say "let me think", "best way to help", "next step", "let me update", "let me clarify", or "quick recap".`
      + `\nUNCLEAR AUDIO RULE: A hesitation such as "uh" or "um" gets silence. If the transcription is clearly unintelligible rather than a hesitation, say exactly: "${UNCLEAR_CALLER_RESPONSE}"`
      + `\nFINAL SUMMARY RULE: Begin with "Okay, here's the summary." State the name, service, address, preferred date and time, and notes exactly once. If there are no notes, say "There are no additional notes." Never say "Note: None" and never repeat the summary.`
      + `\nPRE-SUBMISSION RULE: After the caller confirms the final summary, the required sentence before the submit tool is exactly: "${SUBMISSION_START_RESPONSE}"`;
  }

  return event;
}

function prepareOutgoingEvent(event, pendingSummary) {
  if (!event || typeof event !== 'object') return { event, policy: null };

  if (event.type === 'session.update') {
    return { event: hardenSessionUpdate(event), policy: null };
  }

  replaceStringEverywhere(event, [
    [OLD_SUBMISSION_START_RESPONSE, SUBMISSION_START_RESPONSE],
    [OLD_NOTES_AND_QUESTIONS_PROMPT, NOTES_AND_QUESTIONS_PROMPT],
  ]);

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

  if (
    event.type === 'response.create'
    && typeof event.response?.instructions === 'string'
    && /Use only the returned summary values:/i.test(event.response.instructions)
    && pendingSummary
  ) {
    const speech = buildPreparedSummarySpeech(pendingSummary);
    event.response.instructions = exactSpeechInstruction(speech);
    return {
      event,
      policy: {
        expectedTranscript: speech,
        repairInstruction: exactSpeechInstruction(speech),
      },
    };
  }

  return { event, policy: null };
}

function parseFunctionOutput(event) {
  if (
    event?.type !== 'conversation.item.create'
    || event.item?.type !== 'function_call_output'
  ) return null;
  try {
    return JSON.parse(String(event.item.output || '{}'));
  } catch {
    return null;
  }
}

function createGuardedWebSocketClass({
  context,
  InnerWebSocketClass,
  onClear,
}) {
  const businessName = spokenBusinessName(context?.businessName);

  return class GuardedRealtimeWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.inner = new InnerWebSocketClass(url, options);
      this.responses = new Map();
      this.pendingIntakeField = '';
      this.lastAnsweredField = '';
      this.lastAnsweredTranscript = '';
      this.latestCallerTranscript = '';
      this.latestCallerDisposition = 'none';
      this.notesResolvedNegative = false;
      this.pendingSummary = null;
      this.pendingResponsePolicies = [];
      this.repairAttempts = 0;
      this.submitCallIds = new Set();
      this.failedSubmitFollowupPending = false;

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

      const toolOutput = parseFunctionOutput(event);
      if (toolOutput?.status === 'ready_for_confirmation' && toolOutput.summary) {
        this.pendingSummary = toolOutput.summary;
      }
      if (
        event.type === 'conversation.item.create'
        && event.item?.type === 'function_call_output'
        && this.submitCallIds.has(cleanText(event.item.call_id))
      ) {
        this.submitCallIds.delete(cleanText(event.item.call_id));
        if (toolOutput?.ok === false) this.failedSubmitFollowupPending = true;
      }

      const failedSubmitFollowup = event.type === 'response.create' && this.failedSubmitFollowupPending;
      if (failedSubmitFollowup) {
        this.failedSubmitFollowupPending = false;
        event.response.instructions = exactSpeechInstruction(SUBMISSION_FAILURE_RESPONSE);
      }

      const prepared = prepareOutgoingEvent(event, this.pendingSummary);
      if (failedSubmitFollowup) {
        prepared.policy = {
          expectedTranscript: SUBMISSION_FAILURE_RESPONSE,
          repairInstruction: exactSpeechInstruction(SUBMISSION_FAILURE_RESPONSE),
        };
      }
      if (prepared.policy) this.pendingResponsePolicies.push(prepared.policy);
      return this.inner.send(JSON.stringify(prepared.event));
    }

    close(...args) {
      return this.inner.close(...args);
    }

    responseState(responseId) {
      const id = cleanText(responseId);
      if (!this.responses.has(id)) {
        this.responses.set(id, {
          id,
          createdEvent: null,
          createdForwarded: false,
          audioEvents: [],
          transcriptEvents: [],
          transcript: '',
          transcriptForwarded: false,
          approved: false,
          blocked: false,
          interrupted: false,
          itemIds: new Set(),
          callerDisposition: this.latestCallerDisposition,
          callerTranscript: this.latestCallerTranscript,
          answeredField: this.lastAnsweredField,
          notesResolvedNegative: this.notesResolvedNegative,
          policy: null,
        });
      }
      return this.responses.get(id);
    }

    emitJson(event) {
      this.emit('message', Buffer.from(JSON.stringify(event)));
    }

    forwardCreated(state) {
      if (!state.createdEvent || state.createdForwarded) return;
      this.emitJson(state.createdEvent);
      state.createdForwarded = true;
    }

    markBlocked(state) {
      state.blocked = true;
      state.audioEvents.length = 0;
      state.transcriptEvents.length = 0;
    }

    shouldRequireSubmissionStart(state) {
      return state.answeredField === 'summary'
        && isClearAffirmative(state.callerTranscript);
    }

    approveResponse(state, transcript, transcriptDoneEvent = null) {
      if (state.blocked || state.interrupted) return false;
      const spoken = cleanText(transcript);

      if (state.policy?.expectedTranscript && !sameSpokenText(spoken, state.policy.expectedTranscript)) {
        this.markBlocked(state);
        return false;
      }

      if (!state.policy && state.callerDisposition === 'filler') {
        this.markBlocked(state);
        return false;
      }

      if (!state.policy && state.callerDisposition === 'unclear') {
        this.markBlocked(state);
        return false;
      }

      if (
        state.answeredField === 'schedule'
        && classifyPendingField(spoken) === 'notes'
        && !sameSpokenText(spoken, NOTES_AND_QUESTIONS_PROMPT)
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        sameSpokenText(spoken, SUBMISSION_START_RESPONSE)
        && !this.shouldRequireSubmissionStart(state)
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        this.shouldRequireSubmissionStart(state)
        && !sameSpokenText(spoken, SUBMISSION_START_RESPONSE)
      ) {
        this.markBlocked(state);
        return false;
      }

      if (shouldBlockReceptionistOutput(spoken)) {
        this.markBlocked(state);
        return false;
      }

      state.approved = true;
      state.transcript = spoken;
      this.forwardCreated(state);
      for (const event of state.audioEvents.splice(0)) this.emitJson(event);
      for (const event of state.transcriptEvents.splice(0)) this.emitJson(event);
      if (transcriptDoneEvent && !state.transcriptForwarded) {
        this.emitJson(transcriptDoneEvent);
        state.transcriptForwarded = true;
      }

      const pending = classifyPendingField(spoken);
      if (pending) {
        this.pendingIntakeField = pending;
        if (pending === 'consent') this.notesResolvedNegative = false;
      }
      this.repairAttempts = 0;
      return true;
    }

    sendRepair(plan) {
      if (!plan?.instructions || this.repairAttempts >= MAX_REPAIR_ATTEMPTS) return;
      this.repairAttempts += 1;
      this.pendingResponsePolicies.push({
        expectedTranscript: plan.expectedTranscript || '',
        repairInstruction: plan.instructions,
      });
      this.inner.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: plan.instructions,
        },
      }));
    }

    discardResponse(event, state, { repair = true } = {}) {
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

      if (!repair || state.interrupted) return;

      if (state.policy?.repairInstruction) {
        this.sendRepair({
          instructions: state.policy.repairInstruction,
          expectedTranscript: state.policy.expectedTranscript || '',
        });
        return;
      }

      const plan = repairPlanForBlockedOutput({
        answeredField: state.answeredField,
        callerTranscript: state.callerTranscript,
        callerDisposition: state.callerDisposition,
        businessName,
        notesResolvedNegative: state.notesResolvedNegative,
      });
      this.sendRepair(plan);
    }

    updateActiveResponseCallerContext({
      disposition,
      transcript,
      answeredField,
      notesResolvedNegative,
    }) {
      for (const state of this.responses.values()) {
        if (state.approved || state.interrupted) continue;
        state.callerDisposition = disposition;
        state.callerTranscript = transcript;
        state.answeredField = answeredField;
        state.notesResolvedNegative = notesResolvedNegative;
      }
    }

    handleIncoming(raw) {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        this.emit('message', raw);
        return;
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        onClear?.();
        for (const state of this.responses.values()) {
          if (state.interrupted) continue;
          state.interrupted = true;
          state.audioEvents.length = 0;
          state.transcriptEvents.length = 0;
        }
        this.emitJson(event);
        return;
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const callerTranscript = cleanText(event.transcript);
        const disposition = callerTranscriptDisposition(callerTranscript);
        this.latestCallerTranscript = callerTranscript;
        this.latestCallerDisposition = disposition;

        let answeredField = this.pendingIntakeField;
        if (disposition === 'meaningful' && this.pendingIntakeField) {
          if (
            this.pendingIntakeField === 'notes'
            && this.notesResolvedNegative
            && !isClearNegative(callerTranscript)
            && !/^(?:actually|wait|hold on)\b/i.test(callerTranscript)
          ) {
            answeredField = 'notes';
          } else {
            this.lastAnsweredField = this.pendingIntakeField;
            this.lastAnsweredTranscript = callerTranscript;
            answeredField = this.lastAnsweredField;
          }

          if (this.pendingIntakeField === 'notes' && isClearNegative(callerTranscript)) {
            this.notesResolvedNegative = true;
          }
        }

        this.updateActiveResponseCallerContext({
          disposition,
          transcript: disposition === 'meaningful'
            ? (this.lastAnsweredTranscript || callerTranscript)
            : callerTranscript,
          answeredField,
          notesResolvedNegative: this.notesResolvedNegative,
        });

        this.emitJson(event);
        return;
      }

      if (event.type === 'response.created') {
        const state = this.responseState(event.response?.id);
        state.createdEvent = event;
        if (this.pendingResponsePolicies.length) {
          state.policy = this.pendingResponsePolicies.shift();
        }
        return;
      }

      if (event.type === 'response.output_audio.delta' && event.delta) {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        if (state.blocked || state.interrupted) return;
        if (state.approved) this.emitJson(event);
        else state.audioEvents.push(event);
        return;
      }

      if (event.type === 'response.output_audio_transcript.delta') {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        state.transcript += String(event.delta || '');
        if (state.blocked || state.interrupted) return;
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

        if (state.interrupted) {
          this.discardResponse(event, state, { repair: false });
          this.responses.delete(responseId);
          return;
        }

        if (!state.transcript) state.transcript = extractResponseTranscript(event.response);
        if (!state.approved && !state.blocked && state.transcript) {
          this.approveResponse(state, state.transcript);
        }

        if (hasFunctionCall(event.response, 'submit_estimate_request')) {
          if (!this.shouldRequireSubmissionStart(state) || !state.approved) {
            this.markBlocked(state);
          }
        }

        if (state.blocked) {
          this.discardResponse(event, state, { repair: true });
          this.responses.delete(responseId);
          return;
        }

        for (const item of event.response?.output || []) {
          if (
            item?.type === 'function_call'
            && cleanText(item.name) === 'submit_estimate_request'
            && cleanText(item.call_id)
          ) {
            this.submitCallIds.add(cleanText(item.call_id));
          }
        }

        this.forwardCreated(state);
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
    onClear,
  } = options;
  const GuardedWebSocketClass = createGuardedWebSocketClass({
    context,
    InnerWebSocketClass,
    onClear,
  });
  return createOpenAiReceptionist({
    ...options,
    WebSocketClass: GuardedWebSocketClass,
  });
}
