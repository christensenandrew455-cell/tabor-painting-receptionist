import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { CALL_MAX_MS, callUsageOutcome, durationSeconds } from './call-policy.js';
import {
  createTenantProfile,
  getCalledPhone,
  getCallerPhone,
  getTelnyxConnectionId,
  normalizePhone,
} from './tenant-profile.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = resolvePublicUrl();
const STREAM_URL = PUBLIC_URL.replace(/^http/i, 'ws') + '/media-stream';
const CONFIG_URL = String(process.env.RECEPTIONIST_CONFIG_URL || '').trim();
const CONFIG_SECRET = String(process.env.RECEPTIONIST_CONFIG_SECRET || '').trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const TELNYX_API_KEY = String(process.env.TELNYX_API_KEY || '').trim();
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const AUDIO_FORMAT = Object.freeze({ type: 'audio/pcmu' });
const OPENAI_URL = (model) => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
const BARGE_IN_CONFIRM_MS = 450;
const MIN_USER_TURN_MS = 250;
const TRANSCRIPT_WAIT_MS = 1800;
const AUDIO_FRAME_MS = 20;
const PCMU_BYTES_PER_MS = 8;
const AUDIO_FRAME_BYTES = AUDIO_FRAME_MS * PCMU_BYTES_PER_MS;
const AUDIO_PREBUFFER_BYTES = 60 * PCMU_BYTES_PER_MS;
const MAX_OUTPUT_TOKENS = 800;
const PROFILE_CACHE_MS = Math.max(5_000, Number(process.env.RECEPTIONIST_CONFIG_CACHE_MS || 60_000));
const HOLD_PATTERN = /\b(?:hold on|wait(?: a moment)?|one second|one sec|give me (?:a|one) (?:second|sec|minute|moment)|just a (?:second|sec|minute|moment)|hang on|pause for a (?:second|minute|moment))\b/i;

const activeCalls = new Map();
const activeCallsByControlId = new Map();
const callMetadata = new Map();
const profileCache = new Map();

function resolvePublicUrl() {
  const configured = String(process.env.PUBLIC_URL || '').trim();
  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  const raw = configured || (railwayDomain ? `https://${railwayDomain}` : '');
  if (!raw) throw new Error('PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN is required.');
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PUBLIC_URL must use HTTP or HTTPS.');
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

function assertRuntimeConfiguration() {
  const missing = [
    ['OPENAI_API_KEY', OPENAI_API_KEY],
    ['TELNYX_API_KEY', TELNYX_API_KEY],
    ['RECEPTIONIST_CONFIG_URL', CONFIG_URL],
    ['RECEPTIONIST_CONFIG_SECRET', CONFIG_SECRET],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required runtime configuration: ${missing.join(', ')}`);
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
  if (!id) return null;
  const previous = callMetadata.get(id) || {};
  const next = {
    ...previous,
    callerPhone: getCallerPhone(body) || previous.callerPhone || '',
    calledPhone: getCalledPhone(body) || previous.calledPhone || '',
    telnyxConnectionId: getTelnyxConnectionId(body) || previous.telnyxConnectionId || '',
    updatedAt: Date.now(),
  };
  callMetadata.set(id, next);
  return next;
}

function profileCacheKey(calledPhone, connectionId) {
  return `${normalizePhone(calledPhone)}|${String(connectionId || '').trim()}`;
}

async function fetchTenantProfile(calledPhone, connectionId, { force = false } = {}) {
  const normalizedPhone = normalizePhone(calledPhone);
  if (!normalizedPhone) throw new Error('The inbound call did not include a destination phone number.');
  const key = profileCacheKey(normalizedPhone, connectionId);
  const cached = profileCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.profile;

  const url = new URL(CONFIG_URL);
  url.searchParams.set('phone', normalizedPhone);
  if (connectionId) url.searchParams.set('connectionId', String(connectionId));
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CONFIG_SECRET}`,
      'X-ARK-Receptionist-Key': CONFIG_SECRET,
    },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  let data = {};
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`Receptionist config returned non-JSON (${response.status}).`);
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Receptionist config failed (${response.status}).`);
  const profile = createTenantProfile(data.profile || data);
  profileCache.set(key, { profile, expiresAt: Date.now() + PROFILE_CACHE_MS });
  return profile;
}

async function resolveCallProfile(metadata) {
  if (metadata.profile) return metadata.profile;
  const profile = await fetchTenantProfile(metadata.calledPhone, metadata.telnyxConnectionId);
  metadata.profile = profile;
  metadata.clientId = profile.clientId;
  return profile;
}

async function telnyxCommand(id, action, body = {}) {
  const response = await fetch(`${TELNYX_API_BASE}/calls/${encodeURIComponent(id)}/actions/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Telnyx ${action} failed: ${response.status} ${await response.text()}`);
}

async function postTenantAction(profile, url, payload, attempts = 3) {
  if (!url) throw new Error(`Tenant ${profile.clientId} is missing an OCM endpoint.`);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ARK-Connection-Key': profile.connectionKey,
        },
        body: JSON.stringify({ clientId: profile.clientId, ...payload }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.text();
      let data = {};
      try {
        data = body ? JSON.parse(body) : {};
      } catch {
        if (!response.ok) throw new Error(`ARK returned ${response.status}: ${body.slice(0, 160)}`);
        data = { ok: true };
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `ARK request failed (${response.status}).`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 350));
    }
  }
  throw lastError || new Error('ARK request failed.');
}

async function callerIsBlocked(profile, callerPhone) {
  if (!callerPhone || !profile.ocmUsageUrl) return false;
  try {
    const data = await postTenantAction(profile, profile.ocmUsageUrl, { action: 'check', callerPhone }, 1);
    return data.blocked === true;
  } catch (error) {
    console.error('[Call block check failed open]', profile.clientId, error.message);
    return false;
  }
}

async function reportCallUsage(ctx) {
  if (!ctx.startedAt || ctx.usageReported || !ctx.profile?.ocmUsageUrl) return;
  if (ctx.usageReportPromise) return ctx.usageReportPromise;
  const endedAt = Date.now();
  const payload = {
    action: 'record',
    callId: ctx.callControlId || ctx.id,
    callerPhone: ctx.callerPhone,
    calledPhone: ctx.calledPhone,
    durationSeconds: durationSeconds(ctx.startedAt, endedAt),
    leadSaved: ctx.leadSaved,
    qualifiedLead: ctx.leadSaved,
    outcome: callUsageOutcome({ leadSaved: ctx.leadSaved, endReason: ctx.endReason }),
    endReason: ctx.endReason || 'remote-hangup',
    timeZone: ctx.profile.business.timeZone,
    startedAt: new Date(ctx.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
  };
  ctx.usageReportPromise = postTenantAction(ctx.profile, ctx.profile.ocmUsageUrl, payload, 3)
    .then(() => {
      ctx.usageReported = true;
      console.log('[Call usage saved]', { clientId: ctx.profile.clientId, callId: payload.callId, qualifiedLead: payload.qualifiedLead });
    })
    .catch((error) => console.error('[Call usage save failed]', ctx.profile.clientId, error.message))
    .finally(() => { ctx.usageReportPromise = null; });
  return ctx.usageReportPromise;
}

function sendJson(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function sendTelnyx(ctx, event) {
  if (ctx.streamId) event.stream_id = ctx.streamId;
  return sendJson(ctx.telnyx, event);
}

function clearMaxCallTimer(ctx) {
  if (ctx.maxCallTimer) clearTimeout(ctx.maxCallTimer);
  ctx.maxCallTimer = null;
}

function forceHangup(ctx, reason = 'max-duration') {
  if (ctx.cleanedUp) return;
  ctx.ending = true;
  ctx.endReason = ctx.endReason || reason;
  ctx.pendingNaturalResponse = false;
  ctx.pendingResponse = null;
  ctx.hangupAfterResponse = false;
  if (ctx.openAiGenerating) sendJson(ctx.openai, { type: 'response.cancel' });
  clearLocalAudio(ctx);
  sendTelnyx(ctx, { event: 'clear' });
  if (ctx.callControlId) telnyxCommand(ctx.callControlId, 'hangup').catch((error) => console.error('[Forced hangup]', error.message));
  else ctx.telnyx?.close();
}

function startCallPolicy(ctx) {
  if (ctx.startedAt) return;
  ctx.startedAt = Date.now();
  ctx.maxCallTimer = setTimeout(() => forceHangup(ctx, 'max-duration'), CALL_MAX_MS);
}

function queueResponse(ctx, instructionsText, hangupAfter = false) {
  ctx.pendingResponse = { instructionsText, hangupAfter };
  flushResponse(ctx);
}

function requestNaturalResponse(ctx) {
  if (ctx.ending) return;
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
      response: { output_modalities: ['audio'], instructions: next.instructionsText },
    });
    return ctx.responseActive;
  }
  if (!ctx.pendingNaturalResponse || ctx.holdMode) return false;
  ctx.pendingNaturalResponse = false;
  ctx.hangupAfterResponse = false;
  ctx.responseActive = sendJson(ctx.openai, { type: 'response.create', response: { output_modalities: ['audio'] } });
  return ctx.responseActive;
}

function sendToolOutput(ctx, callId, output) {
  if (!callId) return;
  sendJson(ctx.openai, {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
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
  const validation = ctx.profile.validateLead(call.args);
  if (!validation.valid) {
    sendToolOutput(ctx, call.callId, { ok: false, missingOrInvalid: validation.errors });
    queueResponse(ctx, `Ask only for ${validation.errors.join(', ')}. Ask one question, then wait. Do not restart the intake.`);
    return;
  }
  if (ctx.leadSaved) {
    sendToolOutput(ctx, call.callId, { ok: true, alreadySaved: true });
    queueResponse(ctx, `Ask exactly: "${ctx.profile.afterSaveQuestion}" Then stop and wait.`);
    return;
  }

  const payload = ctx.profile.buildOcmPayload(ctx.callerPhone, validation.lead);
  try {
    await postTenantAction(ctx.profile, ctx.profile.ocmWebhookUrl, payload, 2);
    ctx.leadSaved = true;
    sendToolOutput(ctx, call.callId, { ok: true, preferredDate: payload.EstimateDate || '' });
    queueResponse(ctx, `Ask exactly: "${ctx.profile.afterSaveQuestion}" Say nothing else, then stop and wait.`);
  } catch (error) {
    ctx.leadSaveFailed = true;
    console.error('[OCM save failed]', ctx.profile.clientId, error.message);
    sendToolOutput(ctx, call.callId, { ok: false, error: 'save_failed' });
    queueResponse(ctx, `Say briefly: "${ctx.profile.saveFailureLine}" Then ask: "${ctx.profile.afterSaveQuestion}" and wait.`);
  }
}

function finishCall(ctx, call) {
  if (!ctx.leadSaved && !ctx.leadSaveFailed) {
    sendToolOutput(ctx, call.callId, { ok: false, error: 'lead_not_saved' });
    queueResponse(ctx, 'Do not end the call yet. Finish confirming and saving the estimate request first.');
    return;
  }
  sendToolOutput(ctx, call.callId, { ok: true });
  ctx.endReason = 'completed';
  ctx.ending = true;
  queueResponse(ctx, `Say exactly this and nothing else: "${ctx.profile.closingLine}"`, true);
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
    if (ctx.callControlId) telnyxCommand(ctx.callControlId, 'hangup').catch((error) => console.error('[Hangup]', error.message));
    return;
  }
  flushResponse(ctx);
}

function sendPlaybackMark(ctx) {
  if (ctx.waitingForPlaybackMark) return;
  if (ctx.assistantAudioSentMs <= 0) return completeAssistantPlayback(ctx);
  ctx.playbackMarkName = `assistant-playback-${ctx.responseSequence}`;
  ctx.waitingForPlaybackMark = sendTelnyx(ctx, { event: 'mark', mark: { name: ctx.playbackMarkName } });
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
    ctx.assistantAudioSentMs += AUDIO_FRAME_MS;
    sendTelnyx(ctx, { event: 'media', media: { payload: frame.toString('base64') } });
    ctx.audioPumpTimer = setTimeout(() => pumpAudio(ctx), AUDIO_FRAME_MS);
    return;
  }
  if (ctx.openAiAudioDone) return sendPlaybackMark(ctx);
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
  try { chunk = Buffer.from(base64Audio, 'base64'); } catch { return; }
  if (!chunk.length || ctx.bargeInConfirmed) return;
  ctx.audioBuffer = ctx.audioBuffer.length ? Buffer.concat([ctx.audioBuffer, chunk]) : chunk;
  startAudioPump(ctx);
}

function confirmBargeIn(ctx) {
  ctx.bargeInTimer = null;
  if (ctx.ending || !ctx.responseActive) return;
  ctx.bargeInConfirmed = true;
  ctx.hangupAfterResponse = false;
  if (ctx.openAiGenerating) sendJson(ctx.openai, { type: 'response.cancel' });
  clearLocalAudio(ctx);
  sendTelnyx(ctx, { event: 'clear' });
  const audioEndMs = Math.floor(Math.max(0, ctx.assistantAudioSentMs));
  if (ctx.assistantItemId && audioEndMs > 0) {
    sendJson(ctx.openai, { type: 'conversation.item.truncate', item_id: ctx.assistantItemId, content_index: 0, audio_end_ms: audioEndMs });
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
  const value = String(transcript || '').trim();
  if (!value) return;
  ctx.lastCallerTranscript = value;
  clearTranscriptTimer(ctx);
  if (ctx.ending) return;
  if (HOLD_PATTERN.test(value)) {
    ctx.holdMode = true;
    cancelResponseForHold(ctx);
    return;
  }
  if (ctx.holdMode) ctx.holdMode = false;
  requestNaturalResponse(ctx);
}

function createOpenAiSocket(ctx) {
  const profile = ctx.profile;
  const ws = new WebSocket(OPENAI_URL(profile.model), {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': `${profile.safetyIdentifier}-${ctx.id}`,
    },
  });
  ws.on('open', () => {
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: profile.instructions(),
        output_modalities: ['audio'],
        max_output_tokens: MAX_OUTPUT_TOKENS,
        tools: profile.tools,
        tool_choice: 'auto',
        audio: {
          input: {
            format: AUDIO_FORMAT,
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'en', prompt: profile.transcriptionPrompt },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.7,
              prefix_padding_ms: 300,
              silence_duration_ms: profile.silenceDurationMs,
              create_response: false,
              interrupt_response: false,
            },
          },
          output: { format: AUDIO_FORMAT, voice: profile.voice, speed: profile.speechSpeed },
        },
      },
    });
  });
  ws.on('message', (raw) => handleOpenAiMessage(ctx, raw));
  ws.on('error', (error) => console.error('[OpenAI websocket]', profile.clientId, error.message));
  ws.on('close', () => console.log('[OpenAI closed]', profile.clientId, ctx.id));
  return ws;
}

function attachCallerContext(ctx) {
  if (!ctx.sessionReady || ctx.phoneContextSent || !ctx.callerPhone) return;
  ctx.phoneContextSent = sendJson(ctx.openai, {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: `Caller ID phone number: ${ctx.callerPhone}. Private internal data. Never ask for it, say it, repeat it, or confirm it. Use it only in the saved lead.` }],
    },
  });
}

function handleOpenAiMessage(ctx, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  if (message.type === 'error') return console.error('[OpenAI error]', ctx.profile.clientId, message.error || message);
  if (message.type === 'session.updated') {
    ctx.sessionReady = true;
    attachCallerContext(ctx);
    queueResponse(ctx, `Say exactly this and nothing else, at a calm measured pace: "${ctx.profile.openingLine}" Then stop and wait.`);
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
    return;
  }
  if (message.type === 'response.output_item.added' || message.type === 'response.output_item.created') {
    const item = message.item || message.output_item || {};
    if (item.type === 'message' && item.role === 'assistant') ctx.assistantItemId = item.id || ctx.assistantItemId;
    return;
  }
  if (message.type === 'response.function_call_arguments.done' || message.type === 'response.output_item.done') {
    const call = parseToolCall(message);
    if (call) handleTool(ctx, call).catch((error) => console.error('[Tool error]', ctx.profile.clientId, error.message));
    return;
  }
  if (message.type === 'response.audio.delta' || message.type === 'response.output_audio.delta') {
    const audio = message.delta || message.audio;
    if (audio) enqueueAudio(ctx, audio);
    return;
  }
  if (message.type === 'conversation.item.input_audio_transcription.completed') return handleCallerTranscript(ctx, message.transcript);
  if (message.type === 'conversation.item.input_audio_transcription.failed') {
    clearTranscriptTimer(ctx);
    if (!ctx.holdMode) requestNaturalResponse(ctx);
    return;
  }
  if (message.type === 'input_audio_buffer.speech_started') {
    if (ctx.ending) return;
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
    mode: 'multi-tenant',
    provider: 'Telnyx',
    activeCalls: activeCalls.size,
    cachedProfiles: profileCache.size,
    voiceWebhook: `${PUBLIC_URL}/voice-api-webhook`,
    mediaStream: STREAM_URL,
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, mode: 'multi-tenant', activeCalls: activeCalls.size, cachedProfiles: profileCache.size, callMaximumSeconds: CALL_MAX_MS / 1000 });
});

app.post('/voice-api-webhook', async (req, res) => {
  res.sendStatus(200);
  const type = eventType(req.body);
  const id = callControlId(req.body);
  const metadata = rememberCall(req.body);
  if (!id || !metadata) return;
  try {
    if (type === 'call.initiated') {
      if (metadata.rejected) return;
      const profile = await resolveCallProfile(metadata);
      if (await callerIsBlocked(profile, metadata.callerPhone)) {
        metadata.rejected = true;
        await telnyxCommand(id, 'reject', { cause: 'CALL_REJECTED' });
        return;
      }
      await telnyxCommand(id, 'answer');
    }
    if (type === 'call.answered' && !metadata.rejected) {
      await resolveCallProfile(metadata);
      const streamUrl = new URL(STREAM_URL);
      streamUrl.searchParams.set('callControlId', id);
      await telnyxCommand(id, 'streaming_start', {
        stream_url: streamUrl.toString(),
        stream_track: 'inbound_track',
        stream_codec: 'PCMU',
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: 'PCMU',
        stream_bidirectional_sampling_rate: 8000,
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
    console.error('[Telnyx webhook]', type, id, error.message);
    if (type === 'call.initiated' && !metadata.rejected) {
      metadata.rejected = true;
      telnyxCommand(id, 'reject', { cause: 'CALL_REJECTED' }).catch(() => null);
    }
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/media-stream') return socket.destroy();
  request.callControlId = url.searchParams.get('callControlId') || '';
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', (telnyx, request) => {
  const ctx = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    telnyx,
    openai: null,
    profile: null,
    streamId: '',
    callControlId: request.callControlId || '',
    callerPhone: '',
    calledPhone: '',
    startedAt: 0,
    maxCallTimer: null,
    ending: false,
    endReason: '',
    usageReported: false,
    usageReportPromise: null,
    cleanedUp: false,
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
    setupPromise: null,
  };

  activeCalls.set(ctx.id, ctx);

  async function setupFromMessage(message) {
    if (ctx.setupPromise) return ctx.setupPromise;
    ctx.setupPromise = (async () => {
      ctx.callControlId = callControlId(message) || ctx.callControlId;
      const remembered = callMetadata.get(ctx.callControlId) || {};
      ctx.callerPhone = getCallerPhone(message) || remembered.callerPhone || ctx.callerPhone;
      ctx.calledPhone = getCalledPhone(message) || remembered.calledPhone || ctx.calledPhone;
      const connectionId = getTelnyxConnectionId(message) || remembered.telnyxConnectionId || '';
      ctx.profile = remembered.profile || await fetchTenantProfile(ctx.calledPhone, connectionId);
      if (ctx.callControlId) {
        remembered.profile = ctx.profile;
        remembered.callerPhone = ctx.callerPhone;
        remembered.calledPhone = ctx.calledPhone;
        callMetadata.set(ctx.callControlId, remembered);
        activeCallsByControlId.set(ctx.callControlId, ctx);
      }
      ctx.openai = createOpenAiSocket(ctx);
      startCallPolicy(ctx);
    })().catch((error) => {
      console.error('[Call setup]', ctx.callControlId || ctx.id, error.message);
      telnyx.close();
      throw error;
    });
    return ctx.setupPromise;
  }

  telnyx.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const event = message.event || message.event_type || message.type;
    if (event === 'start' || event === 'connected' || event === 'streaming.started') {
      ctx.streamId = message.stream_id || message.start?.stream_id || ctx.streamId;
      ctx.streamReady = true;
      setupFromMessage(message).then(() => {
        attachCallerContext(ctx);
        flushResponse(ctx);
      }).catch(() => null);
      return;
    }
    if (event === 'media') {
      const track = String(message.media?.track || '').toLowerCase();
      if (track.includes('outbound') || !ctx.openai) return;
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
    if (ctx.cleanedUp) return;
    ctx.cleanedUp = true;
    ctx.endReason = ctx.endReason || 'remote-hangup';
    cancelBargeInTimer(ctx);
    clearTranscriptTimer(ctx);
    clearMaxCallTimer(ctx);
    clearLocalAudio(ctx);
    if (ctx.openai?.readyState === WebSocket.OPEN) ctx.openai.close();
    if (ctx.callControlId) activeCallsByControlId.delete(ctx.callControlId);
    activeCalls.delete(ctx.id);
    reportCallUsage(ctx).catch(() => null);
  };

  telnyx.on('close', cleanup);
  telnyx.on('error', (error) => {
    console.error('[Telnyx websocket]', error.message);
    cleanup();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK multi-tenant receptionist listening on ${PORT}`);
  console.log(`Webhook: ${PUBLIC_URL}/voice-api-webhook`);
  console.log(`Config endpoint: ${new URL(CONFIG_URL).origin}${new URL(CONFIG_URL).pathname}`);
});
