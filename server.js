import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const PUBLIC_URL = resolvePublicUrl();
const MEDIA_STREAM_URL = PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const ARC_RUNTIME_URL = clean(process.env.RECEPTIONIST_CONFIG_URL || process.env.ARC_RUNTIME_URL);
const ARC_RUNTIME_SECRET = clean(process.env.RECEPTIONIST_CONFIG_SECRET || process.env.ARC_RUNTIME_SECRET);
const ARC_INTAKE_URL = clean(process.env.ARC_INTAKE_URL);
const ARC_INTAKE_TOKEN = clean(process.env.ARC_INTAKE_TOKEN);

function clean(value) {
  return String(value ?? '').trim();
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
    ['RECEPTIONIST_CONFIG_URL or ARC_RUNTIME_URL', ARC_RUNTIME_URL],
  ].filter(([, value]) => !clean(value)).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
}

function callControlId(body = {}) {
  return clean(body?.data?.payload?.call_control_id || body?.payload?.call_control_id || body?.call_control_id);
}

function eventType(body = {}) {
  return clean(body?.data?.event_type || body?.event_type);
}

function phoneValue(value) {
  if (Array.isArray(value)) return phoneValue(value[0]);
  if (value && typeof value === 'object') return value.phone_number || value.number || value.phone || '';
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
  const response = await fetch(`${TELNYX_API_BASE}/calls/${encodeURIComponent(id)}/actions/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Telnyx ${action} failed: ${response.status} ${await response.text()}`);
}

async function fetchArcRuntime(payload) {
  const response = await fetch(ARC_RUNTIME_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ARC_RUNTIME_SECRET ? { Authorization: `Bearer ${ARC_RUNTIME_SECRET}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) throw new Error(data.error || `ARC runtime request failed: ${response.status}`);
  return data;
}

async function sendArcData(runtime, payload) {
  const url = clean(runtime?.intakeUrl || ARC_INTAKE_URL);
  if (!url) throw new Error('No ARC intake endpoint is configured.');
  const token = clean(runtime?.intakeToken || ARC_INTAKE_TOKEN);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) throw new Error(data.error || `ARC intake request failed: ${response.status}`);
  return data;
}

requireEnvironment();

const app = express();
app.use(express.json({ limit: '2mb' }));

const calls = new Map();

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: 'transport-shell',
    voiceWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStream: MEDIA_STREAM_URL,
    arcRuntime: ARC_RUNTIME_URL,
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'transport-shell',
    hasTelnyxKey: Boolean(process.env.TELNYX_API_KEY),
    hasArcRuntime: Boolean(ARC_RUNTIME_URL),
    activeCalls: calls.size,
  });
});

app.post('/voice-api-webhook', async (req, res) => {
  res.sendStatus(200);
  const type = eventType(req.body);
  const id = callControlId(req.body);
  if (!id) return;

  if (type === 'call.initiated') {
    const runtime = await fetchArcRuntime({
      event: req.body,
      calledPhone: calledPhone(req.body),
      callerPhone: callerPhone(req.body),
      callControlId: id,
    });
    calls.set(id, { runtime, callerPhone: callerPhone(req.body), calledPhone: calledPhone(req.body) });
    await telnyxCommand(id, 'answer');
    await telnyxCommand(id, 'streaming_start', {
      stream_url: `${MEDIA_STREAM_URL}?callControlId=${encodeURIComponent(id)}`,
      stream_track: 'both_tracks',
      enable_dialogflow: false,
    });
    return;
  }

  if (type === 'call.hangup') calls.delete(id);
});

app.post('/arc/send', async (req, res) => {
  try {
    const id = clean(req.body?.callControlId);
    const call = calls.get(id);
    const data = await sendArcData(call?.runtime, req.body?.payload ?? req.body);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
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
  const id = clean(url.searchParams.get('callControlId'));
  const call = calls.get(id);
  const arcSocketUrl = clean(call?.runtime?.mediaWebSocketUrl || call?.runtime?.webSocketUrl || process.env.ARC_MEDIA_WEBSOCKET_URL);
  let arc = null;

  if (arcSocketUrl) {
    arc = new WebSocket(arcSocketUrl, {
      headers: call?.runtime?.mediaToken ? { Authorization: `Bearer ${call.runtime.mediaToken}` } : undefined,
    });
    arc.on('message', (message, isBinary) => {
      if (telnyx.readyState === WebSocket.OPEN) telnyx.send(message, { binary: isBinary });
    });
    arc.on('close', () => {
      if (telnyx.readyState === WebSocket.OPEN) telnyx.close();
    });
  }

  telnyx.on('message', (message, isBinary) => {
    if (arc?.readyState === WebSocket.OPEN) arc.send(message, { binary: isBinary });
  });

  telnyx.on('close', () => {
    if (arc?.readyState === WebSocket.OPEN || arc?.readyState === WebSocket.CONNECTING) arc.close();
  });
});

server.listen(PORT, () => {
  console.log(`Transport shell listening on port ${PORT}`);
});
