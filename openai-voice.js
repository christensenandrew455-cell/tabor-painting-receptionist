import { WebSocket } from 'ws';
import { MODELS, TURN } from './modular-models.js';
import { pcm24kToPcmu8k, splitPcmuFrames } from './audio-codec.js';

const MAX_PENDING_AUDIO_CHUNKS = 250;
const INTERPRETATION_TIMEOUT_MS = Math.max(1000, Number(process.env.AI_INTERPRETATION_TIMEOUT_MS || 5000));
const SPEECH_TIMEOUT_MS = Math.max(2000, Number(process.env.AI_SPEECH_TIMEOUT_MS || 10000));
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
  void silenceMs;
  void prefixPaddingMs;

  const pendingAudio = [];
  const pendingInterpretations = [];
  const interpretationRequests = new Map();
  const activeSpeechControllers = new Set();
  let closed = false;
  let ready = false;
  let terminalErrorReported = false;

  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODELS.realtime)}`,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
  );

  function reportError(error, { terminal = false } = {}) {
    if (terminal && terminalErrorReported) return;
    if (terminal) terminalErrorReported = true;
    onError?.(error);
  }

  function clearInterpretationTimer(request) {
    if (request?.timer) clearTimeout(request.timer);
    if (request) request.timer = null;
  }

  function rejectInterpretations(error) {
    for (const request of interpretationRequests.values()) {
      clearInterpretationTimer(request);
      request.reject(error);
    }
    interpretationRequests.clear();
    while (pendingInterpretations.length) {
      const request = pendingInterpretations.shift();
      clearInterpretationTimer(request);
      request.reject(error);
    }
  }

  function interpretationForEvent(event) {
    const responseId = event.response_id || event.response?.id || '';
    if (responseId) {
      const entry = [...interpretationRequests.values()].find((request) => request.responseId === responseId);
      if (entry) return entry;
    }

    const requestId = event.response?.metadata?.interpretation_request_id
      || event.metadata?.interpretation_request_id;
    if (requestId && interpretationRequests.has(requestId)) return interpretationRequests.get(requestId);

    return [...interpretationRequests.values()].find((request) => !request.responseId) || null;
  }

  function startInterpretation(request) {
    request.responseId = '';
    request.text = '';
    clearInterpretationTimer(request);
    interpretationRequests.set(request.id, request);
    request.timer = setTimeout(() => {
      if (!interpretationRequests.has(request.id)) return;
      interpretationRequests.delete(request.id);
      request.reject(new Error('Realtime interpretation timed out.'));
    }, INTERPRETATION_TIMEOUT_MS);

    const sent = sendJson(ws, {
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        metadata: { interpretation_request_id: request.id },
        instructions: request.instructions,
        max_output_tokens: 350,
      },
    });

    if (!sent) {
      interpretationRequests.delete(request.id);
      clearInterpretationTimer(request);
      request.reject(new Error('Realtime interpreter socket is not open.'));
    }
  }

  function flushPending() {
    pendingAudio.splice(0).forEach((audio) => sendJson(ws, { type: 'input_audio_buffer.append', audio }));
    pendingInterpretations.splice(0).forEach(startInterpretation);
  }

  ws.on('open', () => {
    if (closed) return;
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: MODELS.realtime,
        output_modalities: ['text'],
        instructions: 'Do not respond automatically. When the application requests a turn interpretation, return only the requested compact JSON.',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            noise_reduction: { type: 'near_field' },
            transcription: {
              model: MODELS.transcription,
              language: 'en',
            },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'high',
              create_response: false,
              interrupt_response: false,
            },
          },
        },
        max_output_tokens: 350,
      },
    });
  });

  ws.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }

    if (event.type === 'error') {
      const error = new Error(event.error?.message || 'Realtime interpreter error');
      error.code = event.error?.code || event.error?.type || '';
      error.param = event.error?.param || '';
      rejectInterpretations(error);
      reportError(error);
      return;
    }

    if (event.type === 'session.updated') {
      ready = true;
      onReady?.({
        ...event.session,
        realtimeVoiceModel: MODELS.realtime,
        transcriptionModel: MODELS.transcription,
        speechModel: MODELS.speech,
      });
      flushPending();
      return;
    }

    if (event.type === 'input_audio_buffer.speech_started') return onSpeechStarted?.();
    if (event.type === 'input_audio_buffer.speech_stopped') return onSpeechStopped?.();

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript || '').trim();
      if (transcript) onTranscript?.(transcript);
      return;
    }

    if (event.type === 'response.created') {
      const request = interpretationForEvent(event);
      if (request) request.responseId = event.response?.id || '';
      return;
    }

    if (event.type === 'response.output_text.delta') {
      const request = interpretationForEvent(event);
      if (request && event.delta) request.text += String(event.delta);
      return;
    }

    if (event.type === 'response.output_text.done') {
      const request = interpretationForEvent(event);
      if (request && event.text) request.text = String(event.text).trim();
      return;
    }

    if (event.type === 'response.done') {
      const request = interpretationForEvent(event);
      if (!request) return;
      interpretationRequests.delete(request.id);
      clearInterpretationTimer(request);

      if (event.response?.status !== 'completed') {
        request.reject(new Error(`Realtime interpretation ${event.response?.status || 'failed'}.`));
        return;
      }

      const text = String(request.text || responseText(event.response)).trim();
      if (!text) {
        request.reject(new Error('Realtime interpreter returned no text.'));
        return;
      }
      request.resolve(text);
    }
  });

  ws.on('error', (error) => {
    rejectInterpretations(error);
    reportError(error, { terminal: true });
  });

  ws.on('close', (code, reasonBuffer) => {
    ready = false;
    const reason = String(reasonBuffer || '').trim();
    const error = new Error(`Realtime interpreter socket closed (${code})${reason ? `: ${reason}` : ''}`);
    rejectInterpretations(error);
    if (!closed && !terminalErrorReported) reportError(error, { terminal: true });
  });

  async function synthesizeExactSpeech(text) {
    const controller = new AbortController();
    activeSpeechControllers.add(controller);
    let lastError;

    try {
      for (let attempt = 1; attempt <= SPEECH_ATTEMPTS; attempt += 1) {
        const timeoutSignal = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
        const signal = AbortSignal.any([controller.signal, timeoutSignal]);

        try {
          const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            signal,
            body: JSON.stringify({
              model: MODELS.speech,
              voice: String(voice || MODELS.voice).trim() || MODELS.voice,
              input: String(text),
              instructions: 'Read the input exactly as written. Speak warmly and naturally. Do not add or remove words.',
              response_format: 'pcm',
              speed: Math.max(0.25, Math.min(4, Number(speed) || 1)),
            }),
          });

          if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Speech API failed (${response.status})${body ? `: ${body}` : ''}`);
          }

          const pcm24k = Buffer.from(await response.arrayBuffer());
          const pcmu8k = pcm24kToPcmu8k(pcm24k);
          if (!pcmu8k.length) throw new Error('Speech API returned no audio.');
          return splitPcmuFrames(pcmu8k);
        } catch (error) {
          if (controller.signal.aborted) throw new Error('Speech synthesis cancelled.');
          lastError = error;
          if (attempt >= SPEECH_ATTEMPTS) {
            if (timeoutSignal.aborted) throw new Error('Speech synthesis timed out.');
            throw error;
          }
        }
      }
    } finally {
      activeSpeechControllers.delete(controller);
    }

    throw lastError || new Error('Speech synthesis failed.');
  }

  return {
    append(base64Pcmu) {
      if (closed || !base64Pcmu) return false;
      if (ready && sendJson(ws, { type: 'input_audio_buffer.append', audio: base64Pcmu })) return true;
      if (pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) pendingAudio.push(base64Pcmu);
      return false;
    },

    interpret(instructions) {
      const value = String(instructions || '').trim();
      if (!value) return Promise.reject(new Error('Realtime interpretation instructions are required.'));
      return new Promise((resolve, reject) => {
        const request = {
          id: `interpret_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          instructions: value,
          responseId: '',
          text: '',
          timer: null,
          resolve,
          reject,
        };
        if (ready) startInterpretation(request);
        else pendingInterpretations.push(request);
      });
    },

    synthesize(text) {
      const value = String(text || '').trim();
      if (!value) return Promise.resolve([]);
      return synthesizeExactSpeech(value);
    },

    cancelSpeech() {
      for (const controller of activeSpeechControllers) controller.abort();
      activeSpeechControllers.clear();
    },

    close() {
      closed = true;
      ready = false;
      pendingAudio.length = 0;
      rejectInterpretations(new Error('Realtime interpreter session closed.'));
      for (const controller of activeSpeechControllers) controller.abort();
      activeSpeechControllers.clear();
      try { ws.close(); } catch {}
    },

    get ready() {
      return ready && ws.readyState === WebSocket.OPEN;
    },
  };
}
