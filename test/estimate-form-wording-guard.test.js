import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteEstimateFormWording } from '../estimate-form-wording-guard.js';

test('uses estimate request form wording without changing the intake structure', () => {
  const result = rewriteEstimateFormWording('Would you like me to help you submit an estimate request?');
  assert.equal(result, 'Would you like to fill out an estimate request form?');
});

test('uses the short intake introduction', () => {
  const result = rewriteEstimateFormWording("Okay, great. I'll collect your name, the service you need, the project address, your preferred estimate date and time, and any optional notes. Let's get started.");
  assert.equal(result, "I just need a couple of details. Let's get started.");
});

test('asks for the full address using the requested wording', () => {
  assert.equal(
    rewriteEstimateFormWording('What is your full project address?'),
    'I need the full address for the project.',
  );
});
