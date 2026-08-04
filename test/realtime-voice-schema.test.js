import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const models = readFileSync(new URL('../modular-models.js', import.meta.url), 'utf8');
const voice = readFileSync(new URL('../openai-voice.js', import.meta.url), 'utf8');
const interpreter = readFileSync(new URL('../realtime-turn-interpreter.js', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../voice-pipeline-controller.js', import.meta.url), 'utf8');
const runtimeLoader = readFileSync(new URL('../runtime-loader.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server-modular.js', import.meta.url), 'utf8');
const delivery = readFileSync(new URL('../ocm-delivery.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function speechStartedBlock(source) {
  const start = source.indexOf('onSpeechStarted: () =>');
  const end = source.indexOf('onTranscript:', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test('only the configured realtime model is used by the voice adapter', () => {
  assert.match(models, /gpt-realtime-2\.1-mini/);
  assert.doesNotMatch(voice, /\/v1\/audio\/speech/);
  assert.doesNotMatch(voice, /MODELS\.transcription/);
  assert.doesNotMatch(voice, /MODELS\.speech/);
});

test('native turn detection does not automatically generate caller-facing responses', () => {
  assert.match(voice, /type: 'server_vad'/);
  assert.match(voice, /create_response: false/);
  assert.match(voice, /interrupt_response: false/);
  assert.match(voice, /input_audio_buffer\.committed/);
  assert.match(voice, /Transcribe only the most recent caller audio turn verbatim/);
});

test('speech output stays bounded and cancellable', () => {
  assert.match(voice, /output_modalities: \['audio'\]/);
  assert.match(voice, /format: \{ type: 'audio\/pcmu' \}/);
  assert.match(voice, /SPEECH_TIMEOUT_MS/);
  assert.match(voice, /SPEECH_ATTEMPTS/);
  assert.match(voice, /response\.cancel/);
});

test('tenant runtime creation does not mutate global environment or create module copies', () => {
  assert.match(runtimeLoader, /createReceptionistCore/);
  assert.doesNotMatch(runtimeLoader, /process\.env\[name\]\s*=/);
  assert.doesNotMatch(runtimeLoader, /importQueue/);
  assert.doesNotMatch(runtimeLoader, /\?runtime=/);
  assert.doesNotMatch(runtimeLoader, /runtimeCache/);
});

test('interpreter is tenant-timezone-aware and returns bounded structured updates', () => {
  assert.match(interpreter, /core\?\.BUSINESS\?\.timeZone/);
  assert.match(interpreter, /return exactly one compact JSON object/i);
  assert.match(interpreter, /Do not write a caller-facing response/i);
  assert.match(interpreter, /core\.resolvePreferredDate/);
  assert.match(interpreter, /core\.matchService/);
});

test('controller uses canonical validation and fails closed on declined consent', () => {
  assert.match(controller, /validationLeadFromModular\(runtime\.core/);
  assert.match(controller, /validateLead\(mappedLead, \{ callerPhone \}\)/);
  assert.match(controller, /markDeterministicCompletions\(runtime\.core/);
  assert.match(controller, /nextRequiredQuestion\(runtime\.core/);
  assert.match(controller, /speakConsentDeclinedAndEnd/);
  assert.match(controller, /consent-declined/);
});

test('routine controller debug events do not log raw transcripts or lead objects', () => {
  assert.doesNotMatch(controller, /debug\('caller\.transcript', \{ transcript:/);
  assert.doesNotMatch(controller, /lead\.interpreted_committed'[\s\S]{0,200}lead: state\.lead/);
  assert.match(controller, /transcriptCharacters/);
  assert.match(controller, /changedFields/);
});

test('caller speech start does not invalidate the transcript generated from that turn', () => {
  assert.doesNotMatch(speechStartedBlock(controller), /turnRevision\s*\+=/);
  assert.match(speechStartedBlock(controller), /state\.callerSpeaking = true/);
});

test('media streams require an expiring HMAC and have a bounded payload', () => {
  assert.match(server, /createHmac\('sha256'/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /STREAM_TOKEN_TTL_MS/);
  assert.match(server, /verifiedStreamCallId/);
  assert.match(server, /maxPayload: 64 \* 1024/);
  assert.doesNotMatch(packageJson.scripts.start, /stream-call-link/);
});

test('webhooks are deduplicated and failed answered calls are hung up', () => {
  assert.match(server, /rememberWebhookEvent/);
  assert.match(server, /WEBHOOK_DEDUPE_TTL_MS/);
  assert.match(server, /Telnyx setup hangup/);
  assert.match(server, /callMetadata\.delete/);
});

test('intake delivery is isolated, idempotent, and verified before the server marks it saved', () => {
  assert.match(server, /deliverIntake/);
  assert.match(delivery, /Idempotency-Key/);
  assert.match(delivery, /data\.ok === false/);
  assert.match(delivery, /data\.success === false/);
  assert.match(delivery, /different client/);
  assert.ok(server.indexOf('ctx.leadSaved = true') > server.indexOf('await deliverIntake'));
});

test('health and startup output reference only models that exist', () => {
  assert.doesNotMatch(server, /MODELS\.transcription/);
  assert.doesNotMatch(server, /MODELS\.speech/);
  assert.match(server, /MODELS\.realtime/);
});

test('the deployment URL must be explicit outside Railway', () => {
  assert.match(server, /PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN is required/);
  assert.doesNotMatch(server, /tabor-painting-receptionist-production\.up\.railway\.app/);
});
