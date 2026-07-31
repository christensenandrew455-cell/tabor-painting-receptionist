import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const voice = readFileSync(new URL('../openai-voice.js', import.meta.url), 'utf8');
const brain = readFileSync(new URL('../receptionist-brain.js', import.meta.url), 'utf8');

function responseCreateBlock(source) {
  const start = source.indexOf("type: 'response.create'");
  const end = source.indexOf('function flushPending', start);
  assert.notEqual(start, -1, 'response.create block must exist');
  assert.notEqual(end, -1, 'response.create block must terminate before flushPending');
  return source.slice(start, end);
}

function brainRequestBlock(source) {
  const start = source.indexOf("fetch('https://api.openai.com/v1/chat/completions'");
  assert.notEqual(start, -1, 'brain Chat Completions request must exist');
  return source.slice(start);
}

test('Realtime response.create inherits session audio settings without unsupported speed override', () => {
  const block = responseCreateBlock(voice);
  assert.match(block, /output_modalities: \['audio'\]/);
  assert.match(block, /conversation: 'none'/);
  assert.doesNotMatch(block, /\bspeed\s*:/);
  assert.doesNotMatch(block, /\baudio\s*:/);

  assert.match(voice, /session:[\s\S]*audio:[\s\S]*output:[\s\S]*speed:/);
  assert.match(voice, /format: \{ type: 'audio\/pcmu' \}/);
});

test('Realtime error events reject pending speech instead of leaving TTS hung', () => {
  assert.match(
    voice,
    /if \(event\.type === 'error'\) \{[\s\S]*rejectSpeechRequests\(error\);[\s\S]*reportError\(error\);/,
  );
  assert.match(voice, /error\.param = event\.error\?\.param \|\| ''/);
});

test('GPT-5 Mini brain uses supported low-latency Chat Completions parameters', () => {
  const block = brainRequestBlock(brain);
  assert.match(block, /model: MODELS\.brain/);
  assert.match(block, /reasoning_effort: 'minimal'/);
  assert.match(block, /max_completion_tokens: 800/);
  assert.match(block, /response_format: \{ type: 'json_schema'/);
  assert.doesNotMatch(block, /\bmax_tokens\s*:/);
  assert.doesNotMatch(block, /\btemperature\s*:/);
});
