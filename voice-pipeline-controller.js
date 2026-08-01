import { createRealtimeVoice } from './openai-voice.js';
import {
  ESTIMATE_ORDER,
  baseQuestionFor,
  captureDeterministicLead,
  changedLeadFields,
  controlSpeechReply,
  isControlSpeech,
  isObviouslyIncompleteTranscript,
  markDeterministicCompletions,
  mergeCallerFragment,
  nextRequiredQuestion,
  removeCompletion,
  repeatQuestionFor,
  shouldKeepHoldingFragment,
  validationLeadFromModular,
  validationQuestion,
} from './modular-intake-logic.js';
import { PHRASE_KEYS, receptionistPhrase } from './receptionist-phrases.js';

const QUESTION_IDS = Object.freeze([
  'none', 'ask_estimate', 'continue_estimate', 'more_questions', 'service', 'name',
  'project_location', 'preferred_date_time', 'notes', 'contact_consent',
  'confirm_summary', 'clarify',
]);
const ESTIMATE_QUESTION_IDS = new Set(ESTIMATE_ORDER);
const SILENCE_REPEAT_MS = 5000;
const RESTART_PATTERN = /\b(?:restart|start over|resubmit|do it again|fill (?:it|the form) out again)\b/i;
const IDENTITY_PATTERN = /\b(?:are you|is this)\s+(?:an?\s+)?(?:ai|bot|robot|human|person|real person)\b/i;
const WHY_PATTERN = /\b(?:why|what do you need that for|why do you need|what is that for)\b/i;
const OFF_TOPIC_PATTERN = /\b(?:pizza|taxi|uber|weather|sports|politics|medical|lawyer|police|fire department)\b/i;
const SIMPLE_YES = /^(?:yes|yeah|yep|ya|yah|sure|okay|ok|correct|right|sounds good|that's right|that is right)[.!?\s]*$/i;
const SIMPLE_NO = /^(?:no|nope|nah|ne|not really|nothing else|no more questions?|that's all|that is all|i'm all set|im all set)[.!?\s]*$/i;
const SUMMARY_CORRECTION_PATTERN = /\b(?:but|except|actually|correction|wrong|not correct|isn't right|is not right|change|update)\b/i;
const NO_NOTES_PATTERN = /^(?:no|nope|nah|ne)[.!?\s]*$|\b(?:no additional notes?|no notes?|do not have any notes?|don't have any notes?|nothing else|none|didn't give you any additional notes|did not give you any additional notes)\b/i;
const QUESTION_LIKE_PATTERN = /\?\s*$|^(?:what|why|how|when|where|who|now|hello|huh|sorry)\b/i;
const NEGATIVE_SERVICE_DETAIL_PATTERN = /\b(?:peeling|looks bad|really bad|rough|damaged|rotting|chipping|cracking|faded)\b/i;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isSpeechCancellation(error) {
  return /speech cancel(?:led|ed)|realtime speech cancelled/i.test(error?.message || String(error));
}

function emptyLead() {
  return {
    name: null,
    service: null,
    projectLocation: null,
    preferredDate: null,
    preferredTime: null,
    notes: null,
    contactConsent: null,
  };
}

function createCallMemory() {
  return {
    currentQuestionId: 'none',
    askedCounts: Object.fromEntries(QUESTION_IDS.map((id) => [id, 0])),
    completedQuestionIds: [],
    estimateStarted: false,
    leadSaved: false,
    submissionFailed: false,
  };
}

function mergeUnique(left = [], right = []) {
  return [...new Set([...left, ...right].filter(Boolean))];
}

function recordAskedQuestion(memory, questionId) {
  if (!questionId || questionId === 'none') return;
  memory.currentQuestionId = questionId;
  memory.askedCounts[questionId] = Number(memory.askedCounts[questionId] || 0) + 1;
  if (ESTIMATE_QUESTION_IDS.has(questionId)) memory.estimateStarted = true;
}

function validationPhraseKey(questionId) {
  return {
    name: PHRASE_KEYS.VALIDATION_NAME,
    service: PHRASE_KEYS.VALIDATION_SERVICE,
    project_location: PHRASE_KEYS.PROJECT_ADDRESS_FULL,
    preferred_date_time: PHRASE_KEYS.VALIDATION_ESTIMATE_DATE_TIME,
    contact_consent: PHRASE_KEYS.VALIDATION_CONTACT_CONSENT,
  }[questionId] || null;
}

function whyPhraseKey(questionId) {
  return {
    service: PHRASE_KEYS.WHY_SERVICE,
    name: PHRASE_KEYS.WHY_NAME,
    project_location: PHRASE_KEYS.WHY_PROJECT_ADDRESS,
    preferred_date_time: PHRASE_KEYS.WHY_ESTIMATE_DATE_TIME,
    contact_consent: PHRASE_KEYS.WHY_CONTACT_CONSENT,
  }[questionId] || null;
}

function isSafeNotesAnswer(text) {
  if (NO_NOTES_PATTERN.test(text)) return true;
  if (QUESTION_LIKE_PATTERN.test(text)) return false;
  return text.split(/\s+/).filter(Boolean).length >= 2;
}

function isExplicitConsentAnswer(text) {
  return SIMPLE_YES.test(text) || SIMPLE_NO.test(text);
}

function isUnqualifiedSummaryYes(text) {
  return SIMPLE_YES.test(text) && !SUMMARY_CORRECTION_PATTERN.test(text);
}

function acknowledgementFor(previousQuestionId, transcript, lead, core) {
  if (previousQuestionId === 'service') {
    return receptionistPhrase(core, NEGATIVE_SERVICE_DETAIL_PATTERN.test(transcript) ? PHRASE_KEYS.ACK_SORRY : PHRASE_KEYS.ACK_GOOD, lead);
  }
  if (previousQuestionId === 'name') return receptionistPhrase(core, PHRASE_KEYS.ACK_THANKS_NAME, lead);
  if (previousQuestionId === 'project_location') return receptionistPhrase(core, PHRASE_KEYS.ACK_THANKS, lead);
  if (previousQuestionId === 'preferred_date_time') return receptionistPhrase(core, PHRASE_KEYS.ACK_GOOD, lead);
  if (previousQuestionId === 'notes' || previousQuestionId === 'contact_consent') return receptionistPhrase(core, PHRASE_KEYS.ACK_GOT_IT, lead);
  return '';
}

function applySummaryCorrections(text, lead) {
  const updated = { ...lead };
  const changed = [];

  if (NO_NOTES_PATTERN.test(text) && updated.notes !== 'none') {
    updated.notes = 'none';
    changed.push('notes');
  }

  const nameMatch = text.match(/\b(?:my name(?:'s| is)?|i'm|i am)\s+(?:not\s+[^,.]+[,;]?\s*)?(?:it's|it is|is)?\s*([A-Za-z][A-Za-z'’-]*)(?:\s+([A-Za-z][A-Za-z'’-]*))?/i)
    || text.match(/\bnot\s+[A-Za-z][A-Za-z'’-]*[,;]?\s+(?:it's|it is)\s+([A-Za-z][A-Za-z'’-]*)(?:\s+([A-Za-z][A-Za-z'’-]*))?/i);
  if (nameMatch) {
    const first = nameMatch[1];
    const last = nameMatch[2] || clean(updated.name).split(/\s+/).slice(1).join(' ');
    const corrected = clean(`${first} ${last}`);
    if (corrected.split(/\s+/).length >= 2 && corrected !== updated.name) {
      updated.name = corrected;
      changed.push('name');
    }
  }

  return { updated, changed };
}

export function createVoicePipeline({ runtime, callerPhone, sendAudioFrame, clearAudio, saveLead, endCall, log = console }) {
  const state = {
    lead: emptyLead(),
    memory: createCallMemory(),
    history: [],
    speaking: false,
    ttsPending: false,
    stopped: false,
    generation: 0,
    turnRevision: 0,
    audioTimer: null,
    queuedFrames: [],
    pendingReplyText: '',
    pendingReplyRemembered: false,
    pendingQuestionId: 'none',
    pendingCallerFragment: '',
    silenceTimer: null,
    repeatAfterPlaybackQuestionId: 'none',
    endAfterPlaybackReason: '',
    greetingSent: false,
    closingStarted: false,
  };

  function debug(event, payload = {}) {
    log.log('[Modular receptionist debug]', JSON.stringify({ timestamp: new Date().toISOString(), event, ...payload }));
  }

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
    const repeatQuestion = repeatQuestionFor(runtime.core, questionId, state.lead);
    if (!repeatQuestion || state.stopped || state.closingStarted) return;
    state.silenceTimer = setTimeout(() => {
      state.silenceTimer = null;
      state.pendingCallerFragment = '';
      if (state.stopped || state.closingStarted || state.memory.currentQuestionId !== questionId) return;
      debug('silence.base_question_repeat', { questionId, baseQuestion: repeatQuestion });
      speak(repeatQuestion, { scheduleRepeat: true, questionId }).catch((error) => {
        if (!isSpeechCancellation(error)) log.error('[Question repeat failed]', error);
      });
    }, SILENCE_REPEAT_MS);
  }

  function stopSpeaking() {
    state.generation += 1;
    state.speaking = false;
    state.ttsPending = false;
    state.queuedFrames = [];
    state.pendingReplyText = '';
    state.pendingReplyRemembered = false;
    state.pendingQuestionId = 'none';
    state.repeatAfterPlaybackQuestionId = 'none';
    state.endAfterPlaybackReason = '';
    if (state.audioTimer) clearTimeout(state.audioTimer);
    state.audioTimer = null;
    realtimeVoice.cancelSpeech();
    clearAudio?.();
  }

  function activatePendingPlayback() {
    if (state.pendingReplyRemembered) return;
    if (state.pendingQuestionId !== 'none') recordAskedQuestion(state.memory, state.pendingQuestionId);
    remember('assistant', state.pendingReplyText);
    state.pendingReplyRemembered = true;
    debug('playback.started', {
      reply: state.pendingReplyText,
      activatedQuestionId: state.pendingQuestionId,
      currentQuestionId: state.memory.currentQuestionId,
    });
  }

  function pumpFrames(generation) {
    if (state.stopped || generation !== state.generation) return;
    const frame = state.queuedFrames.shift();
    if (!frame) {
      state.speaking = false;
      state.audioTimer = null;
      const endReason = state.endAfterPlaybackReason;
      const repeatQuestionId = state.repeatAfterPlaybackQuestionId;
      state.endAfterPlaybackReason = '';
      state.repeatAfterPlaybackQuestionId = 'none';
      state.pendingReplyText = '';
      state.pendingReplyRemembered = false;
      state.pendingQuestionId = 'none';
      if (endReason) return endCall?.(endReason);
      if (repeatQuestionId !== 'none') scheduleBaseQuestionRepeat(repeatQuestionId);
      return;
    }
    activatePendingPlayback();
    sendAudioFrame(frame);
    state.audioTimer = setTimeout(() => pumpFrames(generation), 20);
  }

  async function speak(text, { scheduleRepeat = true, endAfterPlaybackReason = '', questionId = 'none' } = {}) {
    const reply = clean(text);
    if (!reply || state.stopped) return;
    stopSpeaking();
    debug('tts.requested', { engine: 'realtime', reply, currentQuestionId: state.memory.currentQuestionId, pendingQuestionId: questionId, scheduleRepeat, endAfterPlaybackReason });
    const generation = state.generation;
    state.ttsPending = true;
    state.pendingReplyText = reply;
    state.pendingQuestionId = questionId;
    let frames;
    try {
      frames = await realtimeVoice.synthesize(reply);
    } catch (error) {
      if (isSpeechCancellation(error) || state.stopped || generation !== state.generation) return;
      throw error;
    }
    if (state.stopped || generation !== state.generation) return;
    state.ttsPending = false;
    state.queuedFrames = frames;
    state.repeatAfterPlaybackQuestionId = scheduleRepeat ? (questionId !== 'none' ? questionId : state.memory.currentQuestionId) : 'none';
    state.endAfterPlaybackReason = endAfterPlaybackReason;
    state.speaking = true;
    pumpFrames(generation);
  }

  async function speakClosingAndEnd() {
    if (state.closingStarted || state.stopped) return;
    state.closingStarted = true;
    clearSilenceTimer();
    const closing = receptionistPhrase(runtime.core, PHRASE_KEYS.CLOSING, state.lead);
    debug('closing.started', { closing });
    await speak(closing, { scheduleRepeat: false, endAfterPlaybackReason: 'completed' });
  }

  async function submitLeadSafely() {
    const mappedLead = validationLeadFromModular(state.lead);
    const validation = runtime.core.validateLead(mappedLead);
    if (!validation.valid) return { ok: false, invalid: true, errors: validation.errors };
    try {
      debug('lead.submission_started', { lead: validation.lead });
      await saveLead({ callerPhone, lead: validation.lead, payload: runtime.core.buildOcmPayload(callerPhone, validation.lead) });
      state.memory.leadSaved = true;
      state.memory.submissionFailed = false;
      debug('lead.submission_succeeded');
      return { ok: true };
    } catch (error) {
      state.memory.submissionFailed = true;
      debug('lead.submission_failed', { error: error?.message || String(error) });
      return { ok: false, error };
    }
  }

  async function askQuestion(questionId, prefix = '') {
    const question = baseQuestionFor(runtime.core, questionId, state.lead);
    const reply = clean(`${prefix} ${question}`);
    debug('turn.final', { spokenReply: reply, askedQuestionId: questionId, lead: state.lead, memory: state.memory });
    await speak(reply, { questionId });
  }

  async function processTranscript(transcript) {
    let text = clean(transcript);
    if (!text || state.stopped || state.closingStarted) return;
    clearSilenceTimer();

    if (state.pendingCallerFragment) {
      const fragment = state.pendingCallerFragment;
      if (shouldKeepHoldingFragment(fragment, text)) {
        state.pendingCallerFragment = mergeCallerFragment(fragment, text);
        scheduleBaseQuestionRepeat(state.memory.currentQuestionId);
        return;
      }
      state.pendingCallerFragment = '';
      text = mergeCallerFragment(fragment, text);
    } else if (isObviouslyIncompleteTranscript(text)) {
      state.pendingCallerFragment = text;
      scheduleBaseQuestionRepeat(state.memory.currentQuestionId);
      return;
    }

    state.turnRevision += 1;
    const currentQuestionId = state.memory.currentQuestionId;
    remember('caller', text);
    debug('caller.transcript', { transcript: text, currentQuestionId, lead: state.lead, memory: state.memory });

    if (isControlSpeech(text)) return speak(controlSpeechReply(runtime.core, currentQuestionId, state.lead), { questionId: currentQuestionId });
    if (IDENTITY_PATTERN.test(text)) return speak(receptionistPhrase(runtime.core, PHRASE_KEYS.AI_IDENTITY, state.lead));
    if (RESTART_PATTERN.test(text)) return speak(receptionistPhrase(runtime.core, PHRASE_KEYS.RESTART_BLOCKED, state.lead));
    if (OFF_TOPIC_PATTERN.test(text)) return speak(receptionistPhrase(runtime.core, PHRASE_KEYS.OFF_TOPIC, state.lead));

    if (WHY_PATTERN.test(text)) {
      const whyKey = whyPhraseKey(currentQuestionId);
      const prefix = whyKey ? receptionistPhrase(runtime.core, whyKey, state.lead) : receptionistPhrase(runtime.core, PHRASE_KEYS.UNKNOWN_INFORMATION, state.lead);
      return askQuestion(currentQuestionId === 'none' ? 'ask_estimate' : currentQuestionId, prefix);
    }

    if (currentQuestionId === 'ask_estimate' || currentQuestionId === 'continue_estimate') {
      if (SIMPLE_YES.test(text)) {
        state.memory.estimateStarted = true;
        return askQuestion('service');
      }
      if (SIMPLE_NO.test(text)) return askQuestion('more_questions');
      return askQuestion(currentQuestionId, receptionistPhrase(runtime.core, PHRASE_KEYS.CLARIFY, state.lead));
    }

    if (currentQuestionId === 'more_questions') {
      if (SIMPLE_NO.test(text)) return speakClosingAndEnd();
      return speak(receptionistPhrase(runtime.core, PHRASE_KEYS.UNKNOWN_INFORMATION, state.lead), { questionId: 'more_questions' });
    }

    if (currentQuestionId === 'confirm_summary') {
      const correction = applySummaryCorrections(text, state.lead);
      if (correction.changed.length) {
        state.lead = correction.updated;
        state.memory.completedQuestionIds = state.memory.completedQuestionIds.filter((id) => id !== 'confirm_summary');
        debug('summary.correction_applied', { transcript: text, changedFields: correction.changed, lead: state.lead });
        return askQuestion('confirm_summary');
      }
      if (isUnqualifiedSummaryYes(text)) {
        state.memory.completedQuestionIds = mergeUnique(state.memory.completedQuestionIds, ['confirm_summary']);
        const submission = await submitLeadSafely();
        if (submission.ok) return askQuestion('more_questions', receptionistPhrase(runtime.core, PHRASE_KEYS.SUBMISSION_SUCCESS, state.lead).replace(baseQuestionFor(runtime.core, 'more_questions', state.lead), ''));
        if (submission.invalid) {
          const questionId = validationQuestion(submission.errors);
          removeCompletion(state.memory, questionId);
          const validationKey = validationPhraseKey(questionId);
          return askQuestion(questionId, validationKey ? receptionistPhrase(runtime.core, validationKey, state.lead) : '');
        }
        return askQuestion('more_questions', receptionistPhrase(runtime.core, PHRASE_KEYS.SUBMISSION_FAILURE, state.lead).replace(baseQuestionFor(runtime.core, 'more_questions', state.lead), ''));
      }
      return askQuestion('confirm_summary', receptionistPhrase(runtime.core, PHRASE_KEYS.CLARIFY, state.lead));
    }

    const before = { ...state.lead };
    let mayCapture = true;

    if (currentQuestionId === 'notes') {
      if (NO_NOTES_PATTERN.test(text)) {
        state.lead.notes = 'none';
        mayCapture = false;
      } else if (!isSafeNotesAnswer(text)) {
        mayCapture = false;
      }
    }

    if (currentQuestionId === 'contact_consent') {
      if (SIMPLE_YES.test(text)) {
        state.lead.contactConsent = true;
        mayCapture = false;
      } else if (SIMPLE_NO.test(text)) {
        state.lead.contactConsent = false;
        mayCapture = false;
      } else {
        mayCapture = false;
      }
    }

    if (mayCapture) state.lead = captureDeterministicLead(runtime.core, currentQuestionId, text, state.lead);
    const changes = changedLeadFields(before, state.lead);
    if (changes.length) {
      state.memory.completedQuestionIds = markDeterministicCompletions(currentQuestionId, state.lead, state.memory.completedQuestionIds);
      debug('lead.deterministic_committed', { transcript: text, currentQuestionId, changedFields: changes, lead: state.lead });
    }

    const nextQuestion = nextRequiredQuestion(state.memory, state.lead);
    if (nextQuestion !== currentQuestionId) {
      const acknowledgement = acknowledgementFor(currentQuestionId, text, state.lead, runtime.core);
      return askQuestion(nextQuestion, acknowledgement);
    }

    const validationKey = validationPhraseKey(currentQuestionId);
    const prefix = validationKey
      ? receptionistPhrase(runtime.core, validationKey, state.lead)
      : receptionistPhrase(runtime.core, PHRASE_KEYS.CLARIFY, state.lead);
    return askQuestion(currentQuestionId, prefix);
  }

  const realtimeVoice = createRealtimeVoice({
    silenceMs: runtime.core.SILENCE_DURATION_MS,
    voice: runtime.core.REALTIME_VOICE,
    speed: runtime.core.SPEECH_SPEED,
    onReady: (session) => debug('realtime_voice.ready', { realtimeVoiceModel: session.realtimeVoiceModel, transcriptionModel: session.transcriptionModel }),
    onSpeechStarted: () => {
      state.turnRevision += 1;
      clearSilenceTimer();
      if (state.speaking || state.ttsPending || state.queuedFrames.length) stopSpeaking();
    },
    onTranscript: (value) => processTranscript(value).catch((error) => {
      if (!isSpeechCancellation(error)) log.error('[Transcript processing failed]', error);
    }),
    onError: (error) => debug('realtime_voice.error', { error: error?.stack || error?.message || String(error) }),
  });

  return {
    async start() {
      if (state.greetingSent || state.stopped) return;
      state.greetingSent = true;
      const opening = receptionistPhrase(runtime.core, PHRASE_KEYS.OPENING, state.lead);
      debug('pipeline.started', { business: runtime.core.BUSINESS.name, openingLine: opening });
      await speak(opening, { questionId: 'ask_estimate' });
    },
    async announce(text) {
      if (!state.stopped && !state.closingStarted) await speak(text, { scheduleRepeat: true });
    },
    appendCallerAudio(base64Pcmu) {
      if (!state.stopped && !state.closingStarted) realtimeVoice.append(base64Pcmu);
    },
    stop(reason = 'stopped') {
      state.stopped = true;
      state.turnRevision += 1;
      state.pendingCallerFragment = '';
      clearSilenceTimer();
      stopSpeaking();
      realtimeVoice.close();
      debug('pipeline.stopped', { reason });
    },
    snapshot() {
      return {
        lead: { ...state.lead },
        memory: { ...state.memory, askedCounts: { ...state.memory.askedCounts }, completedQuestionIds: [...state.memory.completedQuestionIds] },
        history: [...state.history],
        speaking: state.speaking,
        ttsPending: state.ttsPending,
        turnRevision: state.turnRevision,
        pendingCallerFragment: state.pendingCallerFragment,
        greetingSent: state.greetingSent,
        closingStarted: state.closingStarted,
      };
    },
  };
}
