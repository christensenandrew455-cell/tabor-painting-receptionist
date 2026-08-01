import { WebSocket } from 'ws';
import { MODELS, TURN } from './modular-models.js';
import { splitPcmuFrames } from './audio-codec.js';

const MAX_PENDING_AUDIO_CHUNKS = 250;

function sendJson(ws, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
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
  const pendingSpeech = [];
  const speechRequests = new Map();
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

  function rejectSpeechRequests(error) {
    for (const request of speechRequests.values()) request.reject(error);
    speechRequests.clear();
    while (pendingSpeech.length) pendingSpeech.shift().reject(error);
  }

  function startSpeechRequest(request) {
    speechRequests.set(request.id, request);
    const sent = sendJson(ws, {
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['audio'],
        metadata: { speech_request_id: request.id },
        instructions: [
          'Speak only the exact text below.',
          'Do not add, remove, paraphrase, answer, or comment on it.',
          'Speak clearly, warmly, and naturally for a telephone call.',
          `TEXT: ${request.text}`,
        ].join('\n'),
        max_output_tokens: 512,
      },
    });
    if (!sent) {
      speechRequests.delete(request.id);
      request.reject(new Error('Realtime voice socket is not open.'));
    }
  }

  function flushPending() {
    pendingAudio.splice(0).forEach((audio) => sendJson(ws, { type: 'input_audio_buffer.append', audio }));
    pendingSpeech.splice(0).forEach(startSpeechRequest);
  }

  ws.on('open', () => {
    if (closed) return;
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: MODELS.realtime,
        output_modalities: ['audio'],
        instructions: 'Act only as an exact telephone voice transport. Never invent caller speech and never answer unless the application supplies exact response text.',
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
      const error = new Error(event.error?.message || 'Realtime voice error');
      error.code = event.error?.code || event.error?.type || '';
      rejectSpeechRequests(error);
      reportError(error);
      return;
    }
    if (event.type === 'session.updated') {
      ready = true;
      onReady?.({ ...event.session, realtimeVoiceModel: MODELS.realtime, transcriptionModel: MODELS.transcription });
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
    if (event.type === 'response.output_audio.delta') {
      const request = [...speechRequests.values()].find((item) => item.responseId === event.response_id)
        || [...speechRequests.values()].find((item) => !item.responseId);
      if (!request || !event.delta) return;
      if (event.response_id && !request.responseId) request.responseId = event.response_id;
      request.audio.push(Buffer.from(event.delta, 'base64'));
      return;
    }
    if (event.type === 'response.created') {
      const request = [...speechRequests.values()].find((item) => !item.responseId);
      if (request) request.responseId = event.response?.id || '';
      return;
    }
    if (event.type === 'response.done') {
      const responseId = event.response?.id || '';
      const entry = [...speechRequests.entries()].find(([, request]) => request.responseId === responseId);
      if (!entry) return;
      const [requestId, request] = entry;
      speechRequests.delete(requestId);
      if (event.response?.status !== 'completed') return request.reject(new Error(`Realtime speech response ${event.response?.status || 'failed'}.`));
      const pcmu = Buffer.concat(request.audio);
      if (!pcmu.length) return request.reject(new Error('Realtime speech returned no audio.'));
      request.resolve(splitPcmuFrames(pcmu));
    }
  });

  ws.on('error', (error) => {
    rejectSpeechRequests(error);
    reportError(error, { terminal: true });
  });
  ws.on('close', (code, reasonBuffer) => {
    ready = false;
    const reason = String(reasonBuffer || '').trim();
    const error = new Error(`Realtime voice socket closed (${code})${reason ? `: ${reason}` : ''}`);
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
    synthesize(text) {
      const value = String(text || '').trim();
      if (!value) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        const request = { id: `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`, text: value, audio: [], responseId: '', resolve, reject };
        if (ready) startSpeechRequest(request);
        else pendingSpeech.push(request);
      });
    },
    cancelSpeech() {
      for (const request of speechRequests.values()) {
        if (request.responseId) sendJson(ws, { type: 'response.cancel', response_id: request.responseId });
        request.reject(new Error('Realtime speech cancelled.'));
      }
      speechRequests.clear();
      while (pendingSpeech.length) pendingSpeech.shift().reject(new Error('Realtime speech cancelled.'));
    },
    close() {
      closed = true;
      ready = false;
      pendingAudio.length = 0;
      rejectSpeechRequests(new Error('Realtime voice session closed.'));
      try { ws.close(); } catch {}
    },
    get ready() {
      return ready && ws.readyState === WebSocket.OPEN;
    },
  };
}
