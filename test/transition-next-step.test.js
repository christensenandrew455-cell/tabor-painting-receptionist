import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockReceptionistOutput } from '../receptionist-output-guard.js';

test('runtime-blocks transition speech that ends without the actual next question', () => {
  assert.equal(shouldBlockReceptionistOutput('One sec. Let me grab the details.'), true);
  assert.equal(shouldBlockReceptionistOutput('Let me get the details real quick.'), true);
  assert.equal(shouldBlockReceptionistOutput("Okay, let's keep this moving."), true);
  assert.equal(shouldBlockReceptionistOutput('Let me get those details.'), true);
  assert.equal(shouldBlockReceptionistOutput('Let me grab your information real quick.'), true);
  assert.equal(shouldBlockReceptionistOutput('I’ll gather that for you.'), true);
  assert.equal(shouldBlockReceptionistOutput('We’ll pull that up.'), true);
  assert.equal(shouldBlockReceptionistOutput('Give me a second.'), true);
  assert.equal(shouldBlockReceptionistOutput('Hold on a moment.'), true);
  assert.equal(shouldBlockReceptionistOutput('One moment.'), true);
  assert.equal(shouldBlockReceptionistOutput("Let's keep going."), true);
  assert.equal(
    shouldBlockReceptionistOutput('Got it, let me ask one quick question to move things along.'),
    true,
  );
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
  assert.equal(
    shouldBlockReceptionistOutput("Let me get those details. What's the complete project address?"),
    false,
  );
  assert.equal(
    shouldBlockReceptionistOutput('Give me a second. What date and time would work best for the estimate?'),
    false,
  );
  assert.equal(
    shouldBlockReceptionistOutput("Let's keep going. Do you consent to being contacted by Tabor Painting?"),
    false,
  );
});

test('keeps unrelated process narration and reassurance filler blocked', () => {
  assert.equal(shouldBlockReceptionistOutput('Let me think about the next detail.'), true);
  assert.equal(shouldBlockReceptionistOutput('Take your time.'), true);
});
