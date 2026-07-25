import { WebSocket } from 'ws';

const SILENCE_REASK_DELAY_MS = 5000;
const PCMU_BYTES_PER_MS = 8;
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
      responseCount: 0,
      nextResponse: null,
      currentResponse: null,
      freshMeaningfulTranscript: false,
      awaitingCaller: false,
      speechInProgress: false,
      reaskTimer: null,
      lastAssistantText: '',
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

export function identifyReceptionistInOpeningInstructions(instructions) {
  const raw = clean(instructions);
  if (!raw || /\bthe receptionist\b/i.test(raw)) return raw;
  return raw.replace(
    /(\bhi,?\s+this is\s+)([^".!?]+?)(\s+with\s+)/i,
    '$1$2, the receptionist$3',
  );
}

function quotedSpeech(instructions) {
  const raw = clean(instructions);
  const quoted = [...raw.matchAll(/"([^"\n]+)"/g)]
    .map((match) => clean(match[1]))
    .filter(Boolean);
  return quoted.join(' ');
}

export function extractLastQuestion(value) {
  const text = clean(value);
  const questions = text.match(/[^.!?]*\?/g) || [];
  return clean(questions.at(-1));
}

export function extractOpeningQuestion(instructions) {
  return extractLastQuestion(quotedSpeech(instructions) || instructions);
}

export function buildSilenceReask(value) {
  const source = clean(value);
  const question = extractLastQuestion(source);
  const normalized = (question || source).toLowerCase().replace(/\s+/g, ' ');

  let simplified = '';
  if (/estimate/.test(normalized) && /(set up|schedule|want|like)/.test(normalized)) {
    simplified = 'Would you like to set up an estimate?';
  } else if (/(first and last name|full name)/.test(normalized)) {
    simplified = 'What is your first and last name?';
  } else if (/what service|service would you like|service do you need/.test(normalized)) {
    simplified = 'What service do you need?';
  } else if (/(town or city|city or town)/.test(normalized)) {
    simplified = 'What town or city is the project in?';
  } else if (/street address|project address/.test(normalized)) {
    simplified = "What is the project's street address?";
  } else if (/(best way.*contact|call or text|contact method)/.test(normalized)) {
    simplified = 'Would you prefer a call or a text?';
  } else if (/what day|day would work|preferred.*day/.test(normalized)) {
    simplified = 'What day works best for the estimate?';
  } else if (/what time|time would work|preferred.*time/.test(normalized)) {
    simplified = 'What time works best for the estimate?';
  } else if (/anything else/.test(normalized)) {
    simplified = 'Is there anything else you would like the business to know?';
  } else if (/(is all of that correct|is that correct|does that sound correct)/.test(normalized)) {
    simplified = 'Is that information correct?';
  } else if (/(agree to be contacted|contact consent)/.test(normalized)) {
    simplified = question || 'Do you agree to be contacted by the business?';
  } else if (/do you have any questions/.test(normalized)) {
    simplified = 'Do you have any questions?';
  } else if (question) {
    simplified = question;
  } else {
    simplified = 'Are you still there?';
  }

  return `I'm sorry, I didn't get that. ${simplified}`;
}

export function responseReaskDelayMs({ audioBytes = 0, audioStartedAt = 0, now = Date.now() } = {}) {
  const totalAudioMs = Math.max(0, Number(audioBytes) || 0) / PCMU_BYTES_PER_MS;
  const elapsedSinceAudioStarted = audioStartedAt ? Math.max(0, now - audioStartedAt) : 0;
  const remainingPlaybackMs = Math.max(0, totalAudioMs - elapsedSinceAudioStarted);
  return Math.ceil(remainingPlaybackMs + SILENCE_REASK_DELAY_MS);
}

export const openingReaskDelayMs = responseReaskDelayMs;

function clearReask(state) {
  if (state.reaskTimer) clearTimeout(state.reaskTimer);
  state.reaskTimer = null;
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

function assistantTextFromResponse(message) {
  const parts = [];
  const output = message?.response?.output || message?.output || [];
  for (const item of output) {
    for (const content of item?.content || []) {
      const text = clean(content?.transcript || content?.text);
      if (text) parts.push(text);
    }
  }
  return clean(parts.join(' '));
}

function shouldScheduleReask(text, instructions) {
  const combined = clean(`${text} ${instructions}`);
  if (!combined || /\bgoodbye\b|\bend (?:this|the) call\b/i.test(combined)) return false;
  return Boolean(extractLastQuestion(text) || /\bask\b[\s\S]*\bwait\b/i.test(instructions));
}

function scheduleReask(socket, state, response) {
  clearReask(state);
  if (!response || response.isSilenceReask || response.callerAnswered || state.speechInProgress) return;

  const assistantText = clean(
    response.transcript
      || assistantTextFromResponse(response.doneMessage)
      || quotedSpeech(response.instructions)
      || response.instructions,
  );
  if (!shouldScheduleReask(assistantText, response.instructions)) return;

  state.lastAssistantText = assistantText;
  state.awaitingCaller = true;
  const delay = responseReaskDelayMs({
    audioBytes: response.audioBytes,
    audioStartedAt: response.audioStartedAt,
  });

  state.reaskTimer = setTimeout(() => {
    state.reaskTimer = null;
    if (!state.awaitingCaller || state.speechInProgress || socket.readyState !== WebSocket.OPEN) return;

    const spokenLine = buildSilenceReask(state.lastAssistantText);
    state.awaitingCaller = false;
    state.nextResponse = {
      instructions: `Say exactly this and nothing else: ${JSON.stringify(spokenLine)} Then stop and wait. Do not add reassurance, filler, or the next intake question.`,
      isSilenceReask: true,
    };
    originalSend.call(socket, JSON.stringify({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions: state.nextResponse.instructions,
      },
    }));
    console.log('[Silence turn guard]', {
      action: 'sent deterministic silence re-ask',
      delayMs: delay,
      line: spokenLine,
    });
  }, delay);
}

function rescheduleAfterNoise(socket, state) {
  if (!state.awaitingCaller || state.speechInProgress || state.reaskTimer || !state.lastAssistantText) return;
  const response = {
    transcript: state.lastAssistantText,
    instructions: '',
    audioBytes: 0,
    audioStartedAt: 0,
    isSilenceReask: false,
    callerAnswered: false,
  };
  scheduleReask(socket, state, response);
}

WebSocket.prototype.send = function guardedSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return originalSend.call(this, data, ...args);

  const message = parseJson(data);
  if (message?.type !== 'response.create') return originalSend.call(this, data, ...args);

  const state = stateFor(this);
  let responseInstructions = clean(message?.response?.instructions);

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
  }

  clearReask(state);
  state.awaitingCaller = false;

  let outgoingData = data;
  if (state.responseCount === 0 && responseInstructions) {
    const adjusted = identifyReceptionistInOpeningInstructions(responseInstructions);
    if (adjusted !== responseInstructions) {
      const adjustedMessage = {
        ...message,
        response: { ...message.response, instructions: adjusted },
      };
      outgoingData = JSON.stringify(adjustedMessage);
      responseInstructions = adjusted;
      console.log('[Silence turn guard]', { action: 'identified opening speaker as receptionist' });
    }
  }

  state.nextResponse = {
    instructions: responseInstructions,
    isSilenceReask: false,
  };
  return originalSend.call(this, outgoingData, ...args);
};

WebSocket.prototype.emit = function guardedEmit(eventName, ...args) {
  if (eventName === 'message' && isOpenAiRealtimeSocket(this) && args[0]) {
    const message = parseJson(args[0]);
    const state = stateFor(this);

    if (message?.type === 'input_audio_buffer.speech_started') {
      state.speechInProgress = true;
      clearReask(state);
    }

    if (message?.type === 'input_audio_buffer.speech_stopped') {
      state.speechInProgress = false;
    }

    if (message?.type === 'conversation.item.input_audio_transcription.completed') {
      state.speechInProgress = false;
      if (hasMeaningfulTranscript(message.transcript)) {
        state.freshMeaningfulTranscript = true;
        state.awaitingCaller = false;
        if (state.currentResponse) state.currentResponse.callerAnswered = true;
        clearReask(state);
      } else {
        console.log('[Silence turn guard]', {
          action: 'ignored empty or filler-only transcription',
          transcript: clean(message.transcript),
        });
        rescheduleAfterNoise(this, state);
      }
    }

    if (message?.type === 'conversation.item.input_audio_transcription.failed') {
      state.speechInProgress = false;
      rescheduleAfterNoise(this, state);
    }

    if (message?.type === 'response.created') {
      clearReask(state);
      state.awaitingCaller = false;
      state.responseCount += 1;
      state.currentResponse = {
        instructions: state.nextResponse?.instructions || '',
        isSilenceReask: state.nextResponse?.isSilenceReask === true,
        transcript: '',
        audioBytes: 0,
        audioStartedAt: 0,
        callerAnswered: false,
        doneMessage: null,
      };
      state.nextResponse = null;
    }

    if (state.currentResponse && (
      message?.type === 'response.audio.delta'
      || message?.type === 'response.output_audio.delta'
    )) {
      const audio = clean(message.delta || message.audio);
      if (audio) {
        if (!state.currentResponse.audioStartedAt) state.currentResponse.audioStartedAt = Date.now();
        try {
          state.currentResponse.audioBytes += Buffer.from(audio, 'base64').length;
        } catch {
          // The five-second wait still applies if audio accounting fails.
        }
      }
    }

    if (state.currentResponse && (
      message?.type === 'response.audio_transcript.delta'
      || message?.type === 'response.output_audio_transcript.delta'
    )) {
      state.currentResponse.transcript += String(message.delta || '');
    }

    if (state.currentResponse && (
      message?.type === 'response.audio_transcript.done'
      || message?.type === 'response.output_audio_transcript.done'
    )) {
      state.currentResponse.transcript = clean(message.transcript) || state.currentResponse.transcript;
    }

    if (message?.type === 'response.done' && state.currentResponse) {
      const completed = state.currentResponse;
      completed.doneMessage = message;
      state.currentResponse = null;
      scheduleReask(this, state, completed);
    }

    if (message?.type === 'response.cancelled') {
      state.currentResponse = null;
      clearReask(state);
    }
  }

  return originalEmit.call(this, eventName, ...args);
};

console.log('[Silence turn guard]', {
  enabled: true,
  reaskSeconds: SILENCE_REASK_DELAY_MS / 1000,
  behavior: 'blocks empty turns and uses one deterministic re-ask after unanswered questions',
});
