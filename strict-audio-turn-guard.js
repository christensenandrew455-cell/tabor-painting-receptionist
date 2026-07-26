import { WebSocket } from 'ws';

export const STRICT_VAD_THRESHOLD = 0.86;
export const STRICT_SILENCE_DURATION_MS = 2000;
export const MIN_MEANINGFUL_AUDIO_MS = 320;

const originalSend = WebSocket.prototype.send;
const originalEmit = WebSocket.prototype.emit;
const socketStates = new WeakMap();

const NOISE_ONLY_TOKENS = new Set([
  'ah', 'er', 'erm', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'uh', 'uhh', 'um', 'umm',
  'noise', 'silence', 'static', 'breathing', 'inaudible', 'music', 'background',
]);

const INCOMPLETE_ENDING_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'at', 'because', 'but', 'can', 'could', 'did', 'do', 'does',
  'for', 'from', 'how', 'i', "i'd", "i'll", "i'm", "i've", 'if', 'in', 'is', 'it',
  'like', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then', 'they',
  'this', 'to', 'was', 'we', "we're", 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', "you're", 'your',
]);

const FORBIDDEN_REASSURANCE_PATTERN = /\b(?:take your time|no rush|whenever you(?:'re| are) ready|i(?:'m| am) still here|i(?:'ll| will) wait for you|go ahead when you(?:'re| are) ready|take all the time you need|feel free to take your time)\b/i;

const ALLOWED_OVERLAP_PATTERNS = [
  /^(?:yes|yeah|yep|yup|correct|right|that(?:'s| is) correct|sounds right|okay|ok)(?:[.!?])?$/i,
  /^(?:no|nope|not yet)(?:[.!?])?$/i,
  /^(?:wait|wait a second|wait a minute|hold on|hang on|one second|one moment|give me (?:a|one) (?:second|minute|moment))(?:[.!?])?$/i,
  /^(?:stop|stop talking|pause)(?:[.!?])?$/i,
  /^(?:repeat(?: that)?|say that again|can you repeat that|what did you say)(?:[.!?])?$/i,
  /^(?:cancel(?: the)?(?: estimate| request)?|cancel it|forget the estimate|i changed my mind|i don(?:'t| not) want to continue)(?:[.!?])?$/i,
];

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
      assistantActive: false,
      overlapSpeech: false,
      speechStartedAt: 0,
      speechStartedDuringAssistant: false,
      overlapItems: new Map(),
      turnDurations: new Map(),
      allowNaturalResponse: false,
      assistantTranscript: '',
      forbiddenResponse: false,
    });
  }
  return socketStates.get(socket);
}

function transcriptTokens(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9'\-\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

export function isAllowedOverlapInterruption(value = '') {
  const text = clean(value).replace(/\s+/g, ' ');
  if (!text || transcriptTokens(text).length > 8) return false;
  return ALLOWED_OVERLAP_PATTERNS.some((pattern) => pattern.test(text));
}

export function isStrictMeaningfulTranscript(value = '', durationMs = 0) {
  const raw = clean(value).toLowerCase();
  const tokens = transcriptTokens(raw);
  if (!raw || !tokens.length) return false;
  if (/^\[(?:noise|silence|music|static|breathing|inaudible)\]$/i.test(raw)) return false;
  if (tokens.every((token) => NOISE_ONLY_TOKENS.has(token))) return false;
  if (/[-–—,]\s*$/.test(raw)) return false;
  if (!/[.!?]["']?$/.test(raw) && INCOMPLETE_ENDING_TOKENS.has(tokens.at(-1))) return false;

  const shortControlAnswer = /^(?:yes|yeah|yep|yup|no|nope|okay|ok|correct|right)$/i.test(raw);
  if (!shortControlAnswer && Number(durationMs || 0) < MIN_MEANINGFUL_AUDIO_MS) return false;
  return true;
}

export function containsForbiddenReassurance(value = '') {
  return FORBIDDEN_REASSURANCE_PATTERN.test(clean(value));
}

export function applyStrictSessionSettings(message = {}) {
  if (message?.type !== 'session.update' || !message.session) return message;

  const session = { ...message.session };
  const audio = { ...(session.audio || {}) };
  const input = { ...(audio.input || {}) };
  const turnDetection = { ...(input.turn_detection || {}) };

  turnDetection.type = 'server_vad';
  turnDetection.threshold = Math.max(Number(turnDetection.threshold || 0), STRICT_VAD_THRESHOLD);
  turnDetection.prefix_padding_ms = Math.max(Number(turnDetection.prefix_padding_ms || 0), 300);
  turnDetection.silence_duration_ms = Math.max(
    Number(turnDetection.silence_duration_ms || 0),
    STRICT_SILENCE_DURATION_MS,
  );
  turnDetection.create_response = false;
  turnDetection.interrupt_response = false;
  delete turnDetection.idle_timeout_ms;

  input.noise_reduction = { type: 'far_field' };
  input.turn_detection = turnDetection;
  audio.input = input;
  session.audio = audio;

  const strictRules = [
    'STRICT AUDIO TURN RULES',
    '- Never say "take your time," "no rush," "whenever you are ready," or any similar reassurance.',
    '- If the caller has not finished a complete thought, say nothing and keep listening.',
    '- Do not respond to background conversation, static, breathing, music, filler-only sounds, or unintelligible audio.',
    '- The only permitted delayed filler is the separately controlled short thinking cue. Do not invent another filler sentence.',
  ].join('\n');

  const instructions = clean(session.instructions);
  if (!/STRICT AUDIO TURN RULES/i.test(instructions)) {
    session.instructions = `${instructions}\n\n${strictRules}`.trim();
  }

  return { ...message, session };
}

function deleteConversationItem(socket, itemId) {
  if (!itemId || socket.readyState !== WebSocket.OPEN) return;
  originalSend.call(socket, JSON.stringify({
    type: 'conversation.item.delete',
    item_id: itemId,
  }));
}

function syntheticCancelled(socket, reason) {
  queueMicrotask(() => {
    originalEmit.call(
      socket,
      'message',
      Buffer.from(JSON.stringify({ type: 'response.cancelled', reason })),
      false,
    );
  });
}

function blockForbiddenResponse(socket, state) {
  if (state.forbiddenResponse) return;
  state.forbiddenResponse = true;
  state.allowNaturalResponse = false;
  if (socket.readyState === WebSocket.OPEN) {
    originalSend.call(socket, JSON.stringify({ type: 'response.cancel' }));
  }
  syntheticCancelled(socket, 'forbidden-reassurance');
  console.log('[Strict audio turn guard]', {
    action: 'cancelled forbidden reassurance response',
    transcript: state.assistantTranscript,
  });
}

WebSocket.prototype.send = function strictAudioTurnSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return originalSend.call(this, data, ...args);

  const message = parseJson(data);
  if (!message) return originalSend.call(this, data, ...args);
  const state = stateFor(this);

  if (message.type === 'session.update') {
    const configured = applyStrictSessionSettings(message);
    console.log('[Strict audio turn guard]', {
      enabled: true,
      vadThreshold: configured.session.audio.input.turn_detection.threshold,
      silenceMs: configured.session.audio.input.turn_detection.silence_duration_ms,
      noiseReduction: configured.session.audio.input.noise_reduction.type,
      assistantInterruption: 'transcript whitelist only',
    });
    return originalSend.call(this, JSON.stringify(configured), ...args);
  }

  if (message.type === 'response.create' && !clean(message?.response?.instructions)) {
    if (!state.allowNaturalResponse) {
      console.log('[Strict audio turn guard]', {
        action: 'blocked natural response without a complete meaningful transcript',
      });
      syntheticCancelled(this, 'strict-audio-turn-block');
      const callback = [...args].reverse().find((value) => typeof value === 'function');
      if (callback) queueMicrotask(() => callback());
      return undefined;
    }
    state.allowNaturalResponse = false;
  }

  return originalSend.call(this, data, ...args);
};

WebSocket.prototype.emit = function strictAudioTurnEmit(eventName, ...args) {
  if (eventName !== 'message' || !isOpenAiRealtimeSocket(this) || !args[0]) {
    return originalEmit.call(this, eventName, ...args);
  }

  const message = parseJson(args[0]);
  if (!message) return originalEmit.call(this, eventName, ...args);
  const state = stateFor(this);

  if (message.type === 'response.created') {
    state.assistantActive = true;
    state.assistantTranscript = '';
    state.forbiddenResponse = false;
  }

  if (message.type === 'response.done' || message.type === 'response.cancelled') {
    state.assistantActive = false;
    state.assistantTranscript = '';
    state.forbiddenResponse = false;
  }

  if (message.type === 'input_audio_buffer.speech_started') {
    state.speechStartedAt = Date.now();
    state.speechStartedDuringAssistant = state.assistantActive;
    if (state.assistantActive) {
      state.overlapSpeech = true;
      console.log('[Strict audio turn guard]', {
        action: 'ignored raw sound while receptionist was speaking',
      });
      return false;
    }
  }

  if (message.type === 'input_audio_buffer.speech_stopped') {
    const durationMs = state.speechStartedAt ? Math.max(0, Date.now() - state.speechStartedAt) : 0;
    const itemId = clean(message.item_id);
    if (itemId) state.turnDurations.set(itemId, durationMs);
    state.speechStartedAt = 0;

    if (state.speechStartedDuringAssistant || state.overlapSpeech) {
      if (itemId) state.overlapItems.set(itemId, durationMs);
      state.speechStartedDuringAssistant = false;
      state.overlapSpeech = false;
      return false;
    }
    state.speechStartedDuringAssistant = false;
  }

  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    const itemId = clean(message.item_id);
    const transcript = clean(message.transcript);
    const durationMs = state.turnDurations.get(itemId) || state.overlapItems.get(itemId) || 0;
    state.turnDurations.delete(itemId);

    if (state.overlapItems.has(itemId)) {
      state.overlapItems.delete(itemId);
      if (!isAllowedOverlapInterruption(transcript)) {
        deleteConversationItem(this, itemId);
        console.log('[Strict audio turn guard]', {
          action: 'discarded background or non-whitelisted speech over receptionist',
          transcript,
        });
        return false;
      }
    }

    state.allowNaturalResponse = isStrictMeaningfulTranscript(transcript, durationMs);
    if (!state.allowNaturalResponse) {
      console.log('[Strict audio turn guard]', {
        action: 'classified caller audio as noise, filler, or incomplete speech',
        transcript,
        durationMs,
      });
    }
  }

  if (message.type === 'conversation.item.input_audio_transcription.failed') {
    state.allowNaturalResponse = false;
    console.log('[Strict audio turn guard]', {
      action: 'ignored unintelligible audio instead of answering it',
      error: message.error?.code || message.error?.message || 'transcription-failed',
    });
  }

  if (
    message.type === 'response.audio_transcript.delta'
    || message.type === 'response.output_audio_transcript.delta'
  ) {
    state.assistantTranscript += String(message.delta || '');
    if (containsForbiddenReassurance(state.assistantTranscript)) {
      blockForbiddenResponse(this, state);
      return false;
    }
  }

  if (
    state.forbiddenResponse
    && (message.type === 'response.audio.delta' || message.type === 'response.output_audio.delta')
  ) {
    return false;
  }

  return originalEmit.call(this, eventName, ...args);
};
