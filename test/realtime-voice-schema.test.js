import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const voice = readFileSync(new URL('../openai-voice.js', import.meta.url), 'utf8');
const interpreter = readFileSync(new URL('../realtime-turn-interpreter.js', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../voice-pipeline-controller.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server-modular.js', import.meta.url), 'utf8');

function responseCreateBlock(source) {
  const start = source.indexOf("type: 'response.create'");
  const end = source.indexOf('function flushPending', start);
  assert.notEqual(start, -1, 'response.create block must exist');
  assert.notEqual(end, -1, 'response.create block must terminate before flushPending');
  return source.slice(start, end);
}

function speechStartedBlock(source) {
  const start = source.indexOf('onSpeechStarted: () =>');
  const end = source.indexOf('onTranscript:', start);
  assert.notEqual(start, -1, 'onSpeechStarted block must exist');
  assert.notEqual(end, -1, 'onSpeechStarted block must end before onTranscript');
  return source.slice(start, end);
}

test('Realtime response.create is text-only interpretation with no automatic voice response', () => {
  const block = responseCreateBlock(voice);
  assert.match(block, /output_modalities: \['text'\]/);
  assert.match(block, /conversation: 'none'/);
  assert.match(block, /interpretation_request_id/);
  assert.doesNotMatch(block, /output_modalities: \['audio'\]/);
  assert.match(voice, /create_response: false/);
  assert.match(voice, /interrupt_response: false/);
});

test('caller-facing speech uses the exact text-to-speech endpoint', () => {
  assert.match(voice, /https:\/\/api\.openai\.com\/v1\/audio\/speech/);
  assert.match(voice, /model: MODELS\.speech/);
  assert.match(voice, /input: String\(text\)/);
  assert.match(voice, /response_format: 'pcm'/);
  assert.match(voice, /pcm24kToPcmu8k/);
  assert.doesNotMatch(voice, /response\.output_audio\.delta/);
  assert.doesNotMatch(voice, /REALTIME_SPEECH_MISMATCH/);
});

test('interpretation and speech requests have bounded timeouts', () => {
  assert.match(voice, /INTERPRETATION_TIMEOUT_MS/);
  assert.match(voice, /SPEECH_TIMEOUT_MS/);
  assert.match(voice, /SPEECH_ATTEMPTS/);
  assert.match(voice, /AbortSignal\.timeout\(SPEECH_TIMEOUT_MS\)/);
  assert.match(voice, /Realtime interpretation timed out/);
  assert.match(voice, /Speech synthesis timed out/);
});

test('Realtime interpreter returns bounded JSON instead of caller-facing prose', () => {
  assert.match(interpreter, /return exactly one compact JSON object/i);
  assert.match(interpreter, /Do not write a caller-facing response/i);
  assert.match(interpreter, /Never suggest hiring or contacting a painter/i);
  assert.match(interpreter, /Never copy unchanged values from currentLead/i);
  assert.match(interpreter, /INTERPRETER_ACTIONS/);
  assert.match(interpreter, /INTERPRETER_ACKS/);
});

test('controller consumes realtime interpretation but owns question order', () => {
  assert.match(controller, /realtimeVoice\.interpret/);
  assert.match(controller, /parseRealtimeTurnInterpretation/);
  assert.match(controller, /applyRealtimeInterpretation/);
  assert.match(controller, /nextRequiredQuestion/);
  assert.match(controller, /baseQuestionFor/);
  assert.match(controller, /fastInterpretation/);
  assert.match(controller, /interpretationHasCurrentField/);
  assert.doesNotMatch(controller, /decideReceptionistTurn/);
});

test('caller speech start no longer invalidates the same transcript interpretation', () => {
  assert.doesNotMatch(speechStartedBlock(controller), /turnRevision\s*\+=/);
});

test('controller advances the pending question before speech generation finishes', () => {
  assert.match(controller, /state\.memory\.currentQuestionId = questionId/);
  assert.match(controller, /effectiveQuestionId = nextQuestionId !== 'none'/);
});

test('summary corrections are applied once and field-targeted', () => {
  assert.match(controller, /interpretation\.action === 'summary_correction' && changes\.length/);
  assert.match(controller, /my full name is\|my name/);
  assert.doesNotMatch(controller, /not\\s\+\[A-Za-z\].*it's\|it is/);
});

test('lead submission grants time to ask more questions and close normally', () => {
  assert.match(server, /POST_SUBMISSION_GRACE_MS = 90 \* 1000/);
  assert.match(server, /grantPostSubmissionGrace\(ctx\)/);
  assert.match(server, /call\.post_submission_grace_started/);
  assert.match(server, /snapshot\?\.interpreting/);
});
