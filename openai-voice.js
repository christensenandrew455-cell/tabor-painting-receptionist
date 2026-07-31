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
  onReady,
  onError,
  silenceMs = TURN.silenceMs,
  prefixPaddingMs = TURN.prefixPaddingMs,
} = {}) {
  const pendingAudio = [];
  let closed = false;
  let ready = false;

  // The Realtime API is GA. Sending the retired OpenAI-Beta header causes the
  // server to close the socket before any caller audio can be transcribed.
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODELS.transcription)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    },
  );

  ws.on('open', () => {
    if (closed) return;
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            noise_reduction: { type: 'near_field' },
            transcription: {
              model: MODELS.transcription,
              language: 'en',
              prompt: 'A caller speaking with a residential painting company receptionist.',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.65,
              prefix_padding_ms: Number(prefixPaddingMs) || TURN.prefixPaddingMs,
              silence_duration_ms: Number(silenceMs) || TURN.silenceMs,
              create_response: false,
              interrupt_response: false,
            },
          },
        },
      },
    });
  });

  ws.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }

    if (event.type === 'error') {
      return onError?.(new Error(event.error?.message || 'Transcription error'));
    }

    if (event.type === 'session.updated' || event.type === 'transcription_session.updated') {
      ready = true;
      onReady?.(event.session || {});
      pendingAudio.splice(0).forEach((audio) => {
        sendJson(ws, { type: 'input_audio_buffer.append', audio });
      });
      return;
    }

    if (event.type === 'input_audio_buffer.speech_started') return onSpeechStarted?.();
    if (event.type === 'input_audio_buffer.speech_stopped') return onSpeechStopped?.();
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript || '').trim();
      if (transcript) onTranscript?.(transcript);
    }
  });

  ws.on('error', (error) => onError?.(error));
  ws.on('close', (code, reasonBuffer) => {
    if (closed) return;
    const reason = String(reasonBuffer || '').trim();
    onError?.(new Error(`Transcription socket closed (${code})${reason ? `: ${reason}` : ''}`));
  });

  return {
    append(base64Pcmu) {
      if (closed || !base64Pcmu) return false;
      if (ready && sendJson(ws, { type: 'input_audio_buffer.append', audio: base64Pcmu })) return true;
      if (pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) pendingAudio.push(base64Pcmu);
      return false;
    },
    close() {
      closed = true;
      ready = false;
      pendingAudio.length = 0;
      try { ws.close(); } catch {}
    },
    get ready() {
      return ready && ws.readyState === WebSocket.OPEN;
    },
  };
}

export async function synthesizePcmu(text, { voice = MODELS.voice, speed = 1 } = {}) {
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
      instructions: 'Speak clearly, warmly, and naturally for a telephone call. Avoid exaggerated emotion.',
      response_format: 'pcm',
      speed: Math.max(0.25, Math.min(1.5, Number(speed) || 1)),
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`TTS failed: ${response.status} ${await response.text()}`);

  const pcm24k = Buffer.from(await response.arrayBuffer());
  if (pcm24k.length < 2 || pcm24k.length % 2 !== 0) {
    throw new Error(`TTS returned invalid 16-bit PCM audio (${pcm24k.length} bytes).`);
  }
  return splitPcmuFrames(pcm24kToPcmu8k(pcm24k));
}
