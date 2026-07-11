import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AUDIO_FORMAT,
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  buildOcmPayload,
  closingLine,
  getCallerPhone,
  instructions,
  openingLine,
  tools,
  validateLead
} from './receptionist-core.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tabor-painting-receptionist-production.up.railway.app').replace(/\/$/, '');
const STREAM_URL = PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const OCM_WEBHOOK_URL = process.env.OCM_WEBHOOK_URL || 'https://ark-websites-ocm.vercel.app/api/intake';
const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const activeCalls = new Map();
const callMetadata = new Map();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

function eventType(body) {
  return body?.data?.event_type || body?.event_type || '';
}

function callControlId(body) {
  return body?.data?.payload?.call_control_id
    || body?.payload?.call_control_id
    || body?.start?.call_control_id
    || body?.call_control_id
    || '';
}

function rememberCall(body) {
  const id = callControlId(body);
  if (!id) return;
  const previous = callMetadata.get(id) || {};
  callMetadata.set(id, {
    callerPhone: getCallerPhone(body) || previous.callerPhone || '',
    updatedAt: Date.now()
  });
}

async function telnyxCommand(id, action, body = {}) {
  if (!process.env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is missing');
  const response = await fetch(`${TELNYX_API_BASE}/calls/${encodeURIComponent(id)}/actions/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Telnyx ${action} failed: ${response.status} ${await response.text()}`);
}

function sendJson(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function queueResponse(ctx, instructionsText, hangupAfter = false) {
  ctx.pendingResponse = { instructionsText, hangupAfter };
  flushResponse(ctx);
}

function flushResponse(ctx) {
  if (!ctx.sessionReady || !ctx.streamReady || ctx.responseActive || !ctx.pendingResponse) return false;
  const next = ctx.pendingResponse;
  ctx.pendingResponse = null;
  ctx.hangupAfterResponse = next.hangupAfter;
  ctx.responseActive = sendJson(ctx.openai, {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions: next.instructionsText
    }
  });
  return ctx.responseActive;
}

function sendTelnyx(ctx, event) {
  if (ctx.streamId) event.stream_id = ctx.streamId;
  return sendJson(ctx.telnyx, event);
}

function sendToolOutput(ctx, callId, output) {
  if (!callId) return;
  sendJson(ctx.openai, {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output)
    }
  });
}

function parseToolCall(message) {
  const item = message.item || message.output_item || {};
  const name = message.name || item.name;
  if (!name) return null;
  const callId = message.call_id || item.call_id || item.id || '';
  const raw = message.arguments || item.arguments || '{}';
  try {
    return { name, callId, args: JSON.parse(raw || '{}') };
  } catch {
    return { name, callId, args: {} };
  }
}

async function saveLead(ctx, call) {
  const validation = validateLead(call.args);
  if (!validation.valid) {
    sendToolOutput(ctx, call.callId, { ok: false, missingOrInvalid: validation.errors });
    queueResponse(ctx, `Ask only for ${validation.errors.join(', ')}. Ask one question, then wait. Do not restart the intake.`);
    return;
  }

  if (ctx.leadSaved) {
    sendToolOutput(ctx, call.callId, { ok: true, alreadySaved: true });
    queueResponse(ctx, 'Ask exactly: "Do you have any questions about Tabor Painting?" Then stop and wait.');
    return;
  }

  const payload = buildOcmPayload(ctx.callerPhone, validation.lead);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(OCM_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`OCM ${response.status}: ${body}`);
      ctx.leadSaved = true;
      sendToolOutput(ctx, call.callId, { ok: true });
      queueResponse(ctx, 'Ask exactly: "Do you have any questions about Tabor Painting?" Say nothing else, then stop and wait.');
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  ctx.leadSaveFailed = true;
  console.error('[OCM save failed]', lastError?.message || 'unknown error');
  sendToolOutput(ctx, call.callId, { ok: false, error: 'save_failed' });
  queueResponse(ctx, 'Say briefly: "I could not save that just now, but Jason can still follow up." Then ask: "Do you have any questions about Tabor Painting?" and wait.');
}

function finishCall(ctx, call) {
  if (!ctx.leadSaved && !ctx.leadSaveFailed) {
    sendToolOutput(ctx, call.callId, { ok: false, error: 'lead_not_saved' });
    queueResponse(ctx, 'Do not end the call yet. Finish confirming and saving the estimate request first.');
    return;
  }
  sendToolOutput(ctx, call.callId, { ok: true });
  queueResponse(ctx, `Say exactly this and nothing else: "${closingLine}"`, true);
}

async function handleTool(ctx, call) {
  const key = call.callId || `${call.name}:${JSON.stringify(call.args)}`;
  if (ctx.handledCalls.has(key)) return;
  ctx.handledCalls.add(key);
  if (call.name === 'submit_estimate_lead') await saveLead(ctx, call);
  if (call.name === 'finish_call') finishCall(ctx, call);
}

function createOpenAiSocket(ctx) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  const ws = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': `tabor-${ctx.id}`
    }
  });

  ws.on('open', () => {
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: instructions(),
        output_modalities: ['audio'],
        max_output_tokens: 220,
        tools,
        tool_choice: 'auto',
        audio: {
          input: {
            format: AUDIO_FORMAT,
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 250,
              silence_duration_ms: 650,
              create_response: true,
              interrupt_response: true
            }
          },
          output: { format: AUDIO_FORMAT, voice: REALTIME_VOICE }
        }
      }
    });
  });

  ws.on('message', (raw) => handleOpenAiMessage(ctx, raw));
  ws.on('error', (error) => console.error('[OpenAI websocket]', error.message));
  ws.on('close', () => console.log('[OpenAI closed]', ctx.id));
  return ws;
}

function attachCallerContext(ctx) {
  if (!ctx.sessionReady || ctx.phoneContextSent || !ctx.callerPhone) return;
  ctx.phoneContextSent = sendJson(ctx.openai, {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: `Caller ID phone number: ${ctx.callerPhone}. Never ask for a phone number. Include it only in the final confirmation.`
      }]
    }
  });
}

function handleOpenAiMessage(ctx, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (message.type === 'error') {
    console.error('[OpenAI error]', message.error || message);
    return;
  }

  if (message.type === 'session.updated') {
    ctx.sessionReady = true;
    attachCallerContext(ctx);
    queueResponse(ctx, `Say exactly this and nothing else: "${openingLine}" Then stop and wait.`);
    return;
  }

  if (message.type === 'response.created') {
    ctx.responseActive = true;
    return;
  }

  if (message.type === 'response.function_call_arguments.done' || message.type === 'response.output_item.done') {
    const call = parseToolCall(message);
    if (call) handleTool(ctx, call).catch((error) => console.error('[Tool error]', error.message));
    return;
  }

  if (message.type === 'response.audio.delta' || message.type === 'response.output_audio.delta') {
    const audio = message.delta || message.audio;
    if (audio) sendTelnyx(ctx, { event: 'media', media: { payload: audio } });
    return;
  }

  if (message.type === 'input_audio_buffer.speech_started') {
    sendTelnyx(ctx, { event: 'clear' });
    ctx.hangupAfterResponse = false;
    return;
  }

  if (message.type === 'response.cancelled') {
    ctx.responseActive = false;
    ctx.hangupAfterResponse = false;
    flushResponse(ctx);
    return;
  }

  if (message.type === 'response.done') {
    ctx.responseActive = false;
    if (ctx.hangupAfterResponse) {
      ctx.hangupAfterResponse = false;
      setTimeout(() => {
        if (ctx.callControlId) telnyxCommand(ctx.callControlId, 'hangup').catch((error) => console.error('[Hangup]', error.message));
      }, 700);
      return;
    }
    flushResponse(ctx);
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    business: BUSINESS.name,
    provider: 'Telnyx',
    model: REALTIME_MODEL,
    codec: 'PCMU 8 kHz',
    voiceWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStream: STREAM_URL
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    model: REALTIME_MODEL,
    codec: 'PCMU',
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasTelnyxKey: Boolean(process.env.TELNYX_API_KEY),
    activeCalls: activeCalls.size
  });
});

app.post('/voice-api-webhook', async (req, res) => {
  res.sendStatus(200);
  const type = eventType(req.body);
  const id = callControlId(req.body);
  rememberCall(req.body);
  if (!id) return;

  try {
    if (type === 'call.initiated') await telnyxCommand(id, 'answer');
    if (type === 'call.answered') {
      await telnyxCommand(id, 'streaming_start', {
        stream_url: STREAM_URL,
        stream_track: 'inbound_track',
        stream_codec: 'PCMU',
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: 'PCMU',
        stream_bidirectional_sampling_rate: 8000
      });
    }
    if (type === 'call.hangup' || type === 'streaming.stopped') callMetadata.delete(id);
  } catch (error) {
    console.error('[Telnyx webhook]', type, error.message);
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/media-stream') return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (telnyx) => {
  const ctx = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    telnyx,
    openai: null,
    streamId: '',
    callControlId: '',
    callerPhone: '',
    sessionReady: false,
    streamReady: false,
    phoneContextSent: false,
    responseActive: false,
    pendingResponse: null,
    hangupAfterResponse: false,
    leadSaved: false,
    leadSaveFailed: false,
    handledCalls: new Set()
  };

  try {
    ctx.openai = createOpenAiSocket(ctx);
  } catch (error) {
    console.error('[Call setup]', error.message);
    telnyx.close();
    return;
  }

  activeCalls.set(ctx.id, ctx);

  telnyx.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const event = message.event || message.event_type || message.type;
    if (event === 'start' || event === 'connected' || event === 'streaming.started') {
      ctx.streamId = message.stream_id || message.start?.stream_id || ctx.streamId;
      ctx.streamReady = true;
      ctx.callControlId = callControlId(message) || ctx.callControlId;
      const remembered = callMetadata.get(ctx.callControlId) || {};
      ctx.callerPhone = getCallerPhone(message) || remembered.callerPhone || ctx.callerPhone;
      attachCallerContext(ctx);
      flushResponse(ctx);
      return;
    }

    if (event === 'media') {
      const track = String(message.media?.track || '').toLowerCase();
      if (track.includes('outbound')) return;
      const audio = message.media?.payload || message.payload || message.audio;
      if (audio) sendJson(ctx.openai, { type: 'input_audio_buffer.append', audio });
      return;
    }

    if (event === 'stop' || event === 'streaming.stopped') telnyx.close();
  });

  const cleanup = () => {
    if (ctx.openai?.readyState === WebSocket.OPEN) ctx.openai.close();
    activeCalls.delete(ctx.id);
  };
  telnyx.on('close', cleanup);
  telnyx.on('error', (error) => {
    console.error('[Telnyx websocket]', error.message);
    cleanup();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tabor Painting receptionist listening on ${PORT}`);
  console.log(`Model: ${REALTIME_MODEL}`);
  console.log('Codec: PCMU 8 kHz');
});
