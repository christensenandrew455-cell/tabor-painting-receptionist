import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockReceptionistOutput } from '../receptionist-output-guard.js';

test('does not runtime-block transition speech that is now forbidden by generation rules', () => {
  assert.equal(shouldBlockReceptionistOutput('One sec. Let me grab the details.'), false);
  assert.equal(shouldBlockReceptionistOutput('Let me get the details real quick.'), false);
  assert.equal(shouldBlockReceptionistOutput("Okay, let's keep this moving."), false);
  assert.equal(shouldBlockReceptionistOutput('Let me get those details.'), false);
  assert.equal(shouldBlockReceptionistOutput('Let me grab your information real quick.'), false);
  assert.equal(shouldBlockReceptionistOutput('I’ll gather that for you.'), false);
  assert.equal(shouldBlockReceptionistOutput('We’ll pull that up.'), false);
  assert.equal(shouldBlockReceptionistOutput('Give me a second.'), false);
  assert.equal(shouldBlockReceptionistOutput('Hold on a moment.'), false);
  assert.equal(shouldBlockReceptionistOutput('One moment.'), false);
  assert.equal(shouldBlockReceptionistOutput("Let's keep going."), false);
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

test('keeps reassurance filler blocked while process wording is handled by generation rules', () => {
  assert.equal(shouldBlockReceptionistOutput('Let me think about the next detail.'), false);
  assert.equal(shouldBlockReceptionistOutput('Take your time.'), true);
});
