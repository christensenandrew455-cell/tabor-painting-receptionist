import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSilenceReask,
  extractOpeningQuestion,
  hasMeaningfulTranscript,
  identifyReceptionistInOpeningInstructions,
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

test('identifies the opening speaker as the receptionist without hard-coding names', () => {
  const instructions = 'Say exactly this and nothing else: "Hi, this is Alex with Tabor Painting. Would you like to set up an estimate today?" Then stop and wait.';
  assert.equal(
    identifyReceptionistInOpeningInstructions(instructions),
    'Say exactly this and nothing else: "Hi, this is Alex, the receptionist with Tabor Painting. Would you like to set up an estimate today?" Then stop and wait.',
  );
});

test('does not add receptionist twice', () => {
  const instructions = 'Say exactly: "Hi, this is Alex, the receptionist with Tabor Painting."';
  assert.equal(identifyReceptionistInOpeningInstructions(instructions), instructions);
});

test('extracts only the estimate question from the opening line', () => {
  const instructions = 'Say exactly this and nothing else, at a calm measured pace: "Hi, this is Alex with Tabor Painting. Would you like to set up an estimate today?" Then stop and wait.';
  assert.equal(extractOpeningQuestion(instructions), 'Would you like to set up an estimate today?');
});

test('builds deterministic simplified silence re-asks', () => {
  assert.equal(
    buildSilenceReask('Hi, this is Alex with Tabor Painting. Would you like to set up an estimate today?'),
    "I'm sorry, I didn't get that. Would you like to set up an estimate?",
  );
  assert.equal(
    buildSilenceReask('Can I please have your first and last name?'),
    "I'm sorry, I didn't get that. What is your first and last name?",
  );
  assert.equal(
    buildSilenceReask('What is the best way we can contact you: call or text?'),
    "I'm sorry, I didn't get that. Would you prefer a call or a text?",
  );
});

test('waits five seconds after estimated playback ends', () => {
  assert.equal(openingReaskDelayMs({ audioBytes: 16000, audioStartedAt: 1000, now: 2000 }), 6000);
  assert.equal(openingReaskDelayMs({ audioBytes: 8000, audioStartedAt: 1000, now: 3000 }), 5000);
});
