import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { businessInfoFromAppProfile, runtimeEnvironmentFromApp } from '../app-info-config.js';
import { pcm24kToPcmu8k, splitPcmuFrames } from '../audio-codec.js';
import { MODELS } from '../modular-models.js';
import { QUESTION_IDS, createCallMemory } from '../receptionist-brain.js';

const ROOT = new URL('../', import.meta.url);

function read(path) {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

const businessProfile = Object.freeze({
  businessName: 'Tabor Painting',
  receptionistName: 'Alex',
  ownerName: 'Taylor Tabor',
  businessPhone: '+17742316164',
  businessEmail: 'office@example.com',
  businessHours: 'Monday through Friday, 9:00 AM to 5:00 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:30 PM',
  businessBase: 'Massachusetts',
  serviceAreas: ['Massachusetts'],
  services: {
    'interior painting': 'Interior painting services.',
    'exterior painting': 'Exterior painting services.',
  },
  about: ['Residential painting company.'],
  extraInformation: 'Business fact.',
  aiVoice: 'alloy',
  aiSpeechSpeed: 0.94,
  aiSilenceMs: 1200,
  aiModel: 'gpt-realtime-mini',
  openingLine: 'OCM must not control this opening.',
  closingLine: 'OCM must not control this closing.',
});

test('production starts the modular server with the Telnyx stream linker and keeps legacy explicit', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.main, 'server-modular.js');
  assert.equal(packageJson.scripts.start, 'node --import ./stream-call-link.js server-modular.js');
  assert.match(packageJson.scripts['start:legacy'], /server\.js$/);
});

test('the Telnyx stream linker carries the call ID and locks clean PCMU transport', () => {
  const linker = read('stream-call-link.js');
  assert.match(linker, /searchParams\.set\('callControlId', callControlId\)/);
  assert.match(linker, /searchParams\.get\('callControlId'\)/);
  assert.match(linker, /message\.call_control_id = message\.call_control_id \|\| linkedCallControlId/);
  assert.match(linker, /message\.start[\s\S]*call_control_id/);
  assert.match(linker, /stream_bidirectional_codec: 'PCMU'/);
  assert.match(linker, /stream_bidirectional_sampling_rate: 8000/);
  assert.match(linker, /stream_bidirectional_target_legs: 'self'/);
  assert.match(linker, /send_silence_when_idle: true/);
});

test('the transcriber uses the GA Realtime API and waits for session readiness', () => {
  const voice = read('openai-voice.js');
  assert.doesNotMatch(voice, /OpenAI-Beta/);
  assert.match(voice, /wss:\/\/api\.openai\.com\/v1\/realtime/);
  assert.match(voice, /type: 'session\.update'/);
  assert.match(voice, /type: 'transcription'/);
  assert.match(voice, /format: \{ type: 'audio\/pcmu' \}/);
  assert.match(voice, /noise_reduction: \{ type: 'near_field' \}/);
  assert.match(voice, /event\.type === 'session\.updated'/);
  assert.match(voice, /create_response: false/);
  assert.match(voice, /interrupt_response: false/);
});

test('24 kHz PCM silence becomes one clean 20 ms PCMU telephone frame', () => {
  const twentyMillisecondsOfPcm24k = Buffer.alloc(480 * 2);
  const pcmu = pcm24kToPcmu8k(twentyMillisecondsOfPcm24k);
  assert.equal(pcmu.length, 160);
  assert.ok(pcmu.every((value) => value === 0xff));
  const frames = splitPcmuFrames(pcmu);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 160);
});

test('each OpenAI model has exactly one fixed job', () => {
  assert.equal(MODELS.transcription, 'gpt-4o-mini-transcribe');
  assert.equal(MODELS.brain, 'gpt-4.1-mini');
  assert.equal(MODELS.speech, 'gpt-4o-mini-tts');
});

test('OCM business data cannot override models or the Tabor opening and closing', () => {
  const environment = runtimeEnvironmentFromApp({ profile: businessProfile, clientId: 'tabor-painting' });
  const business = businessInfoFromAppProfile(businessProfile);

  assert.equal(environment.AI_MODEL, 'gpt-realtime-mini');
  assert.equal(environment.AI_VOICE, 'alloy');
  assert.doesNotMatch(environment.BUSINESS_INFO, /OCM must not control/);
  assert.notEqual(business.openingLine, businessProfile.openingLine);
  assert.notEqual(business.closingLine, businessProfile.closingLine);
  assert.match(business.openingLine, /Would you like to submit an estimate request\?/i);
  assert.match(business.closingLine, /wonderful rest of your day.*Goodbye/i);
});

test('the structured memory box starts with a counter for every question', () => {
  const memory = createCallMemory();
  assert.deepEqual(Object.keys(memory.askedCounts), [...QUESTION_IDS]);
  assert.equal(memory.currentQuestionId, 'none');
  assert.deepEqual(memory.completedQuestionIds, []);
  assert.equal(memory.estimateStarted, false);
  assert.equal(memory.leadSaved, false);
});

test('identity is hard-guarded and false human claims are blocked before TTS', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /IDENTITY_PATTERN/);
  assert.match(controller, /FALSE_HUMAN_CLAIM_PATTERN/);
  assert.match(controller, /I am an AI receptionist working for/);
  assert.match(controller, /guard\.false_human_claim_blocked/);
});

test('service is the first estimate field and its requirements appear before the question', () => {
  const controller = read('voice-pipeline-controller.js');
  const brain = read('receptionist-brain.js');
  assert.match(brain, /ESTIMATE ORDER[\s\S]*1\. service[\s\S]*2\. name/);
  assert.match(controller, /We specialize in[^`]+What service would you like\?/);
  assert.match(controller, /guard\.service_first/);
  assert.match(controller, /guard\.service_missing/);
});

test('question wording is guarded so nothing is appended after the question mark', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /function enforceQuestionReply/);
  assert.match(controller, /guard\.question_wording_enforced/);
  assert.match(controller, /return clean\(preface \? `\$\{preface\} \$\{baseQuestion\}` : baseQuestion\)/);
  assert.doesNotMatch(controller, /What is the full address for the project\? Please include/i);
});

test('five-second repeats begin after playback and use only the base question', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /SILENCE_REPEAT_MS = 5000/);
  assert.match(controller, /repeatAfterPlaybackQuestionId/);
  assert.match(controller, /if \(!frame\)[\s\S]*scheduleBaseQuestionRepeat\(repeatQuestionId\)/);
  assert.match(controller, /silence\.base_question_repeat/);
});

test('the closing hangs up only after its audio playback completes', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /endAfterPlaybackReason: 'completed'/);
  assert.match(controller, /playback\.completed_hangup/);
  assert.match(controller, /endCall\?\.\(endReason\)/);
});

test('the production server uses the modular pipeline and never opens a reasoning Realtime socket', () => {
  const server = read('server-modular.js');
  assert.match(server, /createVoicePipeline/);
  assert.match(server, /transcribe -> brain -> tts/);
  assert.doesNotMatch(server, /createOpenAiSocket/);
  assert.doesNotMatch(server, /response\.create/);
  assert.doesNotMatch(server, /gpt-realtime-mini/);
});
