import 'dotenv/config';
import http from 'http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { callUsageOutcome, durationSeconds } from './call-policy.js';
import {
  loadRuntimeFromSignedTelnyxEvent,
  prepareCallRuntime,
  runtimeEndpoint,
} from './runtime-loader.js';
import { MODELS } from './modular-models.js';
import { createVoicePipeline } from './voice-pipeline-controller.js';
import { normalizePhone as normalizeIntakePhone } from './intake-schema.js';
import { deliverIntake } from './ocm-delivery.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = resolvePublicUrl();
const STREAM_URL = PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const MAX_PENDING_INPUT_CHUNKS = 250;
const CALL_WARNING_MS = 5.5 * 60 * 1000;
const CALL_HARD_LIMIT_MS = 6 * 60 * 1000;
const CALL_WARNING_RETRY_MS = 5000;
const POST_SUBMISSION_GRACE_MS = 90 * 1000;
const STREAM_TOKEN_TTL_MS = 2 * 60 * 1000;
const CALL_METADATA_TTL_MS = 15 * 60 * 1000;
const WEBHOOK_DEDUPE_TTL_MS = 15 * 60 * 1000;
const CALL_WARNING_LINE = "I'm sorry. But this call will abruptly end in about thirty seconds to prevent spamming. If you haven't filled an estimate request or have more questions or wish to do so, please call again.";

const activeCalls = new Map();
const activeCallsByControlId = new Map();
const callMetadata = new Map();
const processedWebhookEvents = new Map();

function clean(value) {
  return String(value ?? '').trim();
}

function debug(event, payload = {}) {
  console.log('[Modular server debug]', JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...payload,
  }));
}

function resolvePublicUrl() {
  const configured = clean(process.env.PUBLIC_URL);
  const railwayDomain = clean(process.env.RAILWAY_PUBLIC_DOMAIN);
  const raw = configured || (railwayDomain ? `https://${railwayDomain}` : '');
  if (!raw) {
    throw new Error('PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN is required.');
  }

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
  ].filter(([, value]) => !clean(value)).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing required runtime configuration: ${missing.join(', ')}`);
  }
}

function normalizePhone(value) {
  return normalizeIntakePhone(value);
}

function phoneValue(candidate) {
  if (Array.isArray(candidate)) return phoneValue(candidate[0]);
  if (candidate && typeof candidate === 'object') {
    return candidate.phone_number || candidate.number || candidate.phone || '';
  }
  return candidate || '';
}

function getCallerPhone(payload = {}) {
  const candidates = [
    payload?.data?.payload?.from,
    payload?.payload?.from,
    payload?.start?.from,
    payload?.start?.caller_id_number,
    payload?.from,
    payload?.caller_id_number,
  ];
  return normalizePhone(phoneValue(candidates.find((value) => clean(phoneValue(value)))));
}

function getCalledPhone(payload = {}) {
  const candidates = [
    payload?.data?.payload?.to,
    payload?.payload?.to,
    payload?.start?.to,
    payload?.start?.called_number,
    payload?.to,
    payload?.called_number,
  ];
  return normalizePhone(phoneValue(candidates.find((value) => clean(phoneValue(value)))));
}

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

function webhookEventId(body) {
  return clean(body?.data?.id || body?.id);
}

function rememberWebhookEvent(body) {
  const id = webhookEventId(body);
  if (!id) return true;
  if (processedWebhookEvents.has(id)) return false;
  processedWebhookEvents.set(id, Date.now());
  return true;
}

function streamSignature(callId, expiresAt) {
  return createHmac('sha256', process.env.TELNYX_API_KEY)
    .update(`${callId}:${expiresAt}`)
    .digest('hex');
}

function streamUrlForCall(callId) {
  const expiresAt = Date.now() + STREAM_TOKEN_TTL_MS;
  const url = new URL(STREAM_URL);
  url.searchParams.set('callId', callId);
  url.searchParams.set('expires', String(expiresAt));
  url.searchParams.set('signature', streamSignature(callId, expiresAt));
  return url.toString();
}

function verifiedStreamCallId(requestUrl, host = 'localhost') {
  let url;
  try {
    url = new URL(requestUrl || '/', `http://${host}`);
  } catch {
    return '';
  }
  const callId = clean(url.searchParams.get('callId'));
  const expiresAt = Number(url.searchParams.get('expires'));
  const provided = clean(url.searchParams.get('signature'));
  if (!callId || !Number.isFinite(expiresAt) || expiresAt < Date.now() || expiresAt > Date.now() + STREAM_TOKEN_TTL_MS) {
    return '';
  }
  const expected = streamSignature(callId, expiresAt);
  if (provided.length !== expected.length) return '';
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex')) ? callId : '';
  } catch {
    return '';
  }
}

function rememberCall(body) {
  const id = callControlId(body);
  if (!id) return;
  const previous = callMetadata.get(id) || {};
  callMetadata.set(id, {
    ...previous,
    callerPhone: getCallerPhone(body) || previous.callerPhone || '',
    calledPhone: getCalledPhone(body) || previous.calledPhone || '',
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
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Telnyx ${action} failed: ${response.status} ${await response.text()}`);
}

async function postUsageAction(ctx, payload, attempts = 3) {
  const usageUrl = clean(ctx.runtimeData?.usageUrl);
  if (!usageUrl) return null;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(usageUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ctx.runtimeData.usageToken ? { Authorization: `Bearer ${ctx.runtimeData.usageToken}` } : {}),
        },
        body: JSON.stringify({ clientId: ctx.runtimeData.clientId, callSessionId: ctx.callControlId || ctx.id, ...payload }),
        signal: AbortSignal.timeout(4000),
      });
      const raw = await response.text();
      const data = raw ? JSON.parse(raw) : {};
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `ARK OCM usage request failed: ${response.status}`);
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 350));
    }
  }
  throw lastError || new Error('ARK OCM usage request failed.');
}

async function reportCallUsage(ctx) {
  if (!ctx.startedAt || ctx.usageReported || !ctx.runtime?.core) return;
  if (ctx.usageReportPromise) return ctx.usageReportPromise;

  const snapshot = ctx.pipeline?.snapshot?.();
  if (snapshot?.memory?.leadSaved) ctx.leadSaved = true;

  const endedAt = Date.now();
  const payload = {
    action: 'record',
    callId: ctx.callControlId || ctx.id,
    callerPhone: ctx.callerPhone,
    durationSeconds: durationSeconds(ctx.startedAt, endedAt),
    leadSaved: ctx.leadSaved,
    outcome: callUsageOutcome({ leadSaved: ctx.leadSaved, endReason: ctx.endReason }),
    endReason: ctx.endReason || 'remote-hangup',
    timeZone: ctx.runtime.core.BUSINESS.timeZone,
    startedAt: new Date(ctx.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
  };

  ctx.usageReportPromise = postUsageAction(ctx, payload, 3)
    .then((result) => {
      ctx.usageReported = true;
      debug('call.usage_saved', {
        clientId: ctx.runtimeData.clientId,
        callId: ctx.callControlId || ctx.id,
        durationSeconds: payload.durationSeconds,
        outcome: payload.outcome,
        blocked: result?.blocked === true,
      });
    })
    .catch((error) => console.error('[Call usage save failed]', error.message))
    .finally(() => {
      ctx.usageReportPromise = null;
    });

  return ctx.usageReportPromise;
}

function clearCallTimers(ctx) {
  if (ctx.warningTimer) clearTimeout(ctx.warningTimer);
  if (ctx.hardLimitTimer) clearTimeout(ctx.hardLimitTimer);
  ctx.warningTimer = null;
  ctx.hardLimitTimer = null;
}

function sendJson(ws, value) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(value));
  return true;
}

function sendTelnyx(ctx, event) {
  if (ctx.streamId) event.stream_id = ctx.streamId;
  return sendJson(ctx.telnyx, event);
}

function requestHangup(ctx, reason = 'completed') {
  if (ctx.ending || ctx.cleanedUp) return;
  ctx.ending = true;
  ctx.endReason = ctx.endReason || reason;
  clearCallTimers(ctx);
  ctx.pipeline?.stop?.(ctx.endReason);
  debug('call.hangup_requested', {
    callId: ctx.callControlId || ctx.id,
    reason: ctx.endReason,
  });

  if (ctx.callControlId) {
    telnyxCommand(ctx.callControlId, 'hangup')
      .catch((error) => {
        console.error('[Hangup failed]', error.message);
        try { ctx.telnyx.close(); } catch {}
      });
  } else {
    try { ctx.telnyx.close(); } catch {}
  }
}

function scheduleCallWarning(ctx, delayMs = CALL_WARNING_MS) {
  if (ctx.warningTimer) clearTimeout(ctx.warningTimer);
  ctx.warningTimer = setTimeout(() => {
    ctx.warningTimer = null;
    if (ctx.cleanedUp || ctx.ending || ctx.leadSaved) return;
    const snapshot = ctx.pipeline?.snapshot?.();
    if (snapshot?.speaking || snapshot?.ttsPending || snapshot?.interpreting) {
      debug('call.warning_deferred', {
        callId: ctx.callControlId || ctx.id,
        currentQuestionId: snapshot?.memory?.currentQuestionId,
      });
      scheduleCallWarning(ctx, CALL_WARNING_RETRY_MS);
      return;
    }
    debug('call.warning_30_seconds', { callId: ctx.callControlId || ctx.id });
    ctx.pipeline?.announce?.(CALL_WARNING_LINE)
      .catch((error) => console.error('[Call warning failed]', error.message));
  }, delayMs);
}

function startCallTimers(ctx) {
  if (ctx.startedAt) return;
  ctx.startedAt = Date.now();
  scheduleCallWarning(ctx);
  ctx.hardLimitTimer = setTimeout(() => requestHangup(ctx, 'max-duration'), CALL_HARD_LIMIT_MS);
}

function grantPostSubmissionGrace(ctx) {
  if (ctx.cleanedUp || ctx.ending) return;
  if (ctx.warningTimer) clearTimeout(ctx.warningTimer);
  if (ctx.hardLimitTimer) clearTimeout(ctx.hardLimitTimer);
  ctx.warningTimer = null;

  const originalDeadline = Number(ctx.startedAt || Date.now()) + CALL_HARD_LIMIT_MS;
  const graceDeadline = Date.now() + POST_SUBMISSION_GRACE_MS;
  const delayMs = Math.max(1000, Math.max(originalDeadline, graceDeadline) - Date.now());
  ctx.hardLimitTimer = setTimeout(() => requestHangup(ctx, 'max-duration'), delayMs);
  debug('call.post_submission_grace_started', {
    callId: ctx.callControlId || ctx.id,
    graceSeconds: Math.round(delayMs / 1000),
  });
}

async function saveLead(ctx, { payload }) {
  const result = await deliverIntake({
    url: ctx.runtimeData?.intakeUrl,
    token: ctx.runtimeData?.intakeToken,
    clientId: ctx.runtimeData?.clientId,
    callSessionId: ctx.callControlId || ctx.id,
    payload,
  });

  ctx.leadSaved = true;
  ctx.intakeRequestId = result.intakeRequestId;
  grantPostSubmissionGrace(ctx);
  debug('lead.saved', {
    callId: ctx.callControlId || ctx.id,
    clientId: ctx.runtimeData.clientId,
    intakeRequestId: result.intakeRequestId,
    intakeId: clean(result.data.intakeId || result.data.id),
  });
  return result.data;
}

assertRuntimeConfiguration();

const app = express();
app.use(express.json({
  limit: '2mb',
  verify: (request, _response, buffer) => {
    request.rawBody = buffer.toString('utf8');
  },
}));
app.use(express.urlencoded({ extended: false }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    provider: 'Telnyx',
    architecture: 'realtime interpretation -> fixed question controller -> speech API',
    models: MODELS,
    codec: 'PCMU 8 kHz',
    voiceWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStream: STREAM_URL,
    runtimeEndpoint: runtimeEndpoint(),
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    architecture: 'realtime-interpretation-with-fixed-flow',
    realtimeVoiceModel: MODELS.realtimeVoice,
    realtimeModel: MODELS.realtime,
    brainModel: MODELS.brain,
    codec: 'PCMU',
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasTelnyxKey: Boolean(process.env.TELNYX_API_KEY),
    activeCalls: activeCalls.size,
    mappedCalls: [...callMetadata.values()].filter((entry) => entry.runtimeData).length,
    callMaximumSeconds: CALL_HARD_LIMIT_MS / 1000,
    postSubmissionGraceSeconds: POST_SUBMISSION_GRACE_MS / 1000,
  });
});

app.post('/voice-api-webhook', async (req, res) => {
  res.sendStatus(200);
  if (!rememberWebhookEvent(req.body)) return;
  const type = eventType(req.body);
  const id = callControlId(req.body);
  rememberCall(req.body);
  if (!id) return;

  try {
    const previous = callMetadata.get(id) || {};
    if (type === 'call.initiated') {
      if (previous.rejected) return;
      const rawBody = clean(req.rawBody) || JSON.stringify(req.body || {});
      const runtimeData = await loadRuntimeFromSignedTelnyxEvent({
        rawBody,
        signature: clean(req.headers['telnyx-signature-ed25519']),
        timestamp: clean(req.headers['telnyx-timestamp']),
      });
      const eventCalledPhone = getCalledPhone(req.body);
      const matchedCalledPhone = normalizePhone(runtimeData.calledPhone);
      if (eventCalledPhone && matchedCalledPhone && eventCalledPhone !== matchedCalledPhone) {
        throw new Error('ARK OCM matched a different called phone number.');
      }
      callMetadata.set(id, {
        ...previous,
        callerPhone: getCallerPhone(req.body) || previous.callerPhone || '',
        calledPhone: runtimeData.calledPhone || getCalledPhone(req.body) || previous.calledPhone || '',
        runtimeData,
        updatedAt: Date.now(),
      });
      debug('receptionist.matched', {
        callId: id,
        clientId: runtimeData.clientId,
        business: runtimeData.profile?.businessName,
      });
      await telnyxCommand(id, 'answer');
      return;
    }

    const metadata = callMetadata.get(id) || previous;
    if (type === 'call.answered' && !metadata.rejected) {
      if (!metadata.runtimeData) throw new Error('No ARK OCM receptionist profile was loaded for this call.');
      await telnyxCommand(id, 'streaming_start', {
        stream_url: streamUrlForCall(id),
        stream_track: 'inbound_track',
        stream_codec: 'PCMU',
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: 'PCMU',
        stream_bidirectional_sampling_rate: 8000,
        stream_bidirectional_target_legs: 'self',
        send_silence_when_idle: true,
      });
    }

    if (type === 'call.hangup' || type === 'streaming.stopped') {
      const ctx = activeCallsByControlId.get(id);
      if (ctx) {
        ctx.endReason = ctx.endReason || 'remote-hangup';
        reportCallUsage(ctx).catch(() => null);
      }
      callMetadata.delete(id);
    }
  } catch (error) {
    console.error('[Telnyx webhook]', type, error.message);
    const metadata = callMetadata.get(id) || {};
    callMetadata.set(id, { ...metadata, rejected: true, error: error.message, updatedAt: Date.now() });
    if (type === 'call.initiated') {
      telnyxCommand(id, 'reject', { cause: 'CALL_REJECTED' })
        .catch((rejectError) => console.error('[Telnyx reject]', rejectError.message));
    } else {
      telnyxCommand(id, 'hangup')
        .catch((hangupError) => console.error('[Telnyx setup hangup]', hangupError.message));
    }
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/media-stream') return socket.destroy();
  const linkedCallControlId = verifiedStreamCallId(request.url, request.headers.host);
  if (!linkedCallControlId || !callMetadata.has(linkedCallControlId)) return socket.destroy();
  request.arkCallControlId = linkedCallControlId;
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', (telnyx, request) => {
  const ctx = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    telnyx,
    runtime: null,
    runtimeData: null,
    pipeline: null,
    initializing: null,
    initialized: false,
    streamId: '',
    callControlId: clean(request?.arkCallControlId),
    callerPhone: '',
    calledPhone: '',
    pendingInputAudio: [],
    startedAt: 0,
    warningTimer: null,
    hardLimitTimer: null,
    ending: false,
    endReason: '',
    leadSaved: false,
    usageReported: false,
    usageReportPromise: null,
    cleanedUp: false,
  };

  activeCalls.set(ctx.id, ctx);

  async function initializeFromStart(message) {
    if (ctx.initialized) return;
    if (ctx.initializing) return ctx.initializing;

    ctx.initializing = (async () => {
      ctx.streamId = message.stream_id || message.start?.stream_id || ctx.streamId;
      ctx.callControlId = ctx.callControlId || callControlId(message);
      const remembered = callMetadata.get(ctx.callControlId) || {};
      ctx.callerPhone = getCallerPhone(message) || remembered.callerPhone || ctx.callerPhone;
      ctx.calledPhone = getCalledPhone(message) || remembered.calledPhone || ctx.calledPhone;
      ctx.runtimeData = remembered.runtimeData || null;
      if (!ctx.runtimeData) throw new Error('The media stream has no matched ARK OCM receptionist profile.');

      ctx.runtime = await prepareCallRuntime(ctx.runtimeData);
      ctx.pipeline = createVoicePipeline({
        runtime: ctx.runtime,
        callerPhone: ctx.callerPhone,
        sendAudioFrame: (frame) => {
          if (ctx.ending || ctx.cleanedUp) return;
          sendTelnyx(ctx, {
            event: 'media',
            media: { payload: frame.toString('base64') },
          });
        },
        clearAudio: () => {
          if (!ctx.ending && !ctx.cleanedUp) sendTelnyx(ctx, { event: 'clear' });
        },
        saveLead: (leadData) => saveLead(ctx, leadData),
        endCall: (reason) => requestHangup(ctx, reason),
        log: console,
      });

      ctx.initialized = true;
      if (ctx.callControlId) activeCallsByControlId.set(ctx.callControlId, ctx);
      startCallTimers(ctx);
      debug('call.runtime_ready', {
        callId: ctx.callControlId || ctx.id,
        clientId: ctx.runtimeData.clientId,
        business: ctx.runtime.core.BUSINESS.name,
        realtimeVoiceModel: MODELS.realtimeVoice,
        brainModel: MODELS.brain,
        voice: ctx.runtime.core.REALTIME_VOICE || MODELS.voice,
      });

      await ctx.pipeline.start();
      const pending = ctx.pendingInputAudio.splice(0);
      pending.forEach((audio) => ctx.pipeline.appendCallerAudio(audio));
    })().catch((error) => {
      ctx.endReason = 'configuration-error';
      console.error('[Call setup]', error.stack || error.message);
      try { telnyx.close(); } catch {}
      throw error;
    });

    return ctx.initializing;
  }

  telnyx.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const event = message.event || message.event_type || message.type;
    if (event === 'start' || event === 'connected' || event === 'streaming.started') {
      initializeFromStart(message).catch(() => null);
      return;
    }

    if (event === 'media') {
      const track = clean(message.media?.track).toLowerCase();
      if (track.includes('outbound')) return;
      const audio = message.media?.payload || message.payload || message.audio;
      if (!audio || ctx.ending) return;
      if (ctx.pipeline) ctx.pipeline.appendCallerAudio(audio);
      else if (ctx.pendingInputAudio.length < MAX_PENDING_INPUT_CHUNKS) ctx.pendingInputAudio.push(audio);
      return;
    }

    if (event === 'stop' || event === 'disconnected' || event === 'streaming.stopped') {
      ctx.endReason = ctx.endReason || 'remote-hangup';
      try { telnyx.close(); } catch {}
    }
  });

  telnyx.on('close', () => {
    if (ctx.cleanedUp) return;
    ctx.cleanedUp = true;
    ctx.pipeline?.stop?.(ctx.endReason || 'remote-hangup');
    clearCallTimers(ctx);
    activeCalls.delete(ctx.id);
    if (ctx.callControlId) activeCallsByControlId.delete(ctx.callControlId);
    debug('telnyx.closed', {
      callId: ctx.callControlId || ctx.id,
      clientId: ctx.runtimeData?.clientId,
      endReason: ctx.endReason || 'remote-hangup',
      leadSaved: ctx.leadSaved,
    });
    reportCallUsage(ctx).catch(() => null);
  });

  telnyx.on('error', (error) => {
    ctx.endReason = ctx.endReason || 'media-error';
    console.error('[Telnyx media socket]', error.message);
  });
});

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now();
  for (const [id, metadata] of callMetadata) {
    if (cutoff - Number(metadata.updatedAt || 0) > CALL_METADATA_TTL_MS) callMetadata.delete(id);
  }
  for (const [id, seenAt] of processedWebhookEvents) {
    if (cutoff - seenAt > WEBHOOK_DEDUPE_TTL_MS) processedWebhookEvents.delete(id);
  }
}, 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, () => {
  console.log(`Modular AI receptionist listening on ${PORT}`);
  console.log(`Voice webhook: ${PUBLIC_URL}/voice-api-webhook`);
  console.log(`Media stream: ${STREAM_URL}`);
  console.log(`ARK OCM runtime lookup: ${runtimeEndpoint()}`);
  console.log(`Model: ${MODELS.realtimeVoice} with fixed intake controller`);
});
