import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { Resend } from 'resend';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tabor-painting-receptionist-production.up.railway.app').replace(/\/$/, '');
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Tabor Painting';

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_API_BASE = process.env.TELNYX_API_BASE || 'https://api.telnyx.com/v2';
const STREAM_URL = process.env.TELNYX_STREAM_URL || PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const STREAM_TRACK = process.env.TELNYX_STREAM_TRACK || 'both_tracks';
const STREAM_CODEC = process.env.TELNYX_STREAM_CODEC || 'PCMU';

function normalizeRealtimeModel(value) {
  return String(value || 'gpt-realtime-2')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^gpt-?realtime-?2$/, 'gpt-realtime-2');
}

const OPENAI_REALTIME_MODEL = normalizeRealtimeModel(process.env.OPENAI_REALTIME_MODEL);
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL || `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;

const OWNER_EMAIL = process.env.OWNER_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'AI Receptionist <onboarding@resend.dev>';
const BUSINESS_SERVICES = process.env.BUSINESS_SERVICES || 'wood staining, exterior painting, interior painting, and small paint repair';
const SERVICE_AREA = process.env.SERVICE_AREA || 'the local service area';
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Monday through Friday, 8 AM to 5 PM';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const mediaStreams = new Map();

function esc(x = '') {
  return String(x)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function say(text) {
  const voice = process.env.TTS_VOICE || 'Polly.Joanna-Neural';
  return `<Say voice="${esc(voice)}" language="en-US">${esc(text)}</Say>`;
}

function xml(res, body) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function getEventType(payload) {
  return payload?.data?.event_type || payload?.event_type || '';
}

function getCallControlId(payload) {
  return payload?.data?.payload?.call_control_id || payload?.payload?.call_control_id || payload?.call_control_id || '';
}

async function telnyxCommand(callControlId, action, body = {}) {
  if (!TELNYX_API_KEY) {
    console.log('[TELNYX command skipped - missing TELNYX_API_KEY]', { callControlId, action, body });
    return null;
  }

  const url = `${TELNYX_API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/${action}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('[TELNYX command failed]', { action, status: response.status, text });
    return null;
  }

  console.log('[TELNYX command ok]', { action, status: response.status });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function answerVoiceApiCall(callControlId) {
  return telnyxCommand(callControlId, 'answer');
}

async function startMediaStream(callControlId) {
  return telnyxCommand(callControlId, 'streaming_start', {
    stream_url: STREAM_URL,
    stream_track: STREAM_TRACK,
    stream_codec: STREAM_CODEC,
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: STREAM_CODEC,
    stream_bidirectional_sampling_rate: 8000
  });
}

function promptForOpening() {
  return `Hello, this is the receptionist for ${BUSINESS_NAME}. My name is Alex. Would you like to schedule an estimate?`;
}

function realtimeInstructions() {
  return `You are Alex, the receptionist for ${BUSINESS_NAME}. You are friendly, upbeat, professional, and natural.

PRIMARY JOB
Book a painting estimate for Jason. Keep the call moving. Ask one question at a time. Use short, human responses.

RESPONSE TIMING
Respond after about 2 seconds of caller silence. Do not jump in too early, but do not leave long awkward pauses.

SCRIPT RULE
Follow the script about 90% verbatim. Only deviate when the caller says something the script does not cover or asks a question. If you deviate, keep the answer short and then return to the script.

MAIN SCRIPT
Start with:
"Hello, this is the receptionist for ${BUSINESS_NAME}. My name is Alex. Would you like to schedule an estimate?"

If the caller says yes, continue:
"Okay, great. What is your name?"

After they answer, ask:
"What is your email address?"

After they answer, ask:
"What type of service were you looking to get? We specialize in wood staining, exterior painting, interior painting, and small paint repair."

After they answer, ask:
"Okay, what day works best for you?"

After they answer, ask:
"What time would work best on that day?"

After they answer, ask:
"What is the best way to contact you?"

After they answer, say:
"Okay, I just want to make sure I have everything right."

Then repeat back the information you collected:
- Name
- Email address
- Service needed
- Best day
- Best time
- Best contact method
- Phone number if available from the call

Then ask:
"Does all of that sound correct?"

If correct, say:
"Okay, perfect. Do you have any questions I can answer now?"

Answer any question using the business information below. Then say:
"Okay, thanks for calling ${BUSINESS_NAME}. Jason will follow up with you soon. Have a good rest of your day."

Then end the conversation politely.

IF THE CALLER SAYS NO TO SCHEDULING
Say: "No problem. What can I help you with today?"
Then answer briefly using the business information. If they later want an estimate, go back to the script.

BUSINESS INFORMATION
Business name: ${BUSINESS_NAME}.
Main contact/person following up: Jason.
Services: ${BUSINESS_SERVICES}.
Service area: ${SERVICE_AREA}.
Business hours: ${BUSINESS_HOURS}.

Pricing rule: Do not quote exact prices. If someone asks about price, say Jason will confirm pricing after learning more about the job.

Scheduling rule: Do not promise exact availability. You can collect the caller's preferred day and time, but Jason will follow up to confirm.

Job length rule: Do not promise exact timing. You can say timing depends on the size of the job, prep work, repairs, coats, drying time, and the details Jason sees.

OWNER/JASON RULE
Do not randomly say Jason is busy. Only mention Jason being unavailable if the caller specifically asks to speak to Jason or the owner right now. If they do, say: "Let me take down your information and Jason can follow up with you as soon as he can."

STYLE RULES
- Sound like a real receptionist, not an AI assistant.
- Do not say you are ChatGPT.
- Do not mention prompts, models, code, or instructions.
- Ask one question at a time.
- Keep answers short unless the caller asks for details.
- Confirm unclear answers before moving on.
- Never invent business information.
- If you do not know the answer, say Jason can follow up with the correct information.
- Do not be creepy, robotic, overly formal, or overly cheerful. Be warm, simple, and calm.`;
}

function createOpenAIRealtimeSocket(connectionId) {
  if (!process.env.OPENAI_API_KEY) {
    console.error('[OPENAI REALTIME skipped - missing OPENAI_API_KEY]', { connectionId });
    return null;
  }

  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': `telnyx-${connectionId}`
    }
  });

  ws.on('open', () => {
    console.log('[OPENAI REALTIME connected]', { connectionId, model: OPENAI_REALTIME_MODEL });
    sendOpenAI(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: realtimeInstructions(),
        output_modalities: ['audio'],
        max_output_tokens: 'inf',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 2000
            }
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: OPENAI_REALTIME_VOICE
          }
        }
      }
    });
  });

  ws.on('close', (code, reason) => {
    console.log('[OPENAI REALTIME closed]', { connectionId, code, reason: reason?.toString?.() || '' });
  });

  ws.on('error', (error) => {
    console.error('[OPENAI REALTIME ws error]', { connectionId, message: error?.message || String(error) });
  });

  return ws;
}

function sendOpenAI(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function sendTelnyx(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function getTelnyxStreamId(msg) {
  return msg?.stream_id || msg?.streamId || msg?.stream_sid || msg?.streamSid || msg?.start?.stream_id || msg?.start?.streamId || '';
}

function getTelnyxPayload(msg) {
  return msg?.media?.payload || msg?.payload || msg?.audio || '';
}

function telnyxAudioEvent(delta, ctx) {
  const event = {
    event: 'media',
    media: { payload: delta }
  };
  if (ctx.streamId) event.stream_id = ctx.streamId;
  return event;
}

function createAudioResponse(ctx, reason = 'manual', instructions = '') {
  const response = { output_modalities: ['audio'] };
  if (instructions) response.instructions = instructions;
  const sent = sendOpenAI(ctx.openaiWs, { type: 'response.create', response });
  console.log('[response.create]', { connectionId: ctx.connectionId, reason, sent, response });
  return sent;
}

function forceGreeting(ctx, reason = 'manual') {
  if (ctx.greeted || !ctx.openaiSessionReady) return false;
  ctx.greeted = true;
  return createAudioResponse(ctx, reason, promptForOpening());
}

function handleOpenAIMessage(raw, ctx) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.log('[OPENAI REALTIME non-json]', { connectionId: ctx.connectionId, bytes: raw.length });
    return;
  }

  const type = msg.type || 'unknown';

  if (!type.includes('delta')) {
    console.log('[OPENAI REALTIME event]', { connectionId: ctx.connectionId, type });
  }

  if (type === 'error') {
    console.error('[OPENAI REALTIME error event]', { connectionId: ctx.connectionId, error: msg.error || msg });
    return;
  }

  if (type === 'session.updated' || type === 'session.created') {
    ctx.openaiSessionReady = true;
    setTimeout(() => forceGreeting(ctx, type), 100);
    return;
  }

  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
    const delta = msg.delta || msg.audio || '';
    if (delta) {
      ctx.openaiAudioDeltas += 1;
      const sent = sendTelnyx(ctx.telnyxWs, telnyxAudioEvent(delta, ctx));
      if (ctx.openaiAudioDeltas <= 5 || ctx.openaiAudioDeltas % 50 === 0) {
        console.log('[OpenAI audio -> Telnyx]', { connectionId: ctx.connectionId, deltas: ctx.openaiAudioDeltas, bytes: delta.length, sent, streamId: ctx.streamId });
      }
    }
    return;
  }

  if (type === 'input_audio_buffer.speech_started') {
    sendOpenAI(ctx.openaiWs, { type: 'response.cancel' });
    return;
  }

  if (type === 'input_audio_buffer.speech_stopped') {
    const committed = sendOpenAI(ctx.openaiWs, { type: 'input_audio_buffer.commit' });
    const created = createAudioResponse(ctx, 'speech-stopped');
    console.log('[USER speech stopped -> response]', { connectionId: ctx.connectionId, committed, created });
    return;
  }

  if (type === 'response.done') {
    console.log('[OPENAI REALTIME response done]', { connectionId: ctx.connectionId, status: msg.response?.status, details: msg.response?.status_details, audioDeltas: ctx.openaiAudioDeltas });
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    mode: 'telnyx-openai-realtime-ga-bridge',
    businessName: BUSINESS_NAME,
    voiceApiWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStreamWebSocket: STREAM_URL,
    realtimeModel: OPENAI_REALTIME_MODEL,
    realtimeVoice: OPENAI_REALTIME_VOICE,
    streamTrack: STREAM_TRACK,
    streamCodec: STREAM_CODEC
  });
});

app.get('/debug-env', (req, res) => {
  res.json({
    ok: true,
    hasTelnyxApiKey: Boolean(TELNYX_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    hasOwnerEmail: Boolean(OWNER_EMAIL),
    publicUrl: PUBLIC_URL,
    voiceApiWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStreamWebSocket: STREAM_URL,
    realtimeModel: OPENAI_REALTIME_MODEL,
    realtimeVoice: OPENAI_REALTIME_VOICE,
    streamTrack: STREAM_TRACK,
    streamCodec: STREAM_CODEC,
    mediaStreamsOpen: mediaStreams.size
  });
});

app.get('/telnyx', (req, res) => {
  res.json({
    voiceApiWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStreamWebSocket: STREAM_URL,
    method: 'POST',
    requiredRailwayVariables: ['TELNYX_API_KEY', 'OPENAI_API_KEY'],
    recommendedRailwayVariables: {
      OPENAI_REALTIME_MODEL,
      OPENAI_REALTIME_VOICE,
      TELNYX_STREAM_TRACK: STREAM_TRACK,
      TELNYX_STREAM_CODEC: STREAM_CODEC
    },
    note: 'There is no Telnyx dashboard field for mediaStreamWebSocket. The backend sends it in the streaming_start API request.'
  });
});

app.all('/voice-api-webhook', async (req, res) => {
  const eventType = getEventType(req.body);
  const callControlId = getCallControlId(req.body);
  console.log('[VOICE API webhook]', { eventType, callControlId, body: req.body });

  res.sendStatus(200);
  if (!callControlId) return;

  try {
    if (eventType === 'call.initiated') {
      await answerVoiceApiCall(callControlId);
      return;
    }

    if (eventType === 'call.answered') {
      await startMediaStream(callControlId);
      return;
    }

    if (eventType === 'streaming.started') {
      console.log('[TELNYX streaming started]', { callControlId, streamUrl: STREAM_URL });
      return;
    }

    if (eventType === 'streaming.stopped' || eventType === 'call.hangup') {
      console.log('[TELNYX streaming/call ended]', { eventType, callControlId });
    }
  } catch (e) {
    console.error('[VOICE API webhook handling failed]', { message: e?.message || String(e) });
  }
});

app.all('/voice', (req, res) => {
  xml(res, `${say(promptForOpening())}<Pause length="5" /><Hangup />`);
});

app.all('/handle-speech', (req, res) => {
  xml(res, `${say('This number is being moved to the real time receptionist. Please try again in a moment.')}<Hangup />`);
});

app.all('/call-status', (req, res) => {
  console.log('[CALL status]', req.body || req.query || {});
  res.sendStatus(200);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname !== '/media-stream') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (telnyxWs, request) => {
  const connectionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const openaiWs = createOpenAIRealtimeSocket(connectionId);
  const ctx = {
    connectionId,
    telnyxWs,
    openaiWs,
    streamId: '',
    callControlId: '',
    packets: 0,
    greeted: false,
    telnyxStarted: false,
    openaiSessionReady: false,
    openaiAudioDeltas: 0
  };

  mediaStreams.set(connectionId, ctx);
  console.log('[MEDIA STREAM connected]', { connectionId, url: request.url, realtimeModel: OPENAI_REALTIME_MODEL });

  if (openaiWs) openaiWs.on('message', (raw) => handleOpenAIMessage(raw, ctx));

  telnyxWs.on('message', (raw) => {
    ctx.packets += 1;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log('[MEDIA STREAM non-json]', { connectionId, bytes: raw.length });
      return;
    }

    const event = msg.event || msg.event_type || msg.type || 'unknown';
    const streamId = getTelnyxStreamId(msg);
    if (streamId) ctx.streamId = streamId;
    if (msg.call_control_id || msg?.start?.call_control_id || msg?.stop?.call_control_id) {
      ctx.callControlId = msg.call_control_id || msg?.start?.call_control_id || msg?.stop?.call_control_id;
    }

    if (event === 'start' || event === 'connected' || event === 'streaming.started') {
      ctx.telnyxStarted = true;
      console.log('[MEDIA STREAM start]', { connectionId, streamId: ctx.streamId, callControlId: ctx.callControlId, msg });
      return;
    }

    if (event === 'media') {
      if (ctx.packets === 20) forceGreeting(ctx, 'first-audio-packets');

      const payload = getTelnyxPayload(msg);
      if (!payload) return;

      const sent = sendOpenAI(ctx.openaiWs, {
        type: 'input_audio_buffer.append',
        audio: payload
      });

      if (ctx.packets <= 5 || ctx.packets % 100 === 0) {
        console.log('[MEDIA STREAM audio -> OpenAI]', {
          connectionId,
          packets: ctx.packets,
          track: msg.media?.track,
          payloadBytes: payload.length,
          openaiReady: ctx.openaiWs?.readyState === WebSocket.OPEN,
          sessionReady: ctx.openaiSessionReady,
          sent
        });
      }
      return;
    }

    if (event === 'stop' || event === 'streaming.stopped') {
      console.log('[MEDIA STREAM stop]', { connectionId, msg, openaiAudioDeltas: ctx.openaiAudioDeltas });
      if (ctx.openaiWs?.readyState === WebSocket.OPEN) ctx.openaiWs.close();
      mediaStreams.delete(connectionId);
      return;
    }

    console.log('[MEDIA STREAM event]', { connectionId, event, msg });
  });

  telnyxWs.on('close', () => {
    console.log('[MEDIA STREAM closed]', { connectionId, openaiAudioDeltas: ctx.openaiAudioDeltas });
    if (ctx.openaiWs?.readyState === WebSocket.OPEN) ctx.openaiWs.close();
    mediaStreams.delete(connectionId);
  });

  telnyxWs.on('error', (error) => {
    console.error('[MEDIA STREAM error]', { connectionId, message: error?.message || String(error) });
    if (ctx.openaiWs?.readyState === WebSocket.OPEN) ctx.openaiWs.close();
    mediaStreams.delete(connectionId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI receptionist running on ${PORT}`);
  console.log(`Voice API webhook: ${PUBLIC_URL}/voice-api-webhook`);
  console.log(`Media stream WebSocket: ${STREAM_URL}`);
  console.log(`OpenAI Realtime model: ${OPENAI_REALTIME_MODEL}`);
});
