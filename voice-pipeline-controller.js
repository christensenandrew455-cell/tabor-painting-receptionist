import {
  QUESTION_IDS,
  createCallMemory,
  decideReceptionistTurn,
  emptyLead,
} from './receptionist-brain.js';
import { createRealtimeVoice } from './openai-voice.js';
import {
  ESTIMATE_ORDER,
  baseQuestionFor,
  callerAffirmsSummary,
  captureDeterministicLead,
  changedLeadFields,
  controlSpeechReply,
  enforceQuestionBlock,
  isControlSpeech,
  isLikelyTranscriptionArtifact,
  isObviouslyIncompleteTranscript,
  markDeterministicCompletions,
  mergeCallerFragment,
  mergeLead,
  nextRequiredQuestion,
  removeCompletion,
  reopenConfirmation,
  repeatQuestionFor,
  shouldKeepHoldingFragment,
  validationLeadFromModular,
  validationPreface,
  validationQuestion,
} from './modular-intake-logic.js';

const REPEATABLE_QUESTION_IDS = new Set([
  'ask_estimate',
  'continue_estimate',
  'more_questions',
  'clarify',
]);

const ESTIMATE_QUESTION_IDS = new Set(ESTIMATE_ORDER);
const RESTART_PATTERN = /\b(?:restart|start over|resubmit|do it again|fill (?:it|the form) out again)\b/i;
const IDENTITY_PATTERN = /\b(?:are you|is this)\s+(?:an?\s+)?(?:ai|bot|robot|human|person|real person)\b/i;
const FALSE_HUMAN_CLAIM_PATTERN = /\b(?:i am|i'm)\s+(?:a\s+)?(?:person|human|real person)\b/i;
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
  if (ESTIMATE_QUESTION_IDS.has(questionId)) memory.estimateStarted = true;
}

function identityLine(runtime) {
  return `I am an AI receptionist working for ${runtime.core.BUSINESS.name}, managed by our client center.`;
}

export function createVoicePipeline({ runtime, callerPhone, sendAudioFrame, clearAudio, saveLead, endCall, log = console }) {
  const state = {
    lead: emptyLead(),
    memory: createCallMemory(),
    history: [],
    speaking: false,
    ttsPending: false,
    submitting: false,
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
    log.log('[Modular receptionist debug]', JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...payload,
    }));
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
    if (!repeatQuestion || state.stopped || state.closingStarted || state.submitting) return;
    state.silenceTimer = setTimeout(() => {
      state.silenceTimer = null;
      state.pendingCallerFragment = '';
      if (state.stopped || state.closingStarted || state.submitting || state.memory.currentQuestionId !== questionId) return;
      debug('silence.base_question_repeat', {
        questionId,
        askedCount: Number(state.memory.askedCounts[questionId] || 0) + 1,
        baseQuestion: repeatQuestion,
      });
      speak(repeatQuestion, { scheduleRepeat: true, questionId })
        .catch((error) => log.error('[Question repeat failed]', error));
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

      if (endReason) {
        debug('playback.completed_hangup', { reason: endReason });
        endCall?.(endReason);
        return;
      }
      if (repeatQuestionId !== 'none') scheduleBaseQuestionRepeat(repeatQuestionId);
      return;
    }
    activatePendingPlayback();
    sendAudioFrame(frame);
    state.audioTimer = setTimeout(() => pumpFrames(generation), 20);
  }

  async function speak(text, {
    scheduleRepeat = true,
    endAfterPlaybackReason = '',
    questionId = 'none',
  } = {}) {
    const reply = clean(text);
    if (!reply || state.stopped) return;
    stopSpeaking();
    debug('tts.requested', {
      engine: 'realtime',
      reply,
      currentQuestionId: state.memory.currentQuestionId,
      pendingQuestionId: questionId,
      scheduleRepeat,
      endAfterPlaybackReason,
    });
    const generation = state.generation;
    state.ttsPending = true;
    state.pendingReplyText = reply;
    state.pendingQuestionId = questionId;

    let frames;
    try {
      frames = await realtimeVoice.synthesize(reply, {
        voice: runtime.core.REALTIME_VOICE,
        speed: runtime.core.SPEECH_SPEED,
      });
    } catch (error) {
      if (generation !== state.generation || state.stopped) return;
      state.ttsPending = false;
      state.pendingReplyText = '';
      state.pendingQuestionId = 'none';
      throw error;
    }

    if (state.stopped || generation !== state.generation) return;
    state.ttsPending = false;
    state.queuedFrames = frames;
    state.repeatAfterPlaybackQuestionId = scheduleRepeat
      ? (questionId !== 'none' ? questionId : state.memory.currentQuestionId)
      : 'none';
    state.endAfterPlaybackReason = endAfterPlaybackReason;
    state.speaking = true;
    pumpFrames(generation);
  }

  async function waitForPlaybackToFinish(timeoutMs = 8000) {
    const startedAt = Date.now();
    while (!state.stopped && (state.ttsPending || state.speaking || state.queuedFrames.length)) {
      if (Date.now() - startedAt >= timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function speakClosingAndEnd() {
    if (state.closingStarted || state.stopped) return;
    state.closingStarted = true;
    clearSilenceTimer();
    const closing = clean(runtime.core.closingLine);
    debug('closing.started', { closing });
    await speak(closing, { scheduleRepeat: false, endAfterPlaybackReason: 'completed' });
  }

  async function submitLeadSafely() {
    const mappedLead = validationLeadFromModular(state.lead);
    const validation = runtime.core.validateLead(mappedLead);
    if (!validation.valid) {
      log.warn('[Brain requested invalid lead submission]', validation.errors);
      debug('lead.validation_failed', {
        errors: validation.errors,
        modularLead: state.lead,
        mappedLead,
      });
      return { ok: false, invalid: true, errors: validation.errors };
    }

    try {
      debug('lead.submission_started', { lead: validation.lead });
      await saveLead({
        callerPhone,
        lead: validation.lead,
        payload: runtime.core.buildOcmPayload(callerPhone, validation.lead),
      });
      state.memory.leadSaved = true;
      state.memory.submissionFailed = false;
      debug('lead.submission_succeeded');
      return { ok: true };
    } catch (error) {
      state.memory.leadSaved = false;
      state.memory.submissionFailed = true;
      log.error('[Estimate submission failed]', error);
      debug('lead.submission_failed', { error: error?.message || String(error) });
      return { ok: false, error };
    }
  }

  async function processTranscript(transcript) {
    let text = clean(transcript);
    if (!text || state.stopped || state.closingStarted) return;

    if (state.submitting) {
      debug('caller.ignored_during_submission', { transcript: text });
      return;
    }

    if (isLikelyTranscriptionArtifact(text)) {
      debug('caller.transcription_artifact_ignored', { transcript: text });
      return;
    }

    clearSilenceTimer();

    if (state.pendingCallerFragment) {
      const fragment = state.pendingCallerFragment;
      if (shouldKeepHoldingFragment(fragment, text)) {
        state.pendingCallerFragment = mergeCallerFragment(fragment, text);
        debug('caller.partial_held', {
          transcript: state.pendingCallerFragment,
          currentQuestionId: state.memory.currentQuestionId,
        });
        scheduleBaseQuestionRepeat(state.memory.currentQuestionId);
        return;
      }
      state.pendingCallerFragment = '';
      text = mergeCallerFragment(fragment, text);
      debug('caller.partial_merged', { fragment, transcript: text });
    } else if (isObviouslyIncompleteTranscript(text)) {
      state.pendingCallerFragment = text;
      debug('caller.partial_held', {
        transcript: text,
        currentQuestionId: state.memory.currentQuestionId,
      });
      scheduleBaseQuestionRepeat(state.memory.currentQuestionId);
      return;
    }

    const turnRevision = ++state.turnRevision;
    const currentQuestionId = state.memory.currentQuestionId;

    if (isControlSpeech(text)) {
      remember('caller', text);
      const reply = controlSpeechReply(runtime.core, currentQuestionId, state.lead);
      debug('guard.control_speech', { transcript: text, currentQuestionId, reply });
      await speak(reply, { questionId: currentQuestionId });
      return;
    }

    const beforeCapture = { ...state.lead };
    const capturedLead = captureDeterministicLead(runtime.core, currentQuestionId, text, state.lead);
    const deterministicChanges = changedLeadFields(beforeCapture, capturedLead);
    if (deterministicChanges.length) {
      state.lead = capturedLead;
      state.memory.completedQuestionIds = markDeterministicCompletions(
        currentQuestionId,
        state.lead,
        state.memory.completedQuestionIds,
      );
      if (currentQuestionId === 'confirm_summary') reopenConfirmation(state.memory);
      debug('lead.deterministic_committed', {
        transcript: text,
        currentQuestionId,
        changedFields: deterministicChanges,
        lead: state.lead,
      });
    }

    remember('caller', text);
    const requestHistory = [...state.history];
    debug('caller.transcript', {
      transcript: text,
      turnRevision,
      currentQuestionId,
      lead: state.lead,
      memory: state.memory,
    });

    if (IDENTITY_PATTERN.test(text)) {
      const reply = identityLine(runtime);
      debug('guard.identity', { transcript: text, reply });
      await speak(reply);
      return;
    }

    if (state.memory.estimateStarted && !state.memory.leadSaved && RESTART_PATTERN.test(text)) {
      const reply = 'You can update the estimate request information when I summarize it at the end.';
      debug('guard.restart', { transcript: text, reply });
      await speak(reply);
      return;
    }

    try {
      debug('brain.request', {
        transcript: text,
        turnRevision,
        lead: state.lead,
        memory: state.memory,
        recentConversation: requestHistory.slice(-12),
      });
      const turn = await decideReceptionistTurn({
        core: runtime.core,
        transcript: text,
        lead: state.lead,
        history: requestHistory,
        callMemory: state.memory,
      });
      debug('brain.response', { turnRevision, turn });

      if (turnRevision !== state.turnRevision || state.stopped || state.closingStarted) {
        debug('guard.stale_turn_discarded', {
          turnRevision,
          currentTurnRevision: state.turnRevision,
          transcript: text,
          durableLead: state.lead,
        });
        return;
      }

      const beforeBrainMerge = { ...state.lead };
      state.lead = mergeLead(state.lead, turn.updatedLead || {});
      const modelChanges = changedLeadFields(beforeBrainMerge, state.lead);
      if (modelChanges.length && state.memory.completedQuestionIds.includes('confirm_summary')) {
        reopenConfirmation(state.memory);
        debug('guard.summary_reopened_after_change', { changedFields: modelChanges, lead: state.lead });
      }

      const safeModelCompletions = (turn.completedQuestionIds || [])
        .filter((id) => id !== 'confirm_summary' || currentQuestionId === 'confirm_summary');
      state.memory.completedQuestionIds = mergeUnique(
        state.memory.completedQuestionIds,
        safeModelCompletions,
      );
      state.memory.completedQuestionIds = markDeterministicCompletions(
        currentQuestionId,
        state.lead,
        state.memory.completedQuestionIds,
      );

      let spokenReply = clean(turn.spokenReply);
      let askedQuestionId = QUESTION_IDS.includes(turn.askedQuestionId) ? turn.askedQuestionId : 'none';
      let submitRequested = turn.submitLead === true;
      let shouldEndCall = turn.endCall === true;

      if (currentQuestionId === 'confirm_summary' && callerAffirmsSummary(text)) {
        state.memory.completedQuestionIds = mergeUnique(state.memory.completedQuestionIds, ['confirm_summary']);
        submitRequested = true;
        shouldEndCall = false;
        askedQuestionId = 'none';
        debug('guard.summary_affirmation_committed', { transcript: text, lead: state.lead });
      }

      if (turn.intent === 'estimate' || ESTIMATE_QUESTION_IDS.has(askedQuestionId) || submitRequested) {
        state.memory.estimateStarted = true;
      }

      if (FALSE_HUMAN_CLAIM_PATTERN.test(spokenReply)) {
        spokenReply = identityLine(runtime);
        askedQuestionId = 'none';
        submitRequested = false;
        shouldEndCall = false;
        debug('guard.false_human_claim_blocked', { modelReply: turn.spokenReply, replacement: spokenReply });
      }

      const requiredQuestionId = state.memory.estimateStarted
        ? nextRequiredQuestion(state.memory, state.lead)
        : 'none';
      const estimateTurn = (state.memory.estimateStarted && !state.memory.leadSaved)
        || turn.intent === 'estimate'
        || ESTIMATE_QUESTION_IDS.has(askedQuestionId)
        || submitRequested;

      if (estimateTurn && requiredQuestionId !== 'none' && askedQuestionId !== requiredQuestionId && !submitRequested) {
        const previousQuestionId = askedQuestionId;
        askedQuestionId = requiredQuestionId;
        spokenReply = baseQuestionFor(runtime.core, askedQuestionId, state.lead);
        shouldEndCall = false;
        debug(requiredQuestionId === 'service' ? 'guard.service_first' : 'guard.field_order_enforced', {
          previousQuestionId,
          requiredQuestionId,
          spokenReply,
        });
      }

      if (questionIsLocked(state.memory, askedQuestionId)) {
        const blockedQuestionId = askedQuestionId;
        const replacementQuestionId = nextRequiredQuestion(state.memory, state.lead);
        askedQuestionId = replacementQuestionId !== 'none'
          ? replacementQuestionId
          : state.memory.leadSaved ? 'more_questions' : 'confirm_summary';
        if (askedQuestionId === 'confirm_summary') reopenConfirmation(state.memory);
        spokenReply = baseQuestionFor(runtime.core, askedQuestionId, state.lead);
        submitRequested = false;
        shouldEndCall = false;
        debug('guard.completed_question_repeat_blocked', {
          blockedQuestionId,
          replacementQuestionId: askedQuestionId,
          spokenReply,
        });
      }

      if (submitRequested && !state.memory.leadSaved) {
        const stillMissing = nextRequiredQuestion(state.memory, state.lead);
        if (stillMissing !== 'none' && stillMissing !== 'confirm_summary') {
          askedQuestionId = stillMissing;
          spokenReply = baseQuestionFor(runtime.core, askedQuestionId, state.lead);
          shouldEndCall = false;
          debug('guard.submit_before_complete_blocked', { stillMissing, lead: state.lead });
        } else if (!state.memory.completedQuestionIds.includes('confirm_summary')) {
          askedQuestionId = 'confirm_summary';
          spokenReply = baseQuestionFor(runtime.core, askedQuestionId, state.lead);
          submitRequested = false;
          shouldEndCall = false;
          debug('guard.submit_before_confirmation_blocked', { lead: state.lead });
        } else {
          state.submitting = true;
          clearSilenceTimer();
          await speak('Okay, great. Sending it in now.', { scheduleRepeat: false });
          await waitForPlaybackToFinish();
          const submission = await submitLeadSafely();
          state.submitting = false;
          shouldEndCall = false;
          if (turnRevision !== state.turnRevision || state.stopped || state.closingStarted) {
            debug('guard.stale_turn_discarded', {
              turnRevision,
              currentTurnRevision: state.turnRevision,
              transcript: text,
              stage: 'after_submission',
            });
            return;
          }
          if (submission.ok) {
            askedQuestionId = 'more_questions';
            spokenReply = `Your estimate request has been sent successfully. ${runtime.core.BUSINESS.name} will follow up with you shortly. ${baseQuestionFor(runtime.core, askedQuestionId, state.lead)}`;
          } else if (submission.invalid) {
            askedQuestionId = validationQuestion(submission.errors);
            removeCompletion(state.memory, askedQuestionId);
            const preface = validationPreface(runtime.core, askedQuestionId, submission.errors);
            spokenReply = `${preface} ${baseQuestionFor(runtime.core, askedQuestionId, state.lead)}`;
          } else {
            askedQuestionId = 'more_questions';
            spokenReply = `I'm sorry. I couldn't send your estimate request because something went wrong. Please try calling again within the next 24 hours. ${baseQuestionFor(runtime.core, askedQuestionId, state.lead)}`;
          }
        }
      }

      if (askedQuestionId !== 'none') {
        const guardedReply = enforceQuestionBlock(runtime.core, spokenReply, askedQuestionId, state.lead);
        if (guardedReply !== spokenReply) {
          debug('guard.question_wording_enforced', {
            askedQuestionId,
            modelReply: spokenReply,
            replacement: guardedReply,
          });
        }
        spokenReply = guardedReply;
      }

      if (shouldEndCall) {
        debug('turn.final', {
          action: 'closing',
          lead: state.lead,
          memory: state.memory,
        });
        await speakClosingAndEnd();
        return;
      }

      debug('turn.final', {
        spokenReply,
        askedQuestionId,
        lead: state.lead,
        memory: state.memory,
      });
      await speak(spokenReply, { questionId: askedQuestionId });
    } catch (error) {
      state.submitting = false;
      if (turnRevision !== state.turnRevision || state.stopped || state.closingStarted) {
        debug('guard.stale_turn_error_ignored', {
          turnRevision,
          currentTurnRevision: state.turnRevision,
          error: error?.message || String(error),
        });
        return;
      }
      log.error('[Voice pipeline turn failed]', error);
      debug('turn.error', { error: error?.stack || error?.message || String(error) });
      await speak(baseQuestionFor(runtime.core, 'clarify', state.lead), { questionId: 'clarify' });
    }
  }

  const realtimeVoice = createRealtimeVoice({
    silenceMs: runtime.core.SILENCE_DURATION_MS,
    voice: runtime.core.REALTIME_VOICE,
    speed: runtime.core.SPEECH_SPEED,
    onReady: (session) => {
      debug('realtime_voice.ready', {
        realtimeVoiceModel: session.realtimeVoiceModel,
        transcriptionModel: session.transcriptionModel,
      });
    },
    onSpeechStarted: () => {
      clearSilenceTimer();
      debug('caller.speech_started', {
        speaking: state.speaking,
        ttsPending: state.ttsPending,
        submitting: state.submitting,
        turnRevision: state.turnRevision,
      });
      if (!state.submitting && (state.speaking || state.ttsPending || state.queuedFrames.length)) stopSpeaking();
    },
    onTranscript: (transcript) => {
      processTranscript(transcript).catch((error) => log.error('[Transcript processing failed]', error));
    },
    onError: (error) => {
      log.error('[Realtime voice failed]', error);
      debug('realtime_voice.error', { error: error?.stack || error?.message || String(error) });
    },
  });

  return {
    async start() {
      if (state.greetingSent || state.stopped) return;
      state.greetingSent = true;
      debug('pipeline.started', {
        business: runtime.core.BUSINESS.name,
        openingLine: runtime.core.openingLine,
      });
      await speak(runtime.core.openingLine, { questionId: 'ask_estimate' });
    },
    async announce(text) {
      if (state.stopped || state.closingStarted) return;
      await speak(text, { scheduleRepeat: true });
    },
    appendCallerAudio(base64Pcmu) {
      if (!state.stopped && !state.closingStarted) realtimeVoice.append(base64Pcmu);
    },
    stop(reason = 'stopped') {
      state.stopped = true;
      state.turnRevision += 1;
      state.pendingCallerFragment = '';
      state.submitting = false;
      clearSilenceTimer();
      stopSpeaking();
      realtimeVoice.close();
      debug('pipeline.stopped', { reason });
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
        ttsPending: state.ttsPending,
        submitting: state.submitting,
        turnRevision: state.turnRevision,
        pendingCallerFragment: state.pendingCallerFragment,
        greetingSent: state.greetingSent,
        closingStarted: state.closingStarted,
      };
    },
  };
}
