import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_CANCELLATION_LINE,
  rewriteCancellationInstructions,
} from '../cancellation-finalizer-guard.js';
import { decideConsentTurn } from '../consent-turn-guard.js';

test('rewrites every cancelled estimate response into a terminal goodbye', () => {
  const result = rewriteCancellationInstructions(
    `Say exactly this and nothing else: "Okay, no problem. I've canceled the estimate request. Do you have any questions about Tabor Painting or its services?"`,
  );

  assert.match(result, /I've canceled the estimate request\. Goodbye\./i);
  assert.doesNotMatch(result, /do you have any questions/i);
  assert.equal(TERMINAL_CANCELLATION_LINE, "Okay. I've canceled the estimate request. Goodbye.");
});

test('leaves non-cancellation responses unchanged', () => {
  const source = 'Say exactly: "I need your consent so Tabor Painting can contact you. Do you agree?"';
  assert.equal(rewriteCancellationInstructions(source), source);
});

test('counts only one consent refusal per caller answer', () => {
  const first = decideConsentTurn({
    callerTurn: 4,
    lastConsentTurn: -1,
    consentRefusals: 0,
    agreed: false,
  });
  assert.deepEqual(first, {
    duplicate: false,
    lastConsentTurn: 4,
    consentRefusals: 1,
  });

  const duplicate = decideConsentTurn({
    callerTurn: 4,
    lastConsentTurn: first.lastConsentTurn,
    consentRefusals: first.consentRefusals,
    agreed: false,
  });
  assert.deepEqual(duplicate, {
    duplicate: true,
    lastConsentTurn: 4,
    consentRefusals: 1,
  });

  const second = decideConsentTurn({
    callerTurn: 5,
    lastConsentTurn: duplicate.lastConsentTurn,
    consentRefusals: duplicate.consentRefusals,
    agreed: false,
  });
  assert.deepEqual(second, {
    duplicate: false,
    lastConsentTurn: 5,
    consentRefusals: 2,
  });
});

test('a granted consent resets refusal tracking', () => {
  assert.deepEqual(decideConsentTurn({
    callerTurn: 6,
    lastConsentTurn: 5,
    consentRefusals: 1,
    agreed: true,
  }), {
    duplicate: false,
    lastConsentTurn: -1,
    consentRefusals: 0,
  });
});
