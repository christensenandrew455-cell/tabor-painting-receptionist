import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySpokenOutputSessionRules,
  containsInternalSpeechLeak,
  rewritePrivateStateText,
  sanitizeFunctionOutput,
} from '../spoken-output-guard.js';

test('rewrites code-style call state as explicitly silent natural memory', () => {
  const rewritten = rewritePrivateStateText(`CURRENT CALL STATE
Stage: INTAKE
Last question ID: service_type
Last question: What service were you looking for?
Current field: serviceType
Estimate offered: 1 time(s)
Intake cancelled: no
Lead saved: no
Recorded field answers:
- fullName: Andrew Christensen
Recent caller utterances:
- Interior painting
Recent assistant utterances:
- What service were you looking for?
CURRENT TURN WORDING COMMANDS
- Ask at most one question.`);

  assert.match(rewritten, /Private call memory/i);
  assert.match(rewritten, /What service were you looking for\?/i);
  assert.match(rewritten, /Andrew Christensen/i);
  assert.doesNotMatch(rewritten, /CURRENT CALL STATE/);
  assert.doesNotMatch(rewritten, /Last question ID/);
  assert.doesNotMatch(rewritten, /CURRENT TURN WORDING COMMANDS/);
  assert.doesNotMatch(rewritten, /Recent caller utterances/);
});

test('removes machine error codes from function outputs', () => {
  const blocked = sanitizeFunctionOutput(JSON.stringify({
    ok: false,
    error: 'final_summary_confirmation_required',
  }));
  const failed = sanitizeFunctionOutput(JSON.stringify({
    ok: false,
    error: 'save_failed',
  }));
  const success = sanitizeFunctionOutput(JSON.stringify({ ok: true, agreed: true }));

  assert.doesNotMatch(blocked, /final_summary_confirmation_required/);
  assert.doesNotMatch(failed, /save_failed/);
  assert.match(blocked, /Never read or describe/i);
  assert.match(failed, /did not complete/i);
  assert.match(success, /completed/i);
});

test('detects internal commands and code-like speech without blocking normal receptionist wording', () => {
  const blocked = [
    'Current call state. Last question ID is service type.',
    'The function call output says submit estimate lead.',
    'Error code save failed.',
    'E-code final summary confirmation required.',
    'Response dot create with JSON.',
    'The SSML prosody command says speak.',
    'This is a private tool result.',
  ];
  blocked.forEach((value) => assert.equal(containsInternalSpeechLeak(value), true, value));

  const allowed = [
    'What service were you looking for?',
    'Okay. What city or town is the project in?',
    'Tabor Painting can confirm that when they follow up.',
    'Do you agree to be contacted about this estimate request?',
  ];
  allowed.forEach((value) => assert.equal(containsInternalSpeechLeak(value), false, value));
});

test('adds a strict customer-facing-only session rule once', () => {
  const original = {
    type: 'session.update',
    session: { instructions: 'Base receptionist instructions.' },
  };
  const once = applySpokenOutputSessionRules(original);
  const twice = applySpokenOutputSessionRules(once);
  assert.match(once.session.instructions, /CUSTOMER-FACING SPEECH SAFETY/);
  assert.match(once.session.instructions, /Never read, quote, spell, paraphrase/i);
  assert.equal(twice.session.instructions, once.session.instructions);
});
