import { WebSocket } from 'ws';
import { MODELS, TURN } from './modular-models.js';
import { pcm24kToPcmu8k, splitPcmuFrames } from './audio-codec.js';

const MAX_PENDING_AUDIO_CHUNKS = 250;

function sendJson(ws, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

export function createTranscriber({
  onTranscript,
  onSpeechStarted,
  onSpeechStopped,
  onError,
  silenceMs = TURN.silenceMs,
  prefixPaddingMs = TURN.prefixPaddingMs,
} = {}) {
  const pendingAudio = [];
  let closed = false;
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODELS.transcription)}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  ws.on('open', () => {
    if (closed) return;
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: MODELS.transcription, language: 'en' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.65,
              prefix_padding_ms: Number(prefixPaddingMs) || TURN.prefixPaddingMs,
              silence_duration_ms: Number(silenceMs) || TURN.silenceMs,
            },
          },
        },
      },
    });
    pendingAudio.splice(0).forEach((audio) => {
      sendJson(ws, { type: 'input_audio_buffer.append', audio });
    });
  });

  ws.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }
    if (event.type === 'error') return onError?.(new Error(event.error?.message || 'Transcription error'));
    if (event.type === 'input_audio_buffer.speech_started') return onSpeechStarted?.();
    if (event.type === 'input_audio_buffer.speech_stopped') return onSpeechStopped?.();
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript || '').trim();
      if (transcript) onTranscript?.(transcript);
    }
  });
  ws.on('error', (error) => onError?.(error));

  return {
    append(base64Pcmu) {
      if (closed || !base64Pcmu) return false;
      if (sendJson(ws, { type: 'input_audio_buffer.append', audio: base64Pcmu })) return true;
      if (pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) pendingAudio.push(base64Pcmu);
      return false;
    },
    close() {
      closed = true;
      pendingAudio.length = 0;
      try { ws.close(); } catch {}
    },
    get ready() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}

export async function synthesizePcmu(text, { voice = MODELS.voice } = {}) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODELS.speech,
      voice: String(voice || MODELS.voice).trim() || MODELS.voice,
      input: String(text || '').trim(),
      response_format: 'pcm',
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
  const pcm24k = Buffer.from(await response.arrayBuffer());
  return splitPcmuFrames(pcm24kToPcmu8k(pcm24k));
}
