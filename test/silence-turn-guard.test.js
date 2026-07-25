import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOpeningQuestion,
  hasMeaningfulTranscript,
  openingReaskDelayMs,
} from '../silence-turn-guard.js';

test('treats silence, static labels, and filler as no answer', () => {
  assert.equal(hasMeaningfulTranscript(''), false);
  assert.equal(hasMeaningfulTranscript('[noise]'), false);
  assert.equal(hasMeaningfulTranscript('static'), false);
  assert.equal(hasMeaningfulTranscript('um'), false);
  assert.equal(hasMeaningfulTranscript('uh hmm'), false);
});

test('accepts actual spoken answers', () => {
  assert.equal(hasMeaningfulTranscript('yes'), true);
  assert.equal(hasMeaningfulTranscript('no'), true);
  assert.equal(hasMeaningfulTranscript('I would like an estimate'), true);
});

test('extracts only the estimate question from the opening line', () => {
  const instructions = 'Say exactly this and nothing else, at a calm measured pace: "Hi, this is Alex with Tabor Painting. Would you like to set up an estimate today?" Then stop and wait.';
  assert.equal(extractOpeningQuestion(instructions), 'Would you like to set up an estimate today?');
});

test('waits five seconds after estimated opening playback ends', () => {
  assert.equal(openingReaskDelayMs({ audioBytes: 16000, audioStartedAt: 1000, now: 2000 }), 6000);
  assert.equal(openingReaskDelayMs({ audioBytes: 8000, audioStartedAt: 1000, now: 3000 }), 5000);
});
