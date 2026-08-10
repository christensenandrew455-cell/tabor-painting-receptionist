import { WebSocket } from 'ws';
import { cleanText } from './business-context.js';
import { createIntakeManager } from './intake.js';
import {
  CALLER_TURN_ANALYSIS_TOOL,
  buildTurnAnalysisInstructions,
  createReceptionistConversation,
} from './receptionist-conversation.js';
import {
  SERVICE_QUESTION,
  SUBMISSION_FAILURE_RESPONSE,
  SUBMISSION_START_RESPONSE,
  SUBMISSION_SUCCESS_RESPONSE,
  UNCLEAR_CALLER_RESPONSE,
  shouldInterruptReceptionist,
  spokenBusinessName,
} from './receptionist-policy.js';

const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';
const DEFAULT_VOICE = 'marin';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const MAX_PENDING_AUDIO_CHUNKS = 500;
const PCMU_BYTES_PER_SECOND = 8_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_CONTEXT_TOKEN_LIMIT = 2_500;
const DEFAULT_CONTEXT_RETENTION_RATIO = 0.7;
const DEFAULT_MAX_RESPONSES_PER_CALL = 40;
const MAX_ANALYSIS_RETRIES = 1;
const MAX_SPEECH_RETRIES = 1;
const DEFAULT_INCOMPLETE_TURN_RECOVERY_MS = 8_000;
const NOTES_INCOMPLETE_TURN_RECOVERY_MS = 12_000;
const DEFAULT_HOLD_RECOVERY_MS = 30_000;
const SUPPORTED_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'marin',
  'sage',
  'shimmer',
  'verse',
]);

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function costControls() {
  return Object.freeze({
    maxOutputTokens: Math.round(boundedNumber(
      process.env.OPENAI_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
      64,
      1_024,
    )),
    contextTokenLimit: Math.round(boundedNumber(
      process.env.OPENAI_CONTEXT_TOKEN_LIMIT,
      DEFAULT_CONTEXT_TOKEN_LIMIT,
      1_000,
      16_000,
    )),
    retentionRatio: boundedNumber(
      process.env.OPENAI_CONTEXT_RETENTION_RATIO,
      DEFAULT_CONTEXT_RETENTION_RATIO,
      0.5,
      1,
    ),
    maxResponsesPerCall: Math.round(boundedNumber(
      process.env.OPENAI_MAX_RESPONSES_PER_CALL,
      DEFAULT_MAX_RESPONSES_PER_CALL,
      10,
      200,
    )),
  });
}

function modelAudioRates(model) {
  if (model === 'gpt-realtime-2.1-mini') return { input: 10, output: 20 };
  if (model === 'gpt-realtime-2.1') return { input: 32, output: 64 };
  return null;
}

function addResponseUsage(total, usage, model) {
  if (!usage || typeof usage !== 'object') return total;
  const inputTokens = Math.max(0, Number(usage.input_tokens || 0));
  const outputTokens = Math.max(0, Number(usage.output_tokens || 0));
  const next = {
    model,
    responsesWithUsage: total.responsesWithUsage + 1,
    inputTokens: total.inputTokens + inputTokens,
    outputTokens: total.outputTokens + outputTokens,
    totalTokens: total.totalTokens + Math.max(
      0,
      Number(usage.total_tokens || inputTokens + outputTokens),
    ),
    estimatedCostUpperBoundUsd: null,
  };
  const rates = modelAudioRates(model);
  if (rates) {
    next.estimatedCostUpperBoundUsd = Number((
      (next.inputTokens * rates.input + next.outputTokens * rates.output) / 1_000_000
    ).toFixed(6));
  }
  return next;
}

function serviceGuide(context) {
  if (!context.services.length) return '- No structured service list was supplied.';
  return context.services
    .map((service) => `- ${service.name}${service.description ? `: ${service.description}` : ''}`)
    .join('\n');
}

export function buildReceptionistInstructions(context, { submitted = false } = {}) {
  const businessName = spokenBusinessName(context.businessName);
  return `
# Role
You are the phone receptionist for ${businessName}.
Help the caller complete one service estimate request. Sound friendly, attentive, concise, and natural.
Never introduce yourself with a personal name. If directly asked, say that you are an AI receptionist working for ${businessName}, managed by ARC Client Center.

# Authoritative call control
The server owns the intake state, question order, validation, confirmation, submission, and hangup.
Never infer the current step from memory when a response instruction gives you the exact action.
When instructed to say exact text, say it immediately and exactly. Do not add a preamble, explanation, second question, or offer of more help.
When analyze_caller_turn is forced, call it once without speaking. The tool is language understanding, not permission to change state or submit anything.

# Language understanding
Use ordinary general knowledge only to understand natural speech: names, addresses, dates, times, corrections, unfinished thoughts, and obvious service meaning.
Caller-specific details must come from caller speech. Never copy a caller name, address, schedule, or project detail from business data.

# Business knowledge boundary
Answer factual questions about the business, trade, project, price, duration, methods, policy, or availability only when the supplied business information explicitly supports the answer.
If the supplied information does not contain the answer, classify the question as unanswerable. Never fill the gap with common industry knowledge or an assumption.
Estimate-request days and hours are not proof that a specific appointment is open. Never claim that a particular date or time is available; record it only as the caller's preference for the business to confirm.

# Turn taking
Do not speak for silence, background noise, a standalone backchannel, or an unfinished thought.
Do not interrupt the caller. Do not let caller speech cancel receptionist audio.
Use short spoken turns. Ask one question at a time.
Let callers describe their work in their own words. Interpret it only through the supplied services for this business so the same receptionist skeleton works across different trades.

# Supplied services
${serviceGuide(context)}

# Business information supplied for this call
<business_information>
${context.knowledgeJson}
</business_information>

# Completion state
${submitted
    ? 'The estimate request has been submitted. Say only the exact success or goodbye text requested by the server.'
    : 'The request is not submitted until the server completes the confirmed write.'}
`;
}

function selectedVoice() {
  const voice = cleanText(process.env.OPENAI_VOICE).toLowerCase();
  return SUPPORTED_VOICES.has(voice) ? voice : DEFAULT_VOICE;
}

export function buildSessionUpdate(context, { submitted = false } = {}) {
  const model = cleanText(process.env.OPENAI_REALTIME_MODEL) || DEFAULT_MODEL;
  const controls = costControls();
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model,
      output_modalities: ['audio'],
      instructions: buildReceptionistInstructions(context, { submitted }),
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          noise_reduction: { type: 'far_field' },
          transcription: {
            model: cleanText(process.env.OPENAI_TRANSCRIPTION_MODEL)
              || DEFAULT_TRANSCRIPTION_MODEL,
            language: cleanText(process.env.OPENAI_TRANSCRIPTION_LANGUAGE) || 'en',
          },
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'medium',
            create_response: false,
            interrupt_response: false,
          },
        },
        output: {
          format: { type: 'audio/pcmu' },
          voice: selectedVoice(),
        },
      },
      tools: [],
      tool_choice: 'none',
      truncation: {
        type: 'retention_ratio',
        retention_ratio: controls.retentionRatio,
        token_limits: {
          post_instructions: controls.contextTokenLimit,
        },
      },
      max_output_tokens: controls.maxOutputTokens,
    },
  };
}

function sendJson(socket, value) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  return socket.send(JSON.stringify(value)) !== false;
}

function parseArguments(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid caller-turn analysis: ${error.message}`);
  }
}

function exactSpeechInstruction(text) {
  return `Say exactly this text and nothing else: ${JSON.stringify(cleanText(text))}`;
}

function createSafetyIdentifier(runtime = {}, callControlId = '') {
  const identity = cleanText(runtime?.clientId || runtime?.businessId || runtime?.id || callControlId);
  if (!identity) return 'anonymous-receptionist-call';
  return `receptionist-${Buffer.from(identity).toString('base64url').slice(0, 64)}`;
}

export function createOpenAiReceptionist({
  context,
  runtime,
  callControlId,
  callerPhone,
  deliver,
  onAudio,
  onPlaybackClear,
  onSubmitted,
  onReady,
  onTranscript,
  onGoodbyeComplete,
  onCostLimit,
  onUsage,
  onLatency,
  onError,
  incompleteTurnRecoveryMs,
  holdRecoveryMs,
  WebSocketClass = WebSocket,
}) {
  const apiKey = cleanText(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error('OPENAI_API_KEY is required.');

  const model = cleanText(process.env.OPENAI_REALTIME_MODEL) || DEFAULT_MODEL;
  const realtimeUrl = cleanText(process.env.OPENAI_REALTIME_URL)
    || `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const controls = costControls();
  const configuredRecoveryDelay = incompleteTurnRecoveryMs
    ?? process.env.OPENAI_CALLER_SILENCE_REPROMPT_MS;
  const recoveryDelayMs = Math.round(boundedNumber(
    configuredRecoveryDelay,
    DEFAULT_INCOMPLETE_TURN_RECOVERY_MS,
    50,
    30_000,
  ));
  const notesRecoveryDelayMs = configuredRecoveryDelay === undefined
    ? NOTES_INCOMPLETE_TURN_RECOVERY_MS
    : recoveryDelayMs;
  const holdDelayMs = Math.round(boundedNumber(
    holdRecoveryMs ?? process.env.OPENAI_HOLD_REPROMPT_MS,
    DEFAULT_HOLD_RECOVERY_MS,
    50,
    120_000,
  ));
  const pendingAudio = [];
  const pendingCallerTurns = [];
  const pendingResponsePurposes = [];
  const responseRequestPurposes = new Map();
  const responsePurposes = new Map();
  const activeResponseIds = new Set();
  const assistantTranscriptDeltas = new Map();
  const emittedTranscriptKeys = new Set();
  const conversation = createReceptionistConversation({ context });
  const intake = createIntakeManager({
    context,
    callControlId,
    callerPhone,
    deliver,
  });

  let ready = false;
  let closed = false;
  let submitted = false;
  let finalizing = false;
  let endingCall = false;
  let greetingRequested = false;
  let responseCreationPending = false;
  let clientEventSequence = 0;
  let responseCount = 0;
  let costLimitTriggered = false;
  let lastSpeechStoppedAt = 0;
  let incompleteTurnTimer = null;
  let pendingCallerFragment = '';
  let callerSpeechActive = false;
  let holdActive = false;
  let receptionistPlaybackEndAt = 0;
  let work = Promise.resolve();
  let usageSummary = {
    model,
    responsesWithUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUpperBoundUsd: 0,
  };

  const openai = new WebSocketClass(realtimeUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Safety-Identifier': createSafetyIdentifier(runtime, callControlId),
    },
  });

  function reportError(error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  function clearIncompleteTurnRecovery() {
    if (incompleteTurnTimer) clearTimeout(incompleteTurnTimer);
    incompleteTurnTimer = null;
  }

  function rememberCallerFragment(value) {
    const fragment = cleanText(value);
    if (!fragment) return;
    pendingCallerFragment = cleanText(`${pendingCallerFragment} ${fragment}`).slice(-1_000);
  }

  function scheduleIncompleteTurnRecovery(
    text = '',
    delayMs = recoveryDelayMs,
    { endHold = false } = {},
  ) {
    if (closed || endingCall || finalizing || submitted) return;
    clearIncompleteTurnRecovery();
    const pendingField = conversation.snapshot().pendingField;
    const effectiveDelayMs = pendingField === 'notes' && !endHold
      ? Math.max(delayMs, notesRecoveryDelayMs)
      : delayMs;
    const playbackRemainingMs = Math.max(0, receptionistPlaybackEndAt - Date.now());
    incompleteTurnTimer = setTimeout(() => {
      incompleteTurnTimer = null;
      if (closed || endingCall || finalizing || submitted) return;
      if (callerSpeechActive || !canCreateResponse() || pendingCallerTurns.length) {
        scheduleIncompleteTurnRecovery(text, 250, { endHold });
        return;
      }
      pendingCallerFragment = '';
      if (endHold) holdActive = false;
      requestSpeech(cleanText(text) || conversation.bareQuestion());
    }, effectiveDelayMs + playbackRemainingMs);
    incompleteTurnTimer.unref?.();
  }

  function scheduleHoldRecovery() {
    scheduleIncompleteTurnRecovery('Are you still there?', holdDelayMs, { endHold: true });
  }

  function scheduleCallerSilenceRecovery(delayMs = recoveryDelayMs) {
    if (callerSpeechActive || pendingCallerTurns.length || !canCreateResponse()) return;
    if (holdActive) scheduleHoldRecovery();
    else scheduleIncompleteTurnRecovery(conversation.bareQuestion(), delayMs);
  }

  function sendSessionUpdate() {
    sendJson(openai, buildSessionUpdate(context, { submitted }));
  }

  function emitTranscript(speaker, value, metadata = {}) {
    const transcript = String(value ?? '').trim();
    if (!transcript) return;
    const identity = cleanText(metadata.itemId || metadata.responseId || transcript);
    const key = `${speaker}:${identity}`;
    if (emittedTranscriptKeys.has(key)) return;
    emittedTranscriptKeys.add(key);
    onTranscript?.({ speaker, text: transcript, ...metadata });
  }

  function assistantTranscriptKey(event = {}) {
    return cleanText(
      event.item_id
      || `${event.response_id || 'response'}:${event.output_index ?? 0}:${event.content_index ?? 0}`,
    );
  }

  function captureResponseTranscripts(response = {}) {
    const responseId = cleanText(response.id);
    for (const item of response.output || []) {
      if (item?.type !== 'message') continue;
      for (const content of item.content || []) {
        if (!content?.transcript) continue;
        emitTranscript('receptionist', content.transcript, {
          itemId: cleanText(item.id),
          responseId,
        });
      }
    }
  }

  function canCreateResponse() {
    return !closed && !activeResponseIds.size && !responseCreationPending;
  }

  function activeSpeechResponse() {
    for (const responseId of activeResponseIds) {
      const purpose = responsePurposes.get(responseId);
      if (purpose?.kind === 'speech' && purpose.after === 'continue') {
        return { responseId, purpose };
      }
    }
    return null;
  }

  function receptionistIsSpeakingOrPlaying() {
    return Boolean(activeSpeechResponse()) || receptionistPlaybackEndAt > Date.now();
  }

  function interruptForCallerTranscript(transcript) {
    if (
      closed
      || endingCall
      || finalizing
      || submitted
      || !shouldInterruptReceptionist(transcript)
    ) return false;

    const active = activeSpeechResponse();
    if (!active && receptionistPlaybackEndAt <= Date.now()) return false;
    clearIncompleteTurnRecovery();
    onPlaybackClear?.();
    receptionistPlaybackEndAt = Date.now();
    if (active) {
      active.purpose.interruptedByCaller = true;
      sendJson(openai, {
        type: 'response.cancel',
        response_id: active.responseId,
      });
    }
    return true;
  }

  function createResponse(response, purpose) {
    if (!canCreateResponse()) return false;
    clientEventSequence += 1;
    const requestEventId = `receptionist-response-${clientEventSequence}`;
    const trackedPurpose = {
      ...purpose,
      requestEventId,
      requestedAt: Date.now(),
      firstAudioAt: 0,
      audioBytes: 0,
    };
    pendingResponsePurposes.push(trackedPurpose);
    responseRequestPurposes.set(requestEventId, trackedPurpose);
    responseCreationPending = sendJson(openai, {
      type: 'response.create',
      event_id: requestEventId,
      response: {
        output_modalities: ['audio'],
        ...response,
      },
    });
    if (!responseCreationPending) {
      pendingResponsePurposes.pop();
      responseRequestPurposes.delete(requestEventId);
    }
    return responseCreationPending;
  }

  function requestSpeech(text, {
    after = 'continue',
    turn = null,
    retryCount = 0,
  } = {}) {
    const speech = cleanText(text);
    if (!speech || closed) return false;
    clearIncompleteTurnRecovery();
    holdActive = false;
    return createResponse({
      instructions: exactSpeechInstruction(speech),
      input: [],
      tools: [],
      tool_choice: 'none',
    }, {
      kind: 'speech',
      after,
      turn,
      retryCount,
      expectedSpeech: speech,
    });
  }

  function requestGreeting() {
    if (greetingRequested || submitted || endingCall) return;
    greetingRequested = true;
    const businessName = spokenBusinessName(context.businessName);
    requestSpeech(
      `Hi, thank you for calling ${businessName}. ${SERVICE_QUESTION}`,
      { after: 'continue' },
    );
  }

  function requestGoodbye() {
    if (endingCall || closed) return;
    endingCall = true;
    clearIncompleteTurnRecovery();
    const businessName = spokenBusinessName(context.businessName);
    requestSpeech(
      `Thank you for calling ${businessName}. Have a good day.`,
      { after: 'complete' },
    );
  }

  function requestAnalysis(turn) {
    if (closed || endingCall || finalizing || submitted) return false;
    clearIncompleteTurnRecovery();
    turn.analysisRequestedAt = Date.now();
    return createResponse({
      output_modalities: ['text'],
      instructions: buildTurnAnalysisInstructions({
        state: conversation.snapshot(),
        callerTranscript: turn.text,
        context,
      }),
      tools: [structuredClone(CALLER_TURN_ANALYSIS_TOOL)],
      tool_choice: { type: 'function', name: CALLER_TURN_ANALYSIS_TOOL.name },
    }, {
      kind: 'analysis',
      turn,
    });
  }

  function queueCallerTurn(text, itemId) {
    clearIncompleteTurnRecovery();
    callerSpeechActive = false;
    pendingCallerTurns.push({
      text: cleanText(text),
      itemId: cleanText(itemId),
      transcriptionAt: Date.now(),
      speechStoppedAt: lastSpeechStoppedAt,
      attempt: 0,
    });
    lastSpeechStoppedAt = 0;
  }

  function dispatchCallerTurn() {
    if (!canCreateResponse() || endingCall || finalizing || submitted) return;
    let waitingForContinuation = false;
    while (pendingCallerTurns.length) {
      let turn = pendingCallerTurns.shift();
      if (pendingCallerFragment) {
        turn = {
          ...turn,
          text: cleanText(`${pendingCallerFragment} ${turn.text}`),
        };
        pendingCallerFragment = '';
      }
      const preflight = conversation.preflight(turn.text);
      if (preflight.type === 'hold') {
        pendingCallerFragment = '';
        holdActive = true;
        scheduleHoldRecovery();
        return;
      }
      if (preflight.type === 'wait') {
        if (preflight.preserve) rememberCallerFragment(turn.text);
        waitingForContinuation = true;
        continue;
      }
      if (preflight.type === 'speak') {
        holdActive = false;
        requestSpeech(preflight.text, { turn });
        return;
      }
      requestAnalysis(turn);
      return;
    }
    if (waitingForContinuation) {
      if (holdActive) scheduleHoldRecovery();
      else scheduleIncompleteTurnRecovery();
    }
  }

  function sendFunctionOutput(callId, value) {
    if (!cleanText(callId)) return;
    sendJson(openai, {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(value),
      },
    });
  }

  function requestPreparation(turn) {
    let result;
    try {
      result = intake.prepare(conversation.intakeArguments());
    } catch (error) {
      requestSpeech(conversation.preparationFailed(error), { turn });
      return;
    }
    if (!result?.ok || !result.summary) {
      const error = Object.assign(new Error(result?.error || 'The estimate summary could not be prepared.'), {
        field: '',
      });
      requestSpeech(conversation.preparationFailed(error), { turn });
      return;
    }
    requestSpeech(conversation.enterSummary(result.summary), { turn });
  }

  async function submitEstimate(turn) {
    let result;
    try {
      result = await intake.submit({ caller_confirmed: true });
    } catch (error) {
      reportError(error);
      requestSpeech(SUBMISSION_FAILURE_RESPONSE, { after: 'goodbye', turn });
      return;
    }
    if (!result?.ok) {
      reportError(new Error(result?.error || 'Estimate submission failed.'));
      requestSpeech(SUBMISSION_FAILURE_RESPONSE, { after: 'goodbye', turn });
      return;
    }
    submitted = true;
    sendSessionUpdate();
    onSubmitted?.(intake.snapshot());
    requestSpeech(SUBMISSION_SUCCESS_RESPONSE, { after: 'goodbye', turn });
  }

  function handleConversationAction(action, turn) {
    if (!action || action.type === 'wait') {
      if (action?.preserve) rememberCallerFragment(turn?.text);
      if (holdActive) scheduleHoldRecovery();
      else scheduleIncompleteTurnRecovery();
      dispatchCallerTurn();
      return;
    }
    if (action.type === 'speak') {
      holdActive = false;
      requestSpeech(action.text, { turn });
      return;
    }
    if (action.type === 'prepare') {
      holdActive = false;
      requestPreparation(turn);
      return;
    }
    if (action.type === 'submit') {
      holdActive = false;
      finalizing = true;
      requestSpeech(SUBMISSION_START_RESPONSE, { after: 'submit', turn });
      return;
    }
    if (action.type === 'end') {
      holdActive = false;
      finalizing = true;
      requestSpeech(action.text, { after: 'goodbye', turn });
      return;
    }
    dispatchCallerTurn();
  }

  function combineContinuation(turn) {
    if (!pendingCallerTurns.length) return null;
    const continuations = pendingCallerTurns.splice(0);
    const meaningful = continuations.filter((candidate) => (
      conversation.preflight(candidate.text).type !== 'wait'
    ));
    if (!meaningful.length) return null;
    return {
      text: [turn.text, ...meaningful.map((candidate) => candidate.text)].join(' '),
      itemId: meaningful.at(-1).itemId || turn.itemId,
      transcriptionAt: meaningful.at(-1).transcriptionAt,
      speechStoppedAt: turn.speechStoppedAt,
      attempt: 0,
    };
  }

  function handleAnalysisResponse(purpose, response) {
    const turn = purpose.turn;
    turn.analysisDoneAt = Date.now();
    const calls = (response.output || []).filter(
      (item) => item?.type === 'function_call' && item.name === CALLER_TURN_ANALYSIS_TOOL.name,
    );
    const call = calls[0];

    const continuation = combineContinuation(turn);
    if (continuation) {
      if (call?.call_id) sendFunctionOutput(call.call_id, { ok: true, status: 'superseded_by_continuation' });
      pendingCallerTurns.unshift(continuation);
      dispatchCallerTurn();
      return;
    }

    if (!call) {
      if (turn.attempt < MAX_ANALYSIS_RETRIES) {
        turn.attempt += 1;
        requestAnalysis(turn);
      } else {
        requestSpeech(
          `${conversation.bareQuestion()}`,
          { turn },
        );
      }
      return;
    }

    let analysis;
    try {
      analysis = parseArguments(call.arguments);
    } catch (error) {
      sendFunctionOutput(call.call_id, { ok: false, error: error.message });
      if (turn.attempt < MAX_ANALYSIS_RETRIES) {
        turn.attempt += 1;
        requestAnalysis(turn);
      } else {
        requestSpeech(conversation.bareQuestion(), { turn });
      }
      return;
    }

    const action = conversation.applyAnalysis(analysis, turn.text);
    sendFunctionOutput(call.call_id, {
      ok: true,
      action: action.type,
      state: conversation.snapshot(),
    });
    handleConversationAction(action, turn);
  }

  function responseFailureMessage(response = {}) {
    const status = cleanText(response.status).toLowerCase();
    if (!status || status === 'completed') return '';
    return cleanText(
      response.status_details?.error?.message
      || response.status_details?.reason
      || `OpenAI response ended with status ${status}.`,
    );
  }

  function recoverFailedResponse(purpose, response) {
    const message = responseFailureMessage(response);
    if (!message) return false;
    reportError(new Error(message));

    if (purpose?.kind === 'analysis') {
      const turn = purpose.turn;
      if (turn && turn.attempt < MAX_ANALYSIS_RETRIES) {
        turn.attempt += 1;
        requestAnalysis(turn);
      } else {
        requestSpeech(conversation.bareQuestion(), { turn });
      }
      return true;
    }

    if (purpose?.kind === 'speech' && purpose.retryCount < MAX_SPEECH_RETRIES) {
      requestSpeech(purpose.expectedSpeech, {
        after: purpose.after,
        turn: purpose.turn,
        retryCount: purpose.retryCount + 1,
      });
      return true;
    }

    if (purpose?.after === 'submit') {
      requestSpeech(SUBMISSION_FAILURE_RESPONSE, { after: 'goodbye', turn: purpose.turn });
      return true;
    }

    if (purpose?.after === 'goodbye' || purpose?.after === 'complete') {
      if (purpose.after === 'complete') onGoodbyeComplete?.();
      else requestGoodbye();
      return true;
    }

    scheduleIncompleteTurnRecovery(conversation.bareQuestion(), 250);
    return true;
  }

  async function handleResponseComplete(event, purpose) {
    if (!purpose) {
      dispatchCallerTurn();
      return;
    }
    if (purpose.interruptedByCaller) {
      dispatchCallerTurn();
      return;
    }
    if (recoverFailedResponse(purpose, event.response || {})) return;
    if (purpose.kind === 'analysis') {
      handleAnalysisResponse(purpose, event.response || {});
      return;
    }
    if (purpose.kind !== 'speech') {
      dispatchCallerTurn();
      return;
    }
    if (purpose.after === 'submit') {
      await submitEstimate(purpose.turn);
      return;
    }
    if (purpose.after === 'goodbye') {
      requestGoodbye();
      return;
    }
    if (purpose.after === 'complete') {
      onGoodbyeComplete?.();
      return;
    }
    dispatchCallerTurn();
    const estimatedPlaybackEndAt = purpose.firstAudioAt && purpose.audioBytes
      ? purpose.firstAudioAt + Math.ceil((purpose.audioBytes / PCMU_BYTES_PER_SECOND) * 1_000)
      : Date.now();
    receptionistPlaybackEndAt = Math.max(receptionistPlaybackEndAt, estimatedPlaybackEndAt);
    scheduleCallerSilenceRecovery(recoveryDelayMs);
  }

  openai.on('open', () => {
    if (!closed) sendSessionUpdate();
  });

  openai.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.type === 'error') {
      const error = new Error(event.error?.message || 'OpenAI Realtime returned an error.');
      error.code = event.error?.code || event.error?.type || '';
      const requestEventId = cleanText(event.error?.event_id);
      const purpose = responseRequestPurposes.get(requestEventId);
      if (purpose) {
        responseRequestPurposes.delete(requestEventId);
        const pendingIndex = pendingResponsePurposes.indexOf(purpose);
        if (pendingIndex >= 0) pendingResponsePurposes.splice(pendingIndex, 1);
        responseCreationPending = false;
        recoverFailedResponse(purpose, {
          status: 'failed',
          status_details: { error: { message: error.message } },
        });
      } else {
        reportError(error);
      }
      return;
    }
    if (event.type === 'session.updated') {
      ready = true;
      while (pendingAudio.length) {
        sendJson(openai, { type: 'input_audio_buffer.append', audio: pendingAudio.shift() });
      }
      requestGreeting();
      onReady?.({ model, voice: selectedVoice() });
      return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      callerSpeechActive = false;
      lastSpeechStoppedAt = Date.now();
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      callerSpeechActive = true;
      clearIncompleteTurnRecovery();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      reportError(new Error(
        event.error?.message || 'Caller audio transcription failed.',
      ));
      const retry = receptionistIsSpeakingOrPlaying()
        ? conversation.bareQuestion()
        : `${UNCLEAR_CALLER_RESPONSE} ${conversation.bareQuestion()}`;
      scheduleIncompleteTurnRecovery(
        retry,
        recoveryDelayMs,
      );
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const callerTranscript = cleanText(event.transcript);
      if (!callerTranscript) {
        const retry = receptionistIsSpeakingOrPlaying()
          ? conversation.bareQuestion()
          : `${UNCLEAR_CALLER_RESPONSE} ${conversation.bareQuestion()}`;
        scheduleIncompleteTurnRecovery(
          retry,
          recoveryDelayMs,
        );
        return;
      }
      interruptForCallerTranscript(callerTranscript);
      conversation.recordCallerTranscript(callerTranscript);
      emitTranscript('caller', callerTranscript, { itemId: cleanText(event.item_id) });
      queueCallerTurn(callerTranscript, event.item_id);
      dispatchCallerTurn();
      return;
    }
    if (event.type === 'response.created') {
      responseCreationPending = false;
      const responseId = cleanText(event.response?.id);
      const purpose = pendingResponsePurposes.shift() || null;
      if (purpose?.requestEventId) responseRequestPurposes.delete(purpose.requestEventId);
      if (responseId) {
        activeResponseIds.add(responseId);
        responsePurposes.set(responseId, purpose);
      }
      responseCount += 1;
      if (!costLimitTriggered && responseCount >= controls.maxResponsesPerCall) {
        costLimitTriggered = true;
        onCostLimit?.({
          reason: 'response-limit',
          responseCount,
          maximumResponses: controls.maxResponsesPerCall,
        });
      }
      return;
    }
    if (event.type === 'response.output_audio_transcript.delta') {
      const key = assistantTranscriptKey(event);
      assistantTranscriptDeltas.set(
        key,
        `${assistantTranscriptDeltas.get(key) || ''}${event.delta || ''}`,
      );
      return;
    }
    if (event.type === 'response.output_audio_transcript.done') {
      const key = assistantTranscriptKey(event);
      emitTranscript(
        'receptionist',
        event.transcript || assistantTranscriptDeltas.get(key),
        {
          itemId: cleanText(event.item_id),
          responseId: cleanText(event.response_id),
        },
      );
      assistantTranscriptDeltas.delete(key);
      return;
    }
    if (event.type === 'response.output_audio.delta' && event.delta) {
      const purpose = responsePurposes.get(cleanText(event.response_id));
      if (purpose) {
        try { purpose.audioBytes += Buffer.from(event.delta, 'base64').length; } catch {}
      }
      if (purpose && !purpose.firstAudioAt) {
        purpose.firstAudioAt = Date.now();
        if (purpose.turn) {
          onLatency?.({
            speechStoppedToTranscriptMs: purpose.turn.speechStoppedAt
              ? Math.max(0, purpose.turn.transcriptionAt - purpose.turn.speechStoppedAt)
              : null,
            speechStoppedToFirstAudioMs: purpose.turn.speechStoppedAt
              ? Math.max(0, purpose.firstAudioAt - purpose.turn.speechStoppedAt)
              : null,
            callerTranscriptToFirstAudioMs: Math.max(
              0,
              purpose.firstAudioAt - purpose.turn.transcriptionAt,
            ),
            analysisMs: purpose.turn.analysisDoneAt && purpose.turn.analysisRequestedAt
              ? Math.max(0, purpose.turn.analysisDoneAt - purpose.turn.analysisRequestedAt)
              : null,
            speechGenerationMs: Math.max(0, purpose.firstAudioAt - purpose.requestedAt),
            responseKind: purpose.kind,
          });
        }
      }
      if (purpose?.firstAudioAt && purpose.audioBytes) {
        receptionistPlaybackEndAt = Math.max(
          receptionistPlaybackEndAt,
          purpose.firstAudioAt
            + Math.ceil((purpose.audioBytes / PCMU_BYTES_PER_SECOND) * 1_000),
        );
      }
      onAudio?.(event.delta);
      return;
    }
    if (event.type === 'response.done') {
      const responseId = cleanText(event.response?.id);
      const purpose = responsePurposes.get(responseId) || null;
      responsePurposes.delete(responseId);
      activeResponseIds.delete(responseId);
      captureResponseTranscripts(event.response);
      usageSummary = addResponseUsage(usageSummary, event.response?.usage, model);
      if (event.response?.usage) onUsage?.({ ...usageSummary });
      work = work
        .then(() => handleResponseComplete(event, purpose))
        .catch(reportError);
    }
  });

  openai.on('error', reportError);
  openai.on('close', (code, reasonBuffer) => {
    ready = false;
    if (!closed) {
      const reason = cleanText(reasonBuffer?.toString());
      reportError(new Error(`OpenAI Realtime closed (${code})${reason ? `: ${reason}` : ''}`));
    }
  });

  return Object.freeze({
    appendCallerAudio(base64Pcmu) {
      const audio = cleanText(base64Pcmu);
      if (!audio || closed || endingCall) return false;
      if (ready && sendJson(openai, { type: 'input_audio_buffer.append', audio })) return true;
      if (pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) pendingAudio.push(audio);
      return false;
    },

    close() {
      if (closed) return;
      closed = true;
      ready = false;
      clearIncompleteTurnRecovery();
      pendingAudio.length = 0;
      pendingCallerTurns.length = 0;
      pendingResponsePurposes.length = 0;
      responseRequestPurposes.clear();
      pendingCallerFragment = '';
      try { openai.close(); } catch {}
    },

    snapshot() {
      return {
        ready,
        submitted,
        finalizing,
        endingCall,
        responseCount,
        queuedCallerTurns: pendingCallerTurns.length,
        state: conversation.snapshot(),
        usage: { ...usageSummary },
        intake: intake.snapshot(),
      };
    },
  });
}
