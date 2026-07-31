import {
  QUESTION_IDS,
  createCallMemory,
  decideReceptionistTurn,
  emptyLead,
} from './receptionist-brain.js';
import { createTranscriber, synthesizePcmu } from './openai-voice.js';

const REPEATABLE_QUESTION_IDS = new Set([
  'ask_estimate',
  'continue_estimate',
  'more_questions',
  'clarify',
]);

const BASE_QUESTIONS = Object.freeze({
  ask_estimate: 'Would you like to fill out an estimate request?',
  continue_estimate: 'Would you like to continue filling out your estimate request?',
  more_questions: (businessName) => `Do you have any more questions about ${businessName}?`,
  service: (runtime) => `What service would you like? We specialize in ${Object.keys(runtime.core.BUSINESS.services || {}).join(', ')}.`,
  name: 'What is your full name?',
  project_location: 'What is the full address for the project?',
  preferred_date_time: 'What is your preferred estimate date and time?',
  notes: 'Do you have any additional notes about this project?',
  contact_consent: (runtime) => runtime.core.contactConsentQuestion,
  confirm_summary: 'Does all of that sound right?',
  clarify: "I'm sorry, I didn't catch that. Could you repeat that?",
});

const RESTART_PATTERN = /\b(?:restart|start over|resubmit|do it again|fill (?:it|the form) out again)\b/i;
const SILENCE_REPEAT_MS = 5000;

function clean(value) {
  return String(value ?? '').trim();
}

function mergeUnique(left = [], right = []) {
  return [...new Set([...left, ...right].filter(Boolean))];
}

function questionIsLocked(memory, questionId) {
  if (!questionId || questionId === 'none') return false;
  if (REPEATABLE_QUESTION_IDS.has(questionId)) return false;
  return memory.completedQuestionIds.includes(questionId);
}

function recordAskedQuestion(memory, questionId) {
  if (!questionId || questionId === 'none') return;
  memory.currentQuestionId = questionId;
  memory.askedCounts[questionId] = Number(memory.askedCounts[questionId] || 0) + 1;
  if (['service', 'name', 'project_location', 'preferred_date_time', 'notes', 'contact_consent', 'confirm_summary'].includes(questionId)) {
    memory.estimateStarted = true;
  }
}

function baseQuestionFor(runtime, questionId) {
  const value = BASE_QUESTIONS[questionId];
  if (typeof value === 'function') return clean(value(runtime));
  return clean(value);
}

export function createVoicePipeline({ runtime, callerPhone, sendAudioFrame, clearAudio, saveLead, endCall, log = console }) {
  const state = {
    lead: emptyLead(),
    memory: createCallMemory(),
    history: [],
    speaking: false,
    stopped: false,
    generation: 0,
    audioTimer: null,
    queuedFrames: [],
    silenceTimer: null,
    greetingSent: false,
    closingStarted: false,
  };

  function remember(role, text) {
    const content = clean(text);
    if (!content) return;
    state.history.push({ role, content });
    if (state.history.length > 24) state.history.splice(0, state.history.length - 24);
  }

  function clearSilenceTimer() {
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }

  function scheduleBaseQuestionRepeat(questionId) {
    clearSilenceTimer();
    const baseQuestion = baseQuestionFor(runtime, questionId);
    if (!baseQuestion || state.stopped || state.closingStarted) return;
    state.silenceTimer = setTimeout(() => {
      state.silenceTimer = null;
      if (state.stopped || state.closingStarted || state.memory.currentQuestionId !== questionId) return;
      speak(baseQuestion, { scheduleRepeat: false }).catch((error) => log.error('[Question repeat failed]', error));
    }, SILENCE_REPEAT_MS);
  }

  function stopSpeaking() {
    state.generation += 1;
    state.speaking = false;
    state.queuedFrames = [];
    if (state.audioTimer) clearTimeout(state.audioTimer);
    state.audioTimer = null;
    clearAudio?.();
  }

  function pumpFrames(generation) {
    if (state.stopped || generation !== state.generation) return;
    const frame = state.queuedFrames.shift();
    if (!frame) {
      state.speaking = false;
      state.audioTimer = null;
      return;
    }
    sendAudioFrame(frame);
    state.audioTimer = setTimeout(() => pumpFrames(generation), 20);
  }

  async function speak(text, { scheduleRepeat = true } = {}) {
    const reply = clean(text);
    if (!reply || state.stopped) return;
    stopSpeaking();
    remember('assistant', reply);
    const generation = state.generation;
    const frames = await synthesizePcmu(reply);
    if (state.stopped || generation !== state.generation) return;
    state.queuedFrames = frames;
    state.speaking = true;
    pumpFrames(generation);
    if (scheduleRepeat) scheduleBaseQuestionRepeat(state.memory.currentQuestionId);
  }

  async function speakClosingAndEnd() {
    if (state.closingStarted || state.stopped) return;
    state.closingStarted = true;
    clearSilenceTimer();
    const closing = clean(runtime.core.closingLine);
    await speak(closing, { scheduleRepeat: false });
    const delay = Math.max(600, closing.length * 55);
    setTimeout(() => endCall?.('completed'), delay);
  }

  async function submitLeadSafely() {
    const validation = runtime.core.validateLead(state.lead);
    if (!validation.valid) {
      log.warn('[Brain requested invalid lead submission]', validation.errors);
      return { ok: false, invalid: true };
    }

    try {
      await saveLead({
        callerPhone,
        lead: validation.lead,
        payload: runtime.core.buildOcmPayload(callerPhone, validation.lead),
      });
      state.memory.leadSaved = true;
      state.memory.submissionFailed = false;
      return { ok: true };
    } catch (error) {
      state.memory.leadSaved = false;
      state.memory.submissionFailed = true;
      log.error('[Estimate submission failed]', error);
      return { ok: false, error };
    }
  }

  async function processTranscript(transcript) {
    const text = clean(transcript);
    if (!text || state.stopped || state.closingStarted) return;
    clearSilenceTimer();
    remember('caller', text);

    if (state.memory.estimateStarted && !state.memory.leadSaved && RESTART_PATTERN.test(text)) {
      await speak('You can update the estimate request information when I summarize it at the end.');
      return;
    }

    try {
      const turn = await decideReceptionistTurn({
        core: runtime.core,
        transcript: text,
        lead: state.lead,
        history: state.history,
        callMemory: state.memory,
      });

      state.lead = { ...state.lead, ...(turn.updatedLead || {}) };
      state.memory.completedQuestionIds = mergeUnique(
        state.memory.completedQuestionIds,
        turn.completedQuestionIds || [],
      );

      let spokenReply = clean(turn.spokenReply);
      let askedQuestionId = QUESTION_IDS.includes(turn.askedQuestionId) ? turn.askedQuestionId : 'none';

      if (state.memory.estimateStarted && !state.memory.completedQuestionIds.includes('service')) {
        askedQuestionId = 'service';
        spokenReply = baseQuestionFor(runtime, 'service');
      } else if (state.memory.estimateStarted && askedQuestionId !== 'service' && !state.lead.service) {
        askedQuestionId = 'service';
        spokenReply = baseQuestionFor(runtime, 'service');
      }

      if (questionIsLocked(state.memory, askedQuestionId)) {
        log.warn('[Blocked repeated completed question]', {
          askedQuestionId,
          askedCount: state.memory.askedCounts[askedQuestionId] || 0,
        });
        askedQuestionId = state.memory.leadSaved
          ? 'more_questions'
          : state.memory.estimateStarted
            ? 'continue_estimate'
            : 'ask_estimate';
        spokenReply = baseQuestionFor(runtime, askedQuestionId);
      }

      recordAskedQuestion(state.memory, askedQuestionId);

      if (turn.submitLead && !state.memory.leadSaved) {
        const submission = await submitLeadSafely();
        if (submission.ok) {
          spokenReply = `The request has been sent. ${runtime.core.BUSINESS.name} will follow up with you shortly. Do you have any questions about ${runtime.core.BUSINESS.name}?`;
          askedQuestionId = 'more_questions';
          recordAskedQuestion(state.memory, askedQuestionId);
        } else if (submission.invalid) {
          spokenReply = baseQuestionFor(runtime, 'clarify');
          askedQuestionId = 'clarify';
          recordAskedQuestion(state.memory, askedQuestionId);
        } else {
          spokenReply = `I'm sorry. Something went wrong and I couldn't send the request. Please call again within the next 24 hours. Do you have any questions about ${runtime.core.BUSINESS.name}?`;
          askedQuestionId = 'more_questions';
          recordAskedQuestion(state.memory, askedQuestionId);
        }
      }

      if (turn.endCall) {
        await speakClosingAndEnd();
        return;
      }

      await speak(spokenReply);
    } catch (error) {
      log.error('[Voice pipeline turn failed]', error);
      recordAskedQuestion(state.memory, 'clarify');
      await speak(baseQuestionFor(runtime, 'clarify'));
    }
  }

  const transcriber = createTranscriber({
    onSpeechStarted: () => {
      clearSilenceTimer();
      if (state.speaking) stopSpeaking();
    },
    onTranscript: (transcript) => {
      processTranscript(transcript).catch((error) => log.error('[Transcript processing failed]', error));
    },
    onError: (error) => log.error('[Transcriber failed]', error),
  });

  return {
    async start() {
      if (state.greetingSent || state.stopped) return;
      state.greetingSent = true;
      recordAskedQuestion(state.memory, 'ask_estimate');
      await speak(runtime.core.openingLine);
    },
    appendCallerAudio(base64Pcmu) {
      if (!state.stopped && !state.closingStarted) transcriber.append(base64Pcmu);
    },
    stop(reason = 'stopped') {
      state.stopped = true;
      clearSilenceTimer();
      stopSpeaking();
      transcriber.close();
      log.log('[Voice pipeline stopped]', reason);
    },
    snapshot() {
      return {
        lead: { ...state.lead },
        memory: {
          ...state.memory,
          askedCounts: { ...state.memory.askedCounts },
          completedQuestionIds: [...state.memory.completedQuestionIds],
        },
        history: [...state.history],
        speaking: state.speaking,
        greetingSent: state.greetingSent,
        closingStarted: state.closingStarted,
      };
    },
  };
}
