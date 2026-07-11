import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  buildOcmPayload,
  cleanText,
  closingLine,
  estimateLeadTool,
  getCallerPhone,
  promptForOpening,
  realtimeInstructions,
  schedulingPolicy,
  validateEstimateLead
} from './receptionist.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tabor-painting-receptionist-production.up.railway.app').replace(/\/$/, '');
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Tabor Painting';
const BUSINESS_SERVICES = process.env.BUSINESS_SERVICES || 'wood staining, exterior painting, interior painting, and small paint repair';
const SERVICE_AREA = process.env.SERVICE_AREA || 'the local service area';
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Monday through Friday, 8 AM to 5 PM';
const SCHEDULING_BUFFER_MINUTES = envNumber('SCHEDULING_BUFFER_MINUTES', 30, 0, 180);
const VAD_SILENCE_MS = envNumber('VAD_SILENCE_MS', 700, 300, 3000);

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_API_BASE = process.env.TELNYX_API_BASE || 'https://api.telnyx.com/v2';
const STREAM_URL = process.env.TELNYX_STREAM_URL || PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const STREAM_TRACK = process.env.TELNYX_STREAM_TRACK || 'inbound_track';
const STREAM_CODEC = process.env.TELNYX_STREAM_CODEC || 'PCMU';

const OPENAI_REALTIME_MODEL = normalizeRealtimeModel(process.env.OPENAI_REALTIME_MODEL);
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL || `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;

const OCM_WEBHOOK_URL = process.env.OCM_WEBHOOK_URL || 'https://ark-websites-ocm.vercel.app/api/intake';
const mediaStreams = new Map();
const callMetadataByControlId = new Map();

function envNumber(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeRealtimeModel(value) {
  return String(value || 'gpt-realtime-2')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^gpt-?realtime-?2$/, 'gpt-realtime-2');
}

function esc(value = '') {
  return String(value)
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
  return payload?.data?.payload?.call_control_id
    || payload?.payload?.call_control_id
    || payload?.start?.call_control_id
    || payload?.call_control_id
    || '';
}

function rememberCallMetadata(payload) {
  const callControlId = getCallControlId(payload);
  if (!callControlId) return;

  const callerPhone = getCallerPhone(payload);
  const existing = callMetadataByControlId.get(callControlId) || {};
  callMetadataByControlId.set(callControlId, {
    ...existing,
    callerPhone: callerPhone || existing.callerPhone || '',
    updatedAt: Date.now()
  });
}

async function telnyxCommand(callControlId, action, body = {}) {
  if (!TELNYX_API_KEY) {
    console.log('[TELNYX command skipped - missing TELNYX_API_KEY]', { callControlId, action });
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

async function endVoiceApiCall(callControlId) {
  return telnyxCommand(callControlId, 'hangup');
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

function sendOpenAI(ws, event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(event));
  return true;
}

function sendTelnyx(ws, event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(event));
  return true;
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
        instructions: realtimeInstructions({
          businessName: BUSINESS_NAME,
          businessServices: BUSINESS_SERVICES,
          serviceArea: SERVICE_AREA,
          businessHours: BUSINESS_HOURS,
          schedulingBufferMinutes: SCHEDULING_BUFFER_MINUTES
        }),
        output_modalities: ['audio'],
        max_output_tokens: 220,
        tools: [estimateLeadTool],
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: {
              model: 'whisper-1',
              language: 'en'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 250,
              silence_duration_ms: VAD_SILENCE_MS,
              create_response: true,
              interrupt_response: true
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
    console.log('[OPENAI REALTIME closed]', {
      connectionId,
      code,
      reason: reason?.toString?.() || ''
    });
  });

  ws.on('error', (error) => {
    console.error('[OPENAI REALTIME ws error]', {
      connectionId,
      message: error?.message || String(error)
    });
  });

  return ws;
}

function createAudioResponse(ctx, reason, instructions) {
  if (ctx.openaiResponseActive) return false;

  const sent = sendOpenAI(ctx.openaiWs, {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions
    }
  });

  if (sent) ctx.openaiResponseActive = true;
  console.log('[response.create]', { connectionId: ctx.connectionId, reason, sent });
  return sent;
}

function queueAudioResponse(ctx, reason, instructions) {
  ctx.pendingAudioResponse = { reason, instructions };
  flushQueuedAudioResponse(ctx);
}

function flushQueuedAudioResponse(ctx) {
  if (ctx.openaiResponseActive || !ctx.pendingAudioResponse) return false;
  const pending = ctx.pendingAudioResponse;
  ctx.pendingAudioResponse = null;
  return createAudioResponse(ctx, pending.reason, pending.instructions);
}

function forceGreeting(ctx, reason = 'session-ready') {
  if (ctx.greeted || !ctx.openaiSessionReady) return false;
  ctx.greeted = true;
  return createAudioResponse(
    ctx,
    reason,
    `Say exactly this and nothing else: "${promptForOpening(BUSINESS_NAME)}" Then stop and wait for the caller.`
  );
}

function sendCallerPhoneContext(ctx) {
  if (!ctx.callerPhone || ctx.phoneContextSent || !ctx.openaiSessionReady) return false;

  const sent = sendOpenAI(ctx.openaiWs, {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: `Caller ID phone number: ${ctx.callerPhone}. Never ask for a phone number. The server will attach this number to the lead.`
      }]
    }
  });

  if (sent) ctx.phoneContextSent = true;
  return sent;
}

function hydrateCallContext(ctx, message) {
  const callControlId = getCallControlId(message);
  if (callControlId) ctx.callControlId = callControlId;

  const remembered = callMetadataByControlId.get(ctx.callControlId) || {};
  ctx.callerPhone = getCallerPhone(message) || remembered.callerPhone || ctx.callerPhone || '';
  sendCallerPhoneContext(ctx);
}

function getTelnyxStreamId(message) {
  return message?.stream_id
    || message?.streamId
    || message?.stream_sid
    || message?.streamSid
    || message?.start?.stream_id
    || message?.start?.streamId
    || '';
}

function getTelnyxPayload(message) {
  return message?.media?.payload || message?.payload || message?.audio || '';
}

function getTelnyxTrack(message) {
  return String(message?.media?.track || message?.track || '').toLowerCase();
}

function telnyxAudioEvent(delta, ctx) {
  const event = {
    event: 'media',
    media: { payload: delta }
  };
  if (ctx.streamId) event.stream_id = ctx.streamId;
  return event;
}

function clearTelnyxAudio(ctx) {
  const event = { event: 'clear' };
  if (ctx.streamId) event.stream_id = ctx.streamId;
  return sendTelnyx(ctx.telnyxWs, event);
}

function getFunctionCall(message) {
  const item = message.item || message.output_item || {};
  const name = message.name || item.name;
  if (name !== 'submit_estimate_lead') return null;

  const callId = message.call_id || item.call_id || item.id || '';
  const rawArguments = message.arguments || item.arguments || '{}';
  try {
    return { callId, args: JSON.parse(rawArguments || '{}') };
  } catch {
    return { callId, args: {} };
  }
}

function sendFunctionOutput(ctx, callId, result) {
  if (!callId) return false;
  return sendOpenAI(ctx.openaiWs, {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(result)
    }
  });
}

async function sendLeadToOcm(ctx, args) {
  if (ctx.ocmLeadSent) return { ok: true, skipped: true, reason: 'already-sent' };

  const payload = buildOcmPayload(ctx, args);
  try {
    const response = await fetch(OCM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep non-JSON response text for diagnostics.
    }

    ctx.ocmLeadSent = response.ok;
    console.log('[OCM lead submit]', {
      connectionId: ctx.connectionId,
      ok: response.ok,
      status: response.status
    });
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    console.error('[OCM lead submit failed]', {
      connectionId: ctx.connectionId,
      message: error?.message || String(error)
    });
    return { ok: false, error: error?.message || String(error) };
  }
}

async function handleEstimateLeadCall(ctx, call) {
  const callKey = call.callId || JSON.stringify(call.args);
  if (ctx.handledToolCalls.has(callKey)) return;
  ctx.handledToolCalls.add(callKey);

  const validation = validateEstimateLead(
    call.args,
    BUSINESS_HOURS,
    SCHEDULING_BUFFER_MINUTES
  );

  if (!validation.valid) {
    const result = {
      ok: false,
      validationError: true,
      errors: validation.errors
    };
    sendFunctionOutput(ctx, call.callId, result);
    queueAudioResponse(
      ctx,
      'lead-validation-correction',
      `The estimate request is not ready. Ask only for this missing or invalid information: ${validation.errors.join(' ')} Do not say goodbye. After the correction, reconfirm the corrected information before calling the tool again.`
    );
    return;
  }

  const result = await sendLeadToOcm(ctx, validation.normalized);
  sendFunctionOutput(ctx, call.callId, result);

  if (result.ok) {
    queueAudioResponse(
      ctx,
      'lead-saved-question-check',
      'Ask exactly: "Do you have any questions before we finish?" Say nothing else, then stop and wait for the caller.'
    );
    return;
  }

  queueAudioResponse(
    ctx,
    'lead-save-failed',
    'Say briefly that the request could not be saved just now and Jason will need to follow up. Then ask whether the caller has any questions and wait. Do not say goodbye in the same turn.'
  );
}

function isClosingTranscript(text) {
  const lower = cleanText(text).toLowerCase();
  return lower.includes(`thanks for calling ${BUSINESS_NAME.toLowerCase()}`)
    && lower.includes('goodbye');
}

function scheduleEndCall(ctx) {
  if (ctx.endCallScheduled) return false;
  ctx.endCallScheduled = true;

  setTimeout(async () => {
    if (!ctx.callControlId) {
      console.log('[TELNYX hangup skipped - missing call id]', { connectionId: ctx.connectionId });
      return;
    }
    await endVoiceApiCall(ctx.callControlId);
  }, 1200);
  return true;
}

function handleOpenAIMessage(raw, ctx) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    console.log('[OPENAI REALTIME non-json]', { connectionId: ctx.connectionId, bytes: raw.length });
    return;
  }

  const type = message.type || 'unknown';
  if (!type.includes('delta')) {
    console.log('[OPENAI REALTIME event]', { connectionId: ctx.connectionId, type });
  }

  if (type === 'error') {
    console.error('[OPENAI REALTIME error event]', {
      connectionId: ctx.connectionId,
      error: message.error || message
    });
    return;
  }

  if (type === 'session.created') return;

  if (type === 'session.updated') {
    ctx.openaiSessionReady = true;
    sendCallerPhoneContext(ctx);
    setTimeout(() => forceGreeting(ctx), 75);
    return;
  }

  if (type === 'response.created') {
    ctx.openaiResponseActive = true;
    ctx.currentAssistantTranscript = '';
    ctx.pendingEndCall = false;
    return;
  }

  if (type === 'response.function_call_arguments.done' || type === 'response.output_item.done') {
    const call = getFunctionCall(message);
    if (call) {
      handleEstimateLeadCall(ctx, call).catch((error) => {
        console.error('[tool handling failed]', {
          connectionId: ctx.connectionId,
          message: error?.message || String(error)
        });
      });
      return;
    }
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = cleanText(message.transcript);
    if (transcript) {
      ctx.userTranscript.push(transcript);
      console.log('[USER transcript]', { connectionId: ctx.connectionId, transcript });
    }
    return;
  }

  if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {
    ctx.currentAssistantTranscript += message.delta || message.transcript || '';
    return;
  }

  if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {
    const transcript = cleanText(message.transcript || ctx.currentAssistantTranscript);
    ctx.currentAssistantTranscript = transcript;
    ctx.pendingEndCall = isClosingTranscript(transcript);
    return;
  }

  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
    const delta = message.delta || message.audio || '';
    if (delta) {
      ctx.openaiAudioDeltas += 1;
      sendTelnyx(ctx.telnyxWs, telnyxAudioEvent(delta, ctx));
    }
    return;
  }

  if (type === 'input_audio_buffer.speech_started') {
    if (ctx.openaiResponseActive) clearTelnyxAudio(ctx);
    ctx.pendingEndCall = false;
    return;
  }

  if (type === 'input_audio_buffer.speech_stopped') {
    // Server VAD commits the turn and creates the response. Do not also commit or
    // request a response here, or the same caller turn can be processed twice.
    return;
  }

  if (type === 'response.cancelled') {
    ctx.openaiResponseActive = false;
    ctx.pendingEndCall = false;
    flushQueuedAudioResponse(ctx);
    return;
  }

  if (type === 'response.done') {
    ctx.openaiResponseActive = false;
    const completed = !message.response?.status || message.response.status === 'completed';
    console.log('[OPENAI REALTIME response done]', {
      connectionId: ctx.connectionId,
      status: message.response?.status,
      pendingEndCall: ctx.pendingEndCall,
      ocmLeadSent: ctx.ocmLeadSent
    });

    if (completed && ctx.pendingEndCall) {
      scheduleEndCall(ctx);
      return;
    }

    ctx.pendingEndCall = false;
    flushQueuedAudioResponse(ctx);
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
    schedulingPolicy: schedulingPolicy(BUSINESS_HOURS, SCHEDULING_BUFFER_MINUTES)
  });
});

app.get('/debug-env', (req, res) => {
  res.json({
    ok: true,
    hasTelnyxApiKey: Boolean(TELNYX_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    publicUrl: PUBLIC_URL,
    voiceApiWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStreamWebSocket: STREAM_URL,
    realtimeModel: OPENAI_REALTIME_MODEL,
    realtimeVoice: OPENAI_REALTIME_VOICE,
    streamTrack: STREAM_TRACK,
    streamCodec: STREAM_CODEC,
    vadSilenceMs: VAD_SILENCE_MS,
    schedulingBufferMinutes: SCHEDULING_BUFFER_MINUTES,
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
      TELNYX_STREAM_CODEC: STREAM_CODEC,
      VAD_SILENCE_MS,
      SCHEDULING_BUFFER_MINUTES
    }
  });
});

app.all('/voice-api-webhook', async (req, res) => {
  const eventType = getEventType(req.body);
  const callControlId = getCallControlId(req.body);
  rememberCallMetadata(req.body);
  console.log('[VOICE API webhook]', { eventType, callControlId });

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
      callMetadataByControlId.delete(callControlId);
      console.log('[TELNYX streaming/call ended]', { eventType, callControlId });
    }
  } catch (error) {
    console.error('[VOICE API webhook handling failed]', {
      message: error?.message || String(error)
    });
  }
});

app.all('/voice', (req, res) => {
  xml(res, `${say(promptForOpening(BUSINESS_NAME))}<Pause length="5" /><Hangup />`);
});

app.all('/handle-speech', (req, res) => {
  xml(res, `${say('This number uses the real-time receptionist. Please call again in a moment.')}<Hangup />`);
});

app.all('/call-status', (req, res) => {
  console.log('[CALL status]', { eventType: getEventType(req.body) });
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
    callerPhone: '',
    packets: 0,
    greeted: false,
    openaiSessionReady: false,
    openaiResponseActive: false,
    phoneContextSent: false,
    openaiAudioDeltas: 0,
    currentAssistantTranscript: '',
    userTranscript: [],
    pendingAudioResponse: null,
    pendingEndCall: false,
    endCallScheduled: false,
    ocmLeadSent: false,
    handledToolCalls: new Set()
  };

  mediaStreams.set(connectionId, ctx);
  console.log('[MEDIA STREAM connected]', {
    connectionId,
    url: request.url,
    realtimeModel: OPENAI_REALTIME_MODEL
  });

  if (openaiWs) {
    openaiWs.on('message', (raw) => handleOpenAIMessage(raw, ctx));
  }

  telnyxWs.on('message', (raw) => {
    ctx.packets += 1;

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.log('[MEDIA STREAM non-json]', { connectionId, bytes: raw.length });
      return;
    }

    const event = message.event || message.event_type || message.type || 'unknown';
    const streamId = getTelnyxStreamId(message);
    if (streamId) ctx.streamId = streamId;

    if (event === 'start' || event === 'connected' || event === 'streaming.started') {
      hydrateCallContext(ctx, message);
      console.log('[MEDIA STREAM start]', {
        connectionId,
        streamId: ctx.streamId,
        callControlId: ctx.callControlId,
        hasCallerPhone: Boolean(ctx.callerPhone)
      });
      return;
    }

    if (event === 'media') {
      if (ctx.packets === 20) forceGreeting(ctx, 'first-audio-packets');

      const track = getTelnyxTrack(message);
      if (track.includes('outbound')) return;

      const payload = getTelnyxPayload(message);
      if (!payload) return;
      sendOpenAI(ctx.openaiWs, {
        type: 'input_audio_buffer.append',
        audio: payload
      });
      return;
    }

    if (event === 'stop' || event === 'streaming.stopped') {
      console.log('[MEDIA STREAM stop]', { connectionId, callControlId: ctx.callControlId });
      if (ctx.openaiWs?.readyState === WebSocket.OPEN) ctx.openaiWs.close();
      mediaStreams.delete(connectionId);
      return;
    }

    console.log('[MEDIA STREAM event]', { connectionId, event });
  });

  telnyxWs.on('close', () => {
    console.log('[MEDIA STREAM closed]', { connectionId });
    if (ctx.openaiWs?.readyState === WebSocket.OPEN) ctx.openaiWs.close();
    mediaStreams.delete(connectionId);
  });

  telnyxWs.on('error', (error) => {
    console.error('[MEDIA STREAM error]', {
      connectionId,
      message: error?.message || String(error)
    });
    if (ctx.openaiWs?.readyState === WebSocket.OPEN) ctx.openaiWs.close();
    mediaStreams.delete(connectionId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI receptionist running on ${PORT}`);
  console.log(`Voice API webhook: ${PUBLIC_URL}/voice-api-webhook`);
  console.log(`Media stream WebSocket: ${STREAM_URL}`);
  console.log(`OpenAI Realtime model: ${OPENAI_REALTIME_MODEL}`);
  console.log(`Closing line: ${closingLine(BUSINESS_NAME)}`);
});
