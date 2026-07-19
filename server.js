import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AUDIO_FORMAT,
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  SAFETY_IDENTIFIER,
  SILENCE_DURATION_MS,
  SPEECH_SPEED,
  TRANSCRIPTION_PROMPT,
  afterSaveQuestion,
  buildOcmPayload,
  closingLine,
  getCallerPhone,
  instructions,
  openingLine,
  saveFailureLine,
  tools,
  validateLead,
} from './receptionist-core.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = resolvePublicUrl();
const STREAM_URL = PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const OCM_WEBHOOK_URL = String(process.env.OCM_WEBHOOK_URL || '').trim();
const OPENAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const BARGE_IN_CONFIRM_MS = 450;
const MIN_USER_TURN_MS = 250;
const TRANSCRIPT_WAIT_MS = 1800;
const AUDIO_FRAME_MS = 20;
const PCMU_BYTES_PER_MS = 8;
const AUDIO_FRAME_BYTES = AUDIO_FRAME_MS * PCMU_BYTES_PER_MS;
const AUDIO_PREBUFFER_MS = 60;
const AUDIO_PREBUFFER_BYTES = AUDIO_PREBUFFER_MS * PCMU_BYTES_PER_MS;
const MAX_OUTPUT_TOKENS = 800;
const activeCalls = new Map();
const callMetadata = new Map();

const HOLD_PATTERN = /\b(?:hold on|wait(?: a moment)?|one second|one sec|give me (?:a|one) (?:second|sec|minute|moment)|just a (?:second|sec|minute|moment)|hang on|pause for a (?:second|minute|moment))\b/i;

function resolvePublicUrl() {
  const configured = String(process.env.PUBLIC_URL || '').trim();
  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  const raw = configured || (railwayDomain ? `https://${railwayDomain}` : 'https://tabor-painting-receptionist-production.up.railway.app');

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('PUBLIC_URL must be a complete public HTTP or HTTPS URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_URL must use HTTP or HTTPS.');
  }

  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

function assertRuntimeConfiguration() {
  const missing = [
    ['TELNYX_API_KEY', process.env.TELNYX_API_KEY],
    ['OPENAI_API_KEY', process.env.OPENAI_API_KEY],
    ['OCM_WEBHOOK_URL', OCM_WEBHOOK_URL],
  ].filter(([, value]) => !String(value || '').trim()).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing required runtime configuration: ${missing.join(', ')}`);
  }
}

assertRuntimeConfiguration();

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
    updatedAt: Date.now(),
  });
}

async function telnyxCommand(id, action, body = {}) {
  const response = await fetch(`${TELNYX_API_BASE}/calls/${encodeURIComponent(id)}/actions/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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

function requestNaturalResponse(ctx) {
  ctx.pendingNaturalResponse = true;
  flushResponse(ctx);
}

function flushResponse(ctx) {
  if (!ctx.sessionReady || !ctx.streamReady || ctx.responseActive) return false;

  if (ctx.pendingResponse) {
    const next = ctx.pendingResponse;
    ctx.pendingResponse = null;
    ctx.hangupAfterResponse = next.hangupAfter;
    ctx.responseActive = sendJson(ctx.openai, {
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions: next.instructionsText,
      },
    });
    return ctx.responseActive;
  }

  if (!ctx.pendingNaturalResponse || ctx.holdMode) return false;
  ctx.pendingNaturalResponse = false;
  ctx.hangupAfterResponse = false;
  ctx.responseActive = sendJson(ctx.openai, {
    type: 'response.create',
    response: { output_modalities: ['audio'] },
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
      output: JSON.stringify(output),
    },
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
    queueResponse(ctx, `Ask exactly: "${afterSaveQuestion}" Then stop and wait.`);
    return;
  }

  const payload = buildOcmPayload(ctx.callerPhone, validation.lead);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(OCM_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`OCM ${response.status}: ${body}`);
      ctx.leadSaved = true;
      sendToolOutput(ctx, call.callId, { ok: true, preferredDate: payload.EstimateDate || '' });
      queueResponse(ctx, `Ask exactly: "${afterSaveQuestion}" Say nothing else, then stop and wait.`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  ctx.leadSaveFailed = true;
  console.error('[OCM save failed]', lastError?.message || 'unknown error');
  sendToolOutput(ctx, call.callId, { ok: false, error: 'save_failed' });
  queueResponse(ctx, `Say briefly: "${saveFailureLine}" Then ask: "${afterSaveQuestion}" and wait.`);
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

function cancelBargeInTimer(ctx) {
  if (ctx.bargeInTimer) clearTimeout(ctx.bargeInTimer);
  ctx.bargeInTimer = null;
}

function clearTranscriptTimer(ctx) {
  if (ctx.transcriptTimer) clearTimeout(ctx.transcriptTimer);
  ctx.transcriptTimer = null;
  ctx.awaitingTranscript = false;
}

function stopAudioPump(ctx) {
  if (ctx.audioPumpTimer) clearTimeout(ctx.audioPumpTimer);
  ctx.audioPumpTimer = null;
}

function clearLocalAudio(ctx) {
  stopAudioPump(ctx);
  ctx.audioBuffer = Buffer.alloc(0);
  ctx.audioPumpStarted = false;
  ctx.openAiAudioDone = false;
  ctx.waitingForPlaybackMark = false;
  ctx.playbackMarkName = '';
}

function completeAssistantPlayback(ctx) {
  ctx.responseActive = false;
  ctx.openAiGenerating = false;
  ctx.openAiAudioDone = false;
  ctx.waitingForPlaybackMark = false;
  ctx.playbackMarkName = '';

  if (ctx.hangupAfterResponse) {
    ctx.hangupAfterResponse = false;
    if (ctx.callControlId) {
      telnyxCommand(ctx.callControlId, 'hangup').catch((error) => console.error('[Hangup]', error.message));
    }
    return;
  }

  flushResponse(ctx);
}

function sendPlaybackMark(ctx) {
  if (ctx.waitingForPlaybackMark) return;
  if (ctx.assistantAudioSentMs <= 0) {
    completeAssistantPlayback(ctx);
    return;
  }

  ctx.playbackMarkName = `assistant-playback-${ctx.responseSequence}`;
  ctx.waitingForPlaybackMark = sendTelnyx(ctx, {
    event: 'mark',
    mark: { name: ctx.playbackMarkName },
  });

  if (!ctx.waitingForPlaybackMark) completeAssistantPlayback(ctx);
}

function pumpAudio(ctx) {
  ctx.audioPumpTimer = null;
  if (!ctx.streamReady || ctx.bargeInConfirmed) return;

  let frame = null;
  if (ctx.audioBuffer.length >= AUDIO_FRAME_BYTES) {
    frame = ctx.audioBuffer.subarray(0, AUDIO_FRAME_BYTES);
    ctx.audioBuffer = ctx.audioBuffer.subarray(AUDIO_FRAME_BYTES);
  } else if (ctx.openAiAudioDone && ctx.audioBuffer.length > 0) {
    frame = Buffer.alloc(AUDIO_FRAME_BYTES, 0xff);
    ctx.audioBuffer.copy(frame);
    ctx.audioBuffer = Buffer.alloc(0);
  }

  if (frame) {
    if (!ctx.assistantAudioStartedAt) ctx.assistantAudioStartedAt = Date.now();
    ctx.assistantAudioSentMs += AUDIO_FRAME_MS;
    sendTelnyx(ctx, {
      event: 'media',
      media: { payload: frame.toString('base64') },
    });
    ctx.audioPumpTimer = setTimeout(() => pumpAudio(ctx), AUDIO_FRAME_MS);
    return;
  }

  if (ctx.openAiAudioDone) {
    sendPlaybackMark(ctx);
    return;
  }

  ctx.audioPumpTimer = setTimeout(() => pumpAudio(ctx), 10);
}

function startAudioPump(ctx) {
  if (ctx.audioPumpTimer || ctx.waitingForPlaybackMark || ctx.bargeInConfirmed) return;
  if (!ctx.audioPumpStarted) {
    if (!ctx.openAiAudioDone && ctx.audioBuffer.length < AUDIO_PREBUFFER_BYTES) return;
    ctx.audioPumpStarted = true;
  }
  ctx.audioPumpTimer = setTimeout(() => pumpAudio(ctx), 0);
}

function enqueueAudio(ctx, base64Audio) {
  let chunk;
  try {
    chunk = Buffer.from(base64Audio, 'base64');
  } catch {
    return;
  }
  if (!chunk.length || ctx.bargeInConfirmed) return;
  ctx.audioBuffer = ctx.audioBuffer.length
    ? Buffer.concat([ctx.audioBuffer, chunk])
    : chunk;
  startAudioPump(ctx);
}

function confirmBargeIn(ctx) {
  ctx.bargeInTimer = null;
  if (!ctx.responseActive) return;

  ctx.bargeInConfirmed = true;
  ctx.hangupAfterResponse = false;
  if (ctx.openAiGenerating) sendJson(ctx.openai, { type: 'response.cancel' });

  clearLocalAudio(ctx);
  sendTelnyx(ctx, { event: 'clear' });

  const audioEndMs = Math.floor(Math.max(0, ctx.assistantAudioSentMs));
  if (ctx.assistantItemId && audioEndMs > 0) {
    sendJson(ctx.openai, {
      type: 'conversation.item.truncate',
      item_id: ctx.assistantItemId,
      content_index: 0,
      audio_end_ms: audioEndMs,
    });
  }

  if (!ctx.openAiGenerating) {
    ctx.responseActive = false;
    flushResponse(ctx);
  }
}

function startBargeInTimer(ctx) {
  cancelBargeInTimer(ctx);
  if (!ctx.responseActive) return;
  ctx.bargeInTimer = setTimeout(() => confirmBargeIn(ctx), BARGE_IN_CONFIRM_MS);
}

function cancelResponseForHold(ctx) {
  ctx.pendingNaturalResponse = false;
  if (!ctx.responseActive) return;
  ctx.hangupAfterResponse = false;
  if (ctx.openAiGenerating) sendJson(ctx.openai, { type: 'response.cancel' });
  clearLocalAudio(ctx);
  sendTelnyx(ctx, { event: 'clear' });
  ctx.responseActive = false;
  ctx.openAiGenerating = false;
}

function isHoldRequest(transcript) {
  return HOLD_PATTERN.test(String(transcript || '').trim());
}

function scheduleResponseAfterTranscript(ctx) {
  clearTranscriptTimer(ctx);
  ctx.awaitingTranscript = true;
  ctx.transcriptTimer = setTimeout(() => {
    ctx.transcriptTimer = null;
    ctx.awaitingTranscript = false;
    if (!ctx.holdMode) requestNaturalResponse(ctx);
  }, TRANSCRIPT_WAIT_MS);
}

function handleCallerTranscript(ctx, transcript) {
  const text = String(transcript || '').trim();
  if (!text) return;
  ctx.lastCallerTranscript = text;
  clearTranscriptTimer(ctx);

  if (isHoldRequest(text)) {
    ctx.holdMode = true;
    cancelResponseForHold(ctx);
    console.log('[Caller requested silence]', { callId: ctx.callControlId || ctx.id, transcript: text });
    return;
  }

  if (ctx.holdMode) {
    ctx.holdMode = false;
    console.log('[Caller resumed]', { callId: ctx.callControlId || ctx.id, transcript: text });
  }

  requestNaturalResponse(ctx);
}

function createOpenAiSocket(ctx) {
  const ws = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': `${SAFETY_IDENTIFIER}-${ctx.id}`,
    },
  });

  ws.on('open', () => {
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: instructions(),
        output_modalities: ['audio'],
        max_output_tokens: MAX_OUTPUT_TOKENS,
        tools,
        tool_choice: 'auto',
        audio: {
          input: {
            format: AUDIO_FORMAT,
            transcription: {
              model: 'gpt-4o-mini-transcribe',
              language: 'en',
              prompt: TRANSCRIPTION_PROMPT,
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.7,
              prefix_padding_ms: 300,
              silence_duration_ms: SILENCE_DURATION_MS,
              create_response: false,
              interrupt_response: false,
            },
          },
          output: {
            format: AUDIO_FORMAT,
            voice: REALTIME_VOICE,
            speed: SPEECH_SPEED,
          },
        },
      },
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
        text: `Caller ID phone number: ${ctx.callerPhone}. This is private internal data. Never ask for it, say it, repeat it, confirm it, or include it in a spoken summary. Use it only in the saved lead record.`,
      }],
    },
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
    queueResponse(ctx, `Say exactly this and nothing else, at a calm measured pace: "${openingLine}" Then stop and wait.`);
    return;
  }

  if (message.type === 'response.created') {
    clearLocalAudio(ctx);
    ctx.responseSequence += 1;
    ctx.responseActive = true;
    ctx.openAiGenerating = true;
    ctx.bargeInConfirmed = false;
    ctx.assistantItemId = '';
    ctx.assistantAudioSentMs = 0;
    ctx.assistantAudioStartedAt = 0;
    return;
  }

  if (message.type === 'response.output_item.added' || message.type === 'response.output_item.created') {
    const item = message.item || message.output_item || {};
    if (item.type === 'message' && item.role === 'assistant') ctx.assistantItemId = item.id || ctx.assistantItemId;
    return;
  }

  if (message.type === 'response.function_call_arguments.done' || message.type === 'response.output_item.done') {
    const call = parseToolCall(message);
    if (call) handleTool(ctx, call).catch((error) => console.error('[Tool error]', error.message));
    return;
  }

  if (message.type === 'response.audio.delta' || message.type === 'response.output_audio.delta') {
    const audio = message.delta || message.audio;
    if (audio) enqueueAudio(ctx, audio);
    return;
  }

  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    handleCallerTranscript(ctx, message.transcript);
    return;
  }

  if (message.type === 'conversation.item.input_audio_transcription.failed') {
    clearTranscriptTimer(ctx);
    if (!ctx.holdMode) requestNaturalResponse(ctx);
    return;
  }

  if (message.type === 'input_audio_buffer.speech_started') {
    ctx.userSpeechStartedAt = Date.now();
    ctx.userSpeechStartedWhileAssistant = ctx.responseActive;
    ctx.bargeInConfirmed = false;
    clearTranscriptTimer(ctx);
    startBargeInTimer(ctx);
    return;
  }

  if (message.type === 'input_audio_buffer.speech_stopped') {
    const speechMs = ctx.userSpeechStartedAt ? Date.now() - ctx.userSpeechStartedAt : 0;
    const interruptedAssistant = ctx.userSpeechStartedWhileAssistant;
    ctx.userSpeechStartedAt = 0;
    ctx.userSpeechStartedWhileAssistant = false;
    cancelBargeInTimer(ctx);
    if (speechMs < MIN_USER_TURN_MS) return;
    if (interruptedAssistant && !ctx.bargeInConfirmed) return;
    scheduleResponseAfterTranscript(ctx);
    return;
  }

  if (message.type === 'response.cancelled') {
    ctx.openAiGenerating = false;
    ctx.responseActive = false;
    cancelBargeInTimer(ctx);
    clearLocalAudio(ctx);
    flushResponse(ctx);
    return;
  }

  if (message.type === 'response.done') {
    const response = message.response || {};
    const status = response.status || message.status || 'unknown';
    const reason = response.status_details?.reason || message.status_details?.reason || '';
    console.log('[OpenAI response done]', {
      callId: ctx.callControlId || ctx.id,
      responseId: response.id || message.response_id || '',
      status,
      reason,
      outputTokens: response.usage?.output_tokens ?? null,
    });

    ctx.openAiGenerating = false;
    cancelBargeInTimer(ctx);

    if (ctx.bargeInConfirmed) {
      ctx.responseActive = false;
      clearLocalAudio(ctx);
      flushResponse(ctx);
      return;
    }

    ctx.openAiAudioDone = true;
    startAudioPump(ctx);
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    business: BUSINESS.name,
    provider: 'Telnyx',
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    codec: 'PCMU 8 kHz',
    speechSpeed: SPEECH_SPEED,
    silenceDurationMs: SILENCE_DURATION_MS,
    voiceWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStream: STREAM_URL,
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    business: BUSINESS.name,
    clientId: process.env.OCM_CLIENT_ID,
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    codec: 'PCMU',
    speechSpeed: SPEECH_SPEED,
    silenceDurationMs: SILENCE_DURATION_MS,
    hasBusinessInfo: Boolean(String(process.env.BUSINESS_INFO || '').trim()),
    hasCustomScript: Boolean(String(process.env.RECEPTIONIST_SCRIPT || '').trim()),
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasTelnyxKey: Boolean(process.env.TELNYX_API_KEY),
    hasOcmConnection: Boolean(process.env.OCM_CONNECTION_KEY),
    activeCalls: activeCalls.size,
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
        stream_bidirectional_sampling_rate: 8000,
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
    pendingNaturalResponse: false,
    hangupAfterResponse: false,
    responseSequence: 0,
    openAiGenerating: false,
    openAiAudioDone: false,
    audioBuffer: Buffer.alloc(0),
    audioPumpTimer: null,
    audioPumpStarted: false,
    waitingForPlaybackMark: false,
    playbackMarkName: '',
    assistantItemId: '',
    assistantAudioSentMs: 0,
    assistantAudioStartedAt: 0,
    userSpeechStartedAt: 0,
    userSpeechStartedWhileAssistant: false,
    bargeInTimer: null,
    bargeInConfirmed: false,
    transcriptTimer: null,
    awaitingTranscript: false,
    holdMode: false,
    lastCallerTranscript: '',
    leadSaved: false,
    leadSaveFailed: false,
    handledCalls: new Set(),
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

    if (event === 'mark') {
      const name = message.mark?.name || '';
      if (ctx.waitingForPlaybackMark && name === ctx.playbackMarkName) completeAssistantPlayback(ctx);
      return;
    }

    if (event === 'stop' || event === 'streaming.stopped') telnyx.close();
  });

  const cleanup = () => {
    cancelBargeInTimer(ctx);
    clearTranscriptTimer(ctx);
    clearLocalAudio(ctx);
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
  console.log(`${BUSINESS.name} receptionist listening on ${PORT}`);
  console.log(`Model: ${REALTIME_MODEL}; voice: ${REALTIME_VOICE}`);
  console.log(`Codec: PCMU 8 kHz; speech speed: ${SPEECH_SPEED}; silence: ${SILENCE_DURATION_MS}ms`);
  console.log(`Webhook: ${PUBLIC_URL}/voice-api-webhook`);
});
