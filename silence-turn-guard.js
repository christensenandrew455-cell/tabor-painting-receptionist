import { WebSocket } from 'ws';

const OPENING_REASK_DELAY_MS = 5000;
const NOISE_ONLY_TOKENS = new Set([
  'ah', 'er', 'erm', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'uh', 'uhh', 'um', 'umm',
  'noise', 'silence', 'static', 'breathing', 'inaudible',
]);

const originalSend = WebSocket.prototype.send;
const originalEmit = WebSocket.prototype.emit;
const socketState = new WeakMap();

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
  if (!socketState.has(socket)) {
    socketState.set(socket, {
      openingCaptured: false,
      openingQuestion: '',
      collectingOpeningAudio: false,
      openingAudioBytes: 0,
      openingAudioStartedAt: 0,
      freshMeaningfulTranscript: false,
      heardMeaningfulTranscript: false,
      reaskedOpening: false,
      openingReaskTimer: null,
    });
  }
  return socketState.get(socket);
}

export function hasMeaningfulTranscript(value) {
  const normalized = clean(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9'\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some((token) => !NOISE_ONLY_TOKENS.has(token));
}

export function extractOpeningQuestion(instructions) {
  const raw = clean(instructions);
  const quoted = raw.match(/pace:\s*"([\s\S]*?)"\s*Then stop/i)?.[1]
    || raw.match(/exactly[^:]*:\s*"([\s\S]*?)"/i)?.[1]
    || raw;
  const questions = quoted.match(/[^.!?]*\?/g) || [];
  return clean(questions.at(-1));
}

export function openingReaskDelayMs({ audioBytes = 0, audioStartedAt = 0, now = Date.now() } = {}) {
  const totalAudioMs = Math.max(0, Number(audioBytes) || 0) / 8;
  const elapsedSinceAudioStarted = audioStartedAt ? Math.max(0, now - audioStartedAt) : 0;
  const remainingPlaybackMs = Math.max(0, totalAudioMs - elapsedSinceAudioStarted);
  return Math.ceil(remainingPlaybackMs + OPENING_REASK_DELAY_MS);
}

function clearOpeningReask(state) {
  if (state.openingReaskTimer) clearTimeout(state.openingReaskTimer);
  state.openingReaskTimer = null;
}

function syntheticCancelled(socket) {
  queueMicrotask(() => {
    originalEmit.call(
      socket,
      'message',
      Buffer.from(JSON.stringify({ type: 'response.cancelled', reason: 'no-transcribed-words' })),
      false,
    );
  });
}

function acknowledgeBlockedSend(args) {
  const callback = [...args].reverse().find((value) => typeof value === 'function');
  if (callback) queueMicrotask(() => callback());
}

function scheduleOpeningReask(socket, state) {
  clearOpeningReask(state);
  if (!state.openingQuestion || state.reaskedOpening || state.heardMeaningfulTranscript) return;

  const delay = openingReaskDelayMs({
    audioBytes: state.openingAudioBytes,
    audioStartedAt: state.openingAudioStartedAt,
  });

  state.openingReaskTimer = setTimeout(() => {
    state.openingReaskTimer = null;
    if (state.heardMeaningfulTranscript || state.reaskedOpening || socket.readyState !== WebSocket.OPEN) return;
    state.reaskedOpening = true;
    originalSend.call(socket, JSON.stringify({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions: `Say exactly this and nothing else: "${state.openingQuestion}" Then stop and wait. Do not add reassurance, filler, or the next intake question.`,
      },
    }));
    console.log('[Silence turn guard]', {
      action: 'reasked opening estimate question',
      delayMs: delay,
      question: state.openingQuestion,
    });
  }, delay);
}

WebSocket.prototype.send = function guardedSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return originalSend.call(this, data, ...args);

  const message = parseJson(data);
  if (message?.type !== 'response.create') return originalSend.call(this, data, ...args);

  const state = stateFor(this);
  const responseInstructions = clean(message?.response?.instructions);

  if (!state.openingCaptured && responseInstructions) {
    const openingQuestion = extractOpeningQuestion(responseInstructions);
    if (openingQuestion) {
      state.openingCaptured = true;
      state.openingQuestion = openingQuestion;
      state.collectingOpeningAudio = true;
      state.openingAudioBytes = 0;
      state.openingAudioStartedAt = 0;
      state.freshMeaningfulTranscript = false;
    }
    return originalSend.call(this, data, ...args);
  }

  if (!responseInstructions) {
    if (!state.freshMeaningfulTranscript) {
      console.log('[Silence turn guard]', {
        action: 'blocked response without transcribed words',
      });
      acknowledgeBlockedSend(args);
      syntheticCancelled(this);
      return undefined;
    }
    state.freshMeaningfulTranscript = false;
    clearOpeningReask(state);
    return originalSend.call(this, data, ...args);
  }

  state.freshMeaningfulTranscript = false;
  clearOpeningReask(state);
  return originalSend.call(this, data, ...args);
};

WebSocket.prototype.emit = function guardedEmit(eventName, ...args) {
  if (eventName === 'message' && isOpenAiRealtimeSocket(this) && args[0]) {
    const message = parseJson(args[0]);
    const state = stateFor(this);

    if (message?.type === 'conversation.item.input_audio_transcription.completed') {
      if (hasMeaningfulTranscript(message.transcript)) {
        state.freshMeaningfulTranscript = true;
        state.heardMeaningfulTranscript = true;
        clearOpeningReask(state);
      } else {
        console.log('[Silence turn guard]', {
          action: 'ignored empty or filler-only transcription',
          transcript: clean(message.transcript),
        });
      }
    }

    if (state.collectingOpeningAudio && (message?.type === 'response.audio.delta' || message?.type === 'response.output_audio.delta')) {
      const audio = clean(message.delta || message.audio);
      if (audio) {
        if (!state.openingAudioStartedAt) state.openingAudioStartedAt = Date.now();
        try {
          state.openingAudioBytes += Buffer.from(audio, 'base64').length;
        } catch {
          // Ignore malformed audio accounting; the five-second wait still applies.
        }
      }
    }

    if (state.collectingOpeningAudio && message?.type === 'response.done') {
      state.collectingOpeningAudio = false;
      scheduleOpeningReask(this, state);
    }
  }

  return originalEmit.call(this, eventName, ...args);
};

console.log('[Silence turn guard]', {
  enabled: true,
  openingReaskSeconds: OPENING_REASK_DELAY_MS / 1000,
  behavior: 'requires transcribed words before advancing the intake',
});
