import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockReceptionistOutput } from '../receptionist-output-guard.js';

test('blocks transition-only speech that leaves the caller hanging', () => {
  assert.equal(shouldBlockReceptionistOutput('One sec. Let me grab the details.'), true);
  assert.equal(shouldBlockReceptionistOutput('Let me get the details real quick.'), true);
  assert.equal(shouldBlockReceptionistOutput("Okay, let's keep this moving."), true);
});

test('allows a brief transition when the same response immediately gives the real next step', () => {
  assert.equal(
    shouldBlockReceptionistOutput("Okay, let's keep this moving. What's the complete project address?"),
    false,
  );
  assert.equal(
    shouldBlockReceptionistOutput('One sec. Let me grab the details. What date and time would work best for the estimate?'),
    false,
  );
  assert.equal(
    shouldBlockReceptionistOutput('Let me get the details real quick. Do you consent to being contacted by Tabor Painting?'),
    false,
  );
});

test('keeps unrelated process narration blocked', () => {
  assert.equal(shouldBlockReceptionistOutput('Let me think about the next detail.'), true);
  assert.equal(shouldBlockReceptionistOutput('Take your time.'), true);
});
