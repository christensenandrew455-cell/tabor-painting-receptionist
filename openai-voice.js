import { WebSocket } from 'ws';
import { MODELS, TURN } from './modular-models.js';
import { splitPcmuFrames } from './audio-codec.js';

const MAX_PENDING_AUDIO_CHUNKS = 250;
const TEXT_TIMEOUT_MS = Math.max(1500, Number(process.env.AI_INTERPRETATION_TIMEOUT_MS || 6000));
const SPEECH_TIMEOUT_MS = Math.max(2500, Number(process.env.AI_SPEECH_TIMEOUT_MS || 10000));
const TEXT_ATTEMPTS = Math.max(1, Number(process.env.AI_TEXT_ATTEMPTS || 2));
const SPEECH_ATTEMPTS = Math.max(1, Number(process.env.AI_SPEECH_ATTEMPTS || 2));

function sendJson(ws, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function responseText(response = {}) {
  return (response.output || [])
    .flatMap((item) => item?.content || [])
    .map((content) => content?.text || content?.transcript || '')
    .filter(Boolean)
    .join('')
    .trim();
}

function normalizedSpeechText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function exactSpeechMatches(expected, actual) {
  return normalizedSpeechText(expected) === normalizedSpeechText(actual);
}

function isAssistantLikeTranscript(value) {
  const text = String(value ?? '').trim();
  return /^(?:hello[!.]?\s*)?(?:how can i help(?: you)?(?: today)?|how may i assist(?: you)?|what can i do for you)[?.!\s]*$/i.test(text);
}

export function createRealtimeVoice({
  onTranscript,
  onSpeechStarted,
  onSpeechStopped,
  onReady,
  onError,
  silenceMs = TURN.silenceMs,
  prefixPaddingMs = TURN.prefixPaddingMs,
  voice = MODELS.voice,
  speed = 1,
} = {}) {
  const pendingAudio = [];
  const pendingTextRequests = [];
  const textRequests = new Map();
  const pendingSpeechRequests = [];
  const speechRequests = new Map();
  let closed = false;
  let ready = false;
  let terminalErrorReported = false;
  let nativeTranscriptionBusy = false;
  let committedTurnsWaiting = 0;

  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODELS.realtime)}`,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
  );

  function reportError(error, { terminal = false } = {}) {
    if (terminal && terminalErrorReported) return;
    if (terminal) terminalErrorReported = true;
    onError?.(error);
  }

  function clearTimer(request) {
    if (request?.timer) clearTimeout(request.timer);
    if (request) request.timer = null;
  }

  function requestForEvent(map, event, metadataKey) {
    const responseId = event.response_id || event.response?.id || '';
    if (responseId) {
      const byResponse = [...map.values()].find((request) => request.responseId === responseId);
      if (byResponse) return byResponse;
    }

    const requestId = event.response?.metadata?.[metadataKey]
      || event.metadata?.[metadataKey];
    if (requestId && map.has(requestId)) return map.get(requestId);

    return [...map.values()].find((request) => !request.responseId) || null;
  }

  function rejectTextRequests(error) {
    for (const request of textRequests.values()) {
      clearTimer(request);
      request.reject(error);
    }
    textRequests.clear();
    while (pendingTextRequests.length) {
      const request = pendingTextRequests.shift();
      clearTimer(request);
      request.reject(error);
    }
  }

  function rejectSpeechRequests(error) {
    for (const request of speechRequests.values()) {
      clearTimer(request);
      request.reject(error);
    }
    speechRequests.clear();
    while (pendingSpeechRequests.length) {
      const request = pendingSpeechRequests.shift();
      clearTimer(request);
      request.reject(error);
    }
  }

  function retryTextRequest(request, error) {
    textRequests.delete(request.id);
    clearTimer(request);
    if (!closed && ready && request.attempt < request.maxAttempts) {
      startTextRequest(request);
      return;
    }
    request.reject(error);
  }

  function startTextRequest(request) {
    request.responseId = '';
    request.text = '';
    request.attempt = Number(request.attempt || 0) + 1;
    clearTimer(request);
    textRequests.set(request.id, request);

    request.timer = setTimeout(() => {
      if (!textRequests.has(request.id)) return;
      if (request.responseId) sendJson(ws, { type: 'response.cancel', response_id: request.responseId });
      retryTextRequest(request, new Error(`${request.purpose} timed out.`));
    }, TEXT_TIMEOUT_MS);

    const sent = sendJson(ws, {
      type: 'response.create',
      response: {
        conversation: request.conversation,
        output_modalities: ['text'],
        metadata: {
          text_request_id: request.id,
          text_request_purpose: request.purpose,
        },
        instructions: request.instructions,
        max_output_tokens: request.maxOutputTokens,
      },
    });

    if (!sent) {
      retryTextRequest(request, new Error('Realtime socket is not open.'));
    }
  }

  function requestText(instructions, {
    conversation = 'none',
    purpose = 'Realtime interpretation',
    maxOutputTokens = 350,
    maxAttempts = TEXT_ATTEMPTS,
  } = {}) {
    const value = String(instructions || '').trim();
    if (!value) return Promise.reject(new Error('Realtime text instructions are required.'));

    return new Promise((resolve, reject) => {
      const request = {
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        instructions: value,
        conversation,
        purpose,
        maxOutputTokens,
        maxAttempts,
        attempt: 0,
        responseId: '',
        text: '',
        timer: null,
        resolve,
        reject,
      };
      if (ready) startTextRequest(request);
      else pendingTextRequests.push(request);
    });
  }

  function retrySpeechRequest(request, error) {
    speechRequests.delete(request.id);
    clearTimer(request);
    if (!closed && ready && request.attempt < SPEECH_ATTEMPTS) {
      startSpeechRequest(request);
      return;
    }
    request.reject(error);
  }

  function startSpeechRequest(request) {
    request.audio = [];
    request.spokenTranscript = '';
    request.responseId = '';
    request.attempt = Number(request.attempt || 0) + 1;
    clearTimer(request);
    speechRequests.set(request.id, request);

    request.timer = setTimeout(() => {
      if (!speechRequests.has(request.id)) return;
      if (request.responseId) sendJson(ws, { type: 'response.cancel', response_id: request.responseId });
      retrySpeechRequest(request, new Error('Realtime speech timed out.'));
    }, SPEECH_TIMEOUT_MS);

    const sent = sendJson(ws, {
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['audio'],
        metadata: { speech_request_id: request.id },
        instructions: [
          'You are the telephone voice for a receptionist application.',
          'Speak only the supplied receptionist line.',
          'Do not answer the line, react to it, paraphrase it, explain it, or add advice.',
          'Keep the same words and word order. Natural pronunciation and punctuation are allowed.',
          `RECEPTIONIST LINE: ${JSON.stringify(request.text)}`,
        ].join('\n'),
        max_output_tokens: Math.max(64, Math.min(512, Math.ceil(request.text.length / 2) + 48)),
      },
    });

    if (!sent) {
      retrySpeechRequest(request, new Error('Realtime socket is not open.'));
    }
  }

  function flushPending() {
    pendingAudio.splice(0).forEach((audio) => sendJson(ws, { type: 'input_audio_buffer.append', audio }));
    pendingTextRequests.splice(0).forEach(startTextRequest);
    pendingSpeechRequests.splice(0).forEach(startSpeechRequest);
  }

  function deleteResponseItems(response = {}) {
    for (const item of response.output || []) {
      if (item?.id) sendJson(ws, { type: 'conversation.item.delete', item_id: item.id });
    }
  }

  function runNextNativeTranscription() {
    if (closed || !ready || nativeTranscriptionBusy || committedTurnsWaiting <= 0) return;
    committedTurnsWaiting -= 1;
    nativeTranscriptionBusy = true;

    requestText([
      'Transcribe only the most recent caller audio turn verbatim.',
      'This is transcription, not conversation. Never reply to the caller and never invent a greeting.',
      'Return only the caller words with normal punctuation. Do not explain, summarize, or add labels.',
      "The call is in English. Normalize a short affirmative to 'Yes.' and a short negative to 'No.' even when accent or recognition might otherwise render another language.",
      "If there is no clear caller speech, return exactly: [unintelligible]",
    ].join('\n'), {
      conversation: 'auto',
      purpose: 'Realtime native transcription',
      maxOutputTokens: 120,
      maxAttempts: TEXT_ATTEMPTS,
    })
      .then((transcript) => {
        const value = String(transcript || '').trim();
        if (!value || value === '[unintelligible]' || isAssistantLikeTranscript(value)) return;
        onTranscript?.(value);
      })
      .catch((error) => reportError(error))
      .finally(() => {
        nativeTranscriptionBusy = false;
        runNextNativeTranscription();
      });
  }

  function queueNativeTranscription() {
    committedTurnsWaiting += 1;
    runNextNativeTranscription();
  }

  ws.on('open', () => {
    if (closed) return;
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: MODELS.realtime,
        output_modalities: ['audio'],
        instructions: 'Do not respond automatically. The application will explicitly request transcription, structured interpretation, or caller-facing speech.',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            noise_reduction: { type: 'near_field' },
            transcription: null,
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: Math.max(200, Number(prefixPaddingMs) || 300),
              silence_duration_ms: Math.max(1200, Number(silenceMs) || 1500),
              create_response: false,
              interrupt_response: false,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: String(voice || MODELS.voice).trim() || MODELS.voice,
            speed: Math.max(0.25, Math.min(1.5, Number(speed) || 1)),
          },
        },
        max_output_tokens: 512,
      },
    });
  });

  ws.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }

    if (event.type === 'error') {
      const error = new Error(event.error?.message || 'Realtime error');
      error.code = event.error?.code || event.error?.type || '';
      error.param = event.error?.param || '';
      rejectTextRequests(error);
      rejectSpeechRequests(error);
      reportError(error);
      return;
    }

    if (event.type === 'session.updated') {
      ready = true;
      onReady?.({ ...event.session, realtimeVoiceModel: MODELS.realtime });
      flushPending();
      runNextNativeTranscription();
      return;
    }

    if (event.type === 'input_audio_buffer.speech_started') return onSpeechStarted?.();
    if (event.type === 'input_audio_buffer.speech_stopped') return onSpeechStopped?.();
    if (event.type === 'input_audio_buffer.committed') {
      queueNativeTranscription();
      return;
    }

    if (event.type === 'response.created') {
      const textRequest = requestForEvent(textRequests, event, 'text_request_id');
      if (textRequest) {
        textRequest.responseId = event.response?.id || '';
        return;
      }
      const speechRequest = requestForEvent(speechRequests, event, 'speech_request_id');
      if (speechRequest) speechRequest.responseId = event.response?.id || '';
      return;
    }

    if (event.type === 'response.output_text.delta') {
      const request = requestForEvent(textRequests, event, 'text_request_id');
      if (request && event.delta) request.text += String(event.delta);
      return;
    }

    if (event.type === 'response.output_text.done') {
      const request = requestForEvent(textRequests, event, 'text_request_id');
      if (request && event.text) request.text = String(event.text).trim();
      return;
    }

    if (event.type === 'response.output_audio_transcript.delta') {
      const request = requestForEvent(speechRequests, event, 'speech_request_id');
      if (request && event.delta) request.spokenTranscript += String(event.delta);
      return;
    }

    if (event.type === 'response.output_audio_transcript.done') {
      const request = requestForEvent(speechRequests, event, 'speech_request_id');
      if (request && event.transcript) request.spokenTranscript = String(event.transcript).trim();
      return;
    }

    if (event.type === 'response.output_audio.delta') {
      const request = requestForEvent(speechRequests, event, 'speech_request_id');
      if (!request || !event.delta) return;
      if (event.response_id && !request.responseId) request.responseId = event.response_id;
      request.audio.push(Buffer.from(event.delta, 'base64'));
      return;
    }

    if (event.type === 'response.done') {
      const textRequest = requestForEvent(textRequests, event, 'text_request_id');
      if (textRequest) {
        textRequests.delete(textRequest.id);
        clearTimer(textRequest);

        if (event.response?.status !== 'completed') {
          retryTextRequest(textRequest, new Error(`${textRequest.purpose} ${event.response?.status || 'failed'}.`));
          return;
        }

        const text = String(textRequest.text || responseText(event.response)).trim();
        if (!text) {
          retryTextRequest(textRequest, new Error(`${textRequest.purpose} returned no text.`));
          return;
        }

        if (textRequest.conversation === 'auto') deleteResponseItems(event.response);
        textRequest.resolve(text);
        return;
      }

      const speechRequest = requestForEvent(speechRequests, event, 'speech_request_id');
      if (!speechRequest) return;
      speechRequests.delete(speechRequest.id);
      clearTimer(speechRequest);

      if (event.response?.status !== 'completed') {
        retrySpeechRequest(speechRequest, new Error(`Realtime speech ${event.response?.status || 'failed'}.`));
        return;
      }

      const pcmu = Buffer.concat(speechRequest.audio);
      if (!pcmu.length) {
        retrySpeechRequest(speechRequest, new Error('Realtime speech returned no audio.'));
        return;
      }

      const spokenTranscript = String(speechRequest.spokenTranscript || responseText(event.response)).trim();
      if (spokenTranscript && !exactSpeechMatches(speechRequest.text, spokenTranscript)) {
        console.warn('[Realtime speech wording drift]', JSON.stringify({
          expectedText: speechRequest.text,
          actualText: spokenTranscript,
        }));
      }

      speechRequest.resolve(splitPcmuFrames(pcmu));
    }
  });

  ws.on('error', (error) => {
    rejectTextRequests(error);
    rejectSpeechRequests(error);
    reportError(error, { terminal: true });
  });

  ws.on('close', (code, reasonBuffer) => {
    ready = false;
    const reason = String(reasonBuffer || '').trim();
    const error = new Error(`Realtime socket closed (${code})${reason ? `: ${reason}` : ''}`);
    rejectTextRequests(error);
    rejectSpeechRequests(error);
    if (!closed && !terminalErrorReported) reportError(error, { terminal: true });
  });

  return {
    append(base64Pcmu) {
      if (closed || !base64Pcmu) return false;
      if (ready && sendJson(ws, { type: 'input_audio_buffer.append', audio: base64Pcmu })) return true;
      if (pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) pendingAudio.push(base64Pcmu);
      return false;
    },

    interpret(instructions) {
      return requestText(instructions, {
        conversation: 'none',
        purpose: 'Realtime interpretation',
        maxOutputTokens: 350,
        maxAttempts: TEXT_ATTEMPTS,
      });
    },

    synthesize(text) {
      const value = String(text || '').trim();
      if (!value) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        const request = {
          id: `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          text: value,
          audio: [],
          spokenTranscript: '',
          responseId: '',
          attempt: 0,
          timer: null,
          resolve,
          reject,
        };
        if (ready) startSpeechRequest(request);
        else pendingSpeechRequests.push(request);
      });
    },

    cancelSpeech() {
      for (const request of speechRequests.values()) {
        clearTimer(request);
        if (request.responseId) sendJson(ws, { type: 'response.cancel', response_id: request.responseId });
        request.reject(new Error('Realtime speech cancelled.'));
      }
      speechRequests.clear();
      while (pendingSpeechRequests.length) {
        const request = pendingSpeechRequests.shift();
        clearTimer(request);
        request.reject(new Error('Realtime speech cancelled.'));
      }
    },

    close() {
      closed = true;
      ready = false;
      pendingAudio.length = 0;
      committedTurnsWaiting = 0;
      rejectTextRequests(new Error('Realtime session closed.'));
      rejectSpeechRequests(new Error('Realtime session closed.'));
      try { ws.close(); } catch {}
    },

    get ready() {
      return ready && ws.readyState === WebSocket.OPEN;
    },
  };
}
