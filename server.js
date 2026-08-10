import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { buildArcRuntimeForward } from './arc-runtime.js';
import { createBusinessContext } from './business-context.js';
import { createOpenAiReceptionist } from './openai-receptionist.js';

const PORT = Number(process.env.PORT || 3000);
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const PUBLIC_URL = resolvePublicUrl();
const MEDIA_STREAM_URL = PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const ARC_RUNTIME_URL = clean(process.env.RECEPTIONIST_CONFIG_URL || process.env.ARC_RUNTIME_URL);
const ARC_INTAKE_URL = clean(process.env.ARC_INTAKE_URL);
const GOODBYE_MARK_TIMEOUT_MS = 10_000;
const MAX_CALL_DURATION_SECONDS = boundedInteger(
  process.env.MAX_CALL_DURATION_SECONDS,
  480,
  120,
  3_600,
);

function clean(value) {
  return String(value ?? '').trim();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function resolvePublicUrl() {
  const configured = clean(process.env.PUBLIC_URL);
  const railwayDomain = clean(process.env.RAILWAY_PUBLIC_DOMAIN);
  const raw = configured || (railwayDomain ? `https://${railwayDomain}` : '');
  if (!raw) throw new Error('PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN is required.');
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

function requireEnvironment() {
  const missing = [
    ['TELNYX_API_KEY', process.env.TELNYX_API_KEY],
    ['OPENAI_API_KEY', process.env.OPENAI_API_KEY],
    ['RECEPTIONIST_CONFIG_URL or ARC_RUNTIME_URL', ARC_RUNTIME_URL],
  ].filter(([, value]) => !clean(value)).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
}

function callControlId(body = {}) {
  return clean(
    body?.data?.payload?.call_control_id
    || body?.payload?.call_control_id
    || body?.call_control_id,
  );
}

function eventType(body = {}) {
  return clean(body?.data?.event_type || body?.event_type);
}

function phoneValue(value) {
  if (Array.isArray(value)) return phoneValue(value[0]);
  if (value && typeof value === 'object') {
    return value.phone_number || value.number || value.phone || '';
  }
  return value || '';
}

function calledPhone(body = {}) {
  return clean(phoneValue(
    body?.data?.payload?.to || body?.payload?.to || body?.start?.to || body?.to,
  ));
}

function callerPhone(body = {}) {
  return clean(phoneValue(
    body?.data?.payload?.from || body?.payload?.from || body?.start?.from || body?.from,
  ));
}

async function telnyxCommand(id, action, payload = {}) {
  const response = await fetch(
    `${TELNYX_API_BASE}/calls/${encodeURIComponent(id)}/actions/${action}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Telnyx ${action} failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchArcRuntime(runtimeForward) {
  const forwarded = buildArcRuntimeForward(runtimeForward);
  const response = await fetch(ARC_RUNTIME_URL, {
    method: 'POST',
    headers: forwarded.headers,
    body: forwarded.body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`ARC runtime returned invalid JSON (${response.status}).`);
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `ARC runtime request failed: ${response.status}`);
  }
  return data.runtime && typeof data.runtime === 'object'
    ? { ...data.runtime, ok: data.ok }
    : data;
}

function arcIntakeConnection(runtime = {}) {
  return {
    url: clean(
      runtime.intakeUrl
      || runtime.intake?.url
      || runtime.endpoints?.intake
      || ARC_INTAKE_URL,
    ),
  };
}

async function sendArcData(runtime, payload, { idempotencyKey = '' } = {}) {
  const connection = arcIntakeConnection(runtime);
  if (!connection.url) throw new Error('No ARC intake endpoint is configured.');

  const response = await fetch(connection.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`ARC intake returned invalid JSON (${response.status}).`);
    }
  }
  if (!response.ok || data.ok === false || data.success === false) {
    throw new Error(data.error || `ARC intake request failed: ${response.status}`);
  }
  return data;
}

requireEnvironment();

const app = express();
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

const calls = new Map();

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: 'ai-receptionist',
    voiceWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStream: MEDIA_STREAM_URL,
    arcRuntime: ARC_RUNTIME_URL,
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'ai-receptionist',
    hasTelnyxKey: Boolean(process.env.TELNYX_API_KEY),
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasArcRuntime: Boolean(ARC_RUNTIME_URL),
    maxCallDurationSeconds: MAX_CALL_DURATION_SECONDS,
    activeCalls: calls.size,
  });
});

async function beginCall(body, id, runtimeForward = {}) {
  if (calls.has(id)) return;

  const call = {
    id,
    callerPhone: callerPhone(body),
    calledPhone: calledPhone(body),
    runtime: null,
    context: null,
    receptionist: null,
    status: 'loading',
    ended: false,
    costLimitTimer: null,
    goodbyeTimer: null,
    hangupRequested: false,
    endReason: '',
    openAiUsage: null,
    transcript: [],
  };
  calls.set(id, call);

  try {
    call.runtime = await fetchArcRuntime({ event: body, ...runtimeForward });
    if (call.ended || calls.get(id) !== call) return;

    call.context = createBusinessContext(call.runtime);
    await telnyxCommand(id, 'answer');
    await telnyxCommand(id, 'streaming_start', {
      stream_url: `${MEDIA_STREAM_URL}?callControlId=${encodeURIComponent(id)}`,
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: 'PCMU',
    });
    call.status = 'streaming';
    call.costLimitTimer = setTimeout(() => {
      stopForCostLimit(call, 'duration-limit');
    }, MAX_CALL_DURATION_SECONDS * 1_000);
    call.costLimitTimer.unref?.();
  } catch (error) {
    console.error('[Call startup failed]', error.message);
    if (calls.get(id) === call) calls.delete(id);
    try { await telnyxCommand(id, 'hangup'); } catch {}
  }
}

function stopForCostLimit(call, reason) {
  if (!call || call.ended || calls.get(call.id) !== call) return;
  call.status = reason;
  call.receptionist?.close();
  call.receptionist = null;
  requestHangup(call, reason, 'Cost-limit hangup failed');
}

function requestHangup(call, reason, errorLabel = 'Hangup failed') {
  if (!call || call.ended || call.hangupRequested || calls.get(call.id) !== call) return;
  call.hangupRequested = true;
  call.endReason = reason;
  call.status = reason;
  void telnyxCommand(call.id, 'hangup')
    .catch((error) => console.error(`[${errorLabel}]`, error.message))
    .finally(() => endCall(call.id, reason));
}

function endCall(id, reason = 'hangup') {
  const call = calls.get(id);
  if (!call) return;
  const finalReason = call.endReason || reason;
  call.ended = true;
  call.status = finalReason;
  if (call.costLimitTimer) clearTimeout(call.costLimitTimer);
  if (call.goodbyeTimer) clearTimeout(call.goodbyeTimer);
  call.costLimitTimer = null;
  call.goodbyeTimer = null;
  call.receptionist?.close();
  call.receptionist = null;
  calls.delete(id);
  console.log('[Call transcript]', JSON.stringify({
    reason: finalReason,
    callControlId: call.id,
    callerPhone: call.callerPhone,
    entries: call.transcript,
  }));
  if (call.openAiUsage) {
    console.log('[Call OpenAI usage]', JSON.stringify({
      reason: finalReason,
      ...call.openAiUsage,
    }));
  }
}

app.post('/voice-api-webhook', (req, res) => {
  res.sendStatus(200);
  const type = eventType(req.body);
  const id = callControlId(req.body);
  if (!id) return;

  if (type === 'call.initiated') {
    void beginCall(req.body, id, {
      rawBody: req.rawBody,
      telnyxSignature: req.get('telnyx-signature-ed25519'),
      telnyxTimestamp: req.get('telnyx-timestamp'),
    });
    return;
  }
  if (type === 'call.hangup') endCall(id, calls.get(id)?.endReason || 'hangup');
});

app.post('/arc/send', async (req, res) => {
  try {
    const id = clean(req.body?.callControlId);
    const call = calls.get(id);
    const data = await sendArcData(
      call?.runtime,
      req.body?.payload ?? req.body,
      { idempotencyKey: clean(req.get('Idempotency-Key')) },
    );
    res.json({ ok: true, data });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/media-stream') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', (telnyx, request) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const queryCallId = clean(url.searchParams.get('callControlId'));
  let call = calls.get(queryCallId);
  let receptionist = null;
  let endMarkName = '';

  function sendTelnyx(value) {
    if (telnyx.readyState !== WebSocket.OPEN) return false;
    telnyx.send(JSON.stringify(value));
    return true;
  }

  function recordTranscript(entry = {}) {
    if (!call || call.ended) return;
    const text = String(entry.text ?? '').trim();
    if (!text) return;
    const saved = {
      at: new Date().toISOString(),
      speaker: entry.speaker === 'caller' ? 'caller' : 'receptionist',
      text,
      ...(clean(entry.itemId) ? { itemId: clean(entry.itemId) } : {}),
      ...(clean(entry.responseId) ? { responseId: clean(entry.responseId) } : {}),
    };
    call.transcript.push(saved);
    console.log('[Call transcript line]', JSON.stringify({
      callControlId: call.id,
      ...saved,
    }));
  }

  function finishAfterGoodbye() {
    if (!call || call.ended || call.hangupRequested) return;
    call.endReason = 'completed';
    call.status = 'goodbye-playing';
    endMarkName = `end-call-${Date.now()}`;
    const markSent = sendTelnyx({ event: 'mark', mark: { name: endMarkName } });
    if (!markSent) {
      requestHangup(call, 'completed', 'Goodbye hangup failed');
      return;
    }
    call.goodbyeTimer = setTimeout(() => {
      requestHangup(call, 'completed', 'Goodbye fallback hangup failed');
    }, GOODBYE_MARK_TIMEOUT_MS);
    call.goodbyeTimer.unref?.();
  }

  function closeReceptionist(reason = 'media-closed') {
    receptionist?.close();
    if (call?.receptionist === receptionist) call.receptionist = null;
    receptionist = null;
    if (call && !call.ended && call.status === 'active') call.status = reason;
  }

  function startReceptionist(start = {}) {
    const mediaCallId = clean(start.call_control_id);
    if ((!call || call.id !== mediaCallId) && mediaCallId) call = calls.get(mediaCallId);
    if (!call?.runtime || !call?.context) {
      telnyx.close(1008, 'Unknown call');
      return;
    }
    if (receptionist) return;

    const encoding = clean(start.media_format?.encoding).toUpperCase();
    if (encoding && encoding !== 'PCMU') {
      telnyx.close(1003, 'PCMU audio required');
      return;
    }

    receptionist = createOpenAiReceptionist({
      context: call.context,
      runtime: call.runtime,
      callControlId: call.id,
      callerPhone: call.callerPhone,
      deliver: (payload, options) => sendArcData(call.runtime, payload, options),
      onAudio: (payload) => sendTelnyx({ event: 'media', media: { payload } }),
      onPlaybackClear: () => sendTelnyx({ event: 'clear' }),
      onSubmitted: () => { call.status = 'submitted'; },
      onReady: () => {
        if (call.status === 'streaming') call.status = 'active';
      },
      onTranscript: recordTranscript,
      onGoodbyeComplete: finishAfterGoodbye,
      onCostLimit: ({ reason }) => stopForCostLimit(call, reason),
      onUsage: (usage) => { call.openAiUsage = usage; },
      onLatency: (latency) => console.log('[Call latency]', JSON.stringify({
        callControlId: call.id,
        ...latency,
      })),
      onError: (error) => console.error('[Receptionist error]', error.message),
    });
    call.receptionist = receptionist;
  }

  telnyx.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.event === 'start') {
      startReceptionist(message.start);
      return;
    }
    if (message.event === 'media') {
      if (!receptionist) startReceptionist(message.start || {});
      const track = clean(message.media?.track).toLowerCase();
      if (track && !track.startsWith('inbound')) return;
      receptionist?.appendCallerAudio(message.media?.payload);
      return;
    }
    if (message.event === 'stop') {
      closeReceptionist('media-stopped');
      return;
    }
    if (message.event === 'mark' && endMarkName && message.mark?.name === endMarkName) {
      endMarkName = '';
      if (call?.goodbyeTimer) clearTimeout(call.goodbyeTimer);
      if (call) call.goodbyeTimer = null;
      requestHangup(call, 'completed', 'Goodbye hangup failed');
      return;
    }
    if (message.event === 'error') {
      console.error('[Telnyx media error]', clean(message.payload?.detail || message.payload?.title));
    }
  });

  telnyx.on('close', () => closeReceptionist());
  telnyx.on('error', (error) => {
    console.error('[Telnyx WebSocket error]', error.message);
    closeReceptionist('media-error');
  });
});

server.listen(PORT, () => {
  console.log(`AI receptionist listening on port ${PORT}`);
});
