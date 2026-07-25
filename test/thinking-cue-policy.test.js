import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THINKING_CUE_DELAY_MS,
  thinkingCueDelayMs,
  thinkingCueForSequence,
  shouldHoldTelnyxEvent,
} from '../thinking-cue-policy.js';

test('uses an eleven-hundred millisecond cue threshold', () => {
  assert.equal(THINKING_CUE_DELAY_MS, 1100);
  assert.equal(thinkingCueDelayMs({ speechStoppedAt: 1000, now: 1500 }), 600);
  assert.equal(thinkingCueDelayMs({ speechStoppedAt: 1000, now: 2500 }), 0);
});

test('rotates a small deterministic cue set without uncertain filler', () => {
  assert.equal(thinkingCueForSequence(0), 'Okay...');
  assert.equal(thinkingCueForSequence(1), 'Hmm...');
  assert.equal(thinkingCueForSequence(2), 'Okay...');
  assert.equal(thinkingCueForSequence(3), 'Okay...');
});

test('holds only outbound media and marks while the cue is active', () => {
  assert.equal(shouldHoldTelnyxEvent({ event: 'media' }, true, 0), true);
  assert.equal(shouldHoldTelnyxEvent({ event: 'mark' }, true, 0), true);
  assert.equal(shouldHoldTelnyxEvent({ event: 'clear' }, true, 0), false);
  assert.equal(shouldHoldTelnyxEvent({ event: 'media' }, false, 0), false);
  assert.equal(shouldHoldTelnyxEvent({ event: 'media' }, false, 2), true);
});
