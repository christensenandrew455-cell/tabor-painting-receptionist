import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_MEANINGFUL_AUDIO_MS,
  STRICT_SILENCE_DURATION_MS,
  STRICT_VAD_THRESHOLD,
  applyStrictSessionSettings,
  containsForbiddenReassurance,
  isAllowedOverlapInterruption,
  isStrictMeaningfulTranscript,
} from '../strict-audio-turn-guard.js';

test('makes realtime VAD stricter and enables far-field noise reduction', () => {
  const result = applyStrictSessionSettings({
    type: 'session.update',
    session: {
      instructions: 'Base receptionist instructions.',
      audio: {
        input: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.7,
            prefix_padding_ms: 200,
            silence_duration_ms: 1200,
            create_response: true,
            interrupt_response: true,
            idle_timeout_ms: 6000,
          },
        },
      },
    },
  });

  const input = result.session.audio.input;
  assert.equal(input.noise_reduction.type, 'far_field');
  assert.equal(input.turn_detection.threshold, STRICT_VAD_THRESHOLD);
  assert.equal(input.turn_detection.silence_duration_ms, STRICT_SILENCE_DURATION_MS);
  assert.equal(input.turn_detection.prefix_padding_ms, 300);
  assert.equal(input.turn_detection.create_response, false);
  assert.equal(input.turn_detection.interrupt_response, false);
  assert.equal('idle_timeout_ms' in input.turn_detection, false);
  assert.match(result.session.instructions, /Never say "take your time"/i);
});

test('only accepts a narrow interruption whitelist while the receptionist speaks', () => {
  assert.equal(isAllowedOverlapInterruption('yes'), true);
  assert.equal(isAllowedOverlapInterruption('hold on'), true);
  assert.equal(isAllowedOverlapInterruption('can you repeat that?'), true);
  assert.equal(isAllowedOverlapInterruption('cancel the estimate'), true);
  assert.equal(isAllowedOverlapInterruption('stop talking'), true);

  assert.equal(isAllowedOverlapInterruption('the television said yes and then everybody started talking'), false);
  assert.equal(isAllowedOverlapInterruption('I was talking to somebody else in the room'), false);
  assert.equal(isAllowedOverlapInterruption('random background conversation'), false);
});

test('requires a complete meaningful caller turn before allowing a response', () => {
  assert.equal(isStrictMeaningfulTranscript('Andrew Christensen', MIN_MEANINGFUL_AUDIO_MS + 50), true);
  assert.equal(isStrictMeaningfulTranscript('yes', 100), true);
  assert.equal(isStrictMeaningfulTranscript('no', 100), true);

  assert.equal(isStrictMeaningfulTranscript('um', 900), false);
  assert.equal(isStrictMeaningfulTranscript('[noise]', 900), false);
  assert.equal(isStrictMeaningfulTranscript('My address is', 1200), false);
  assert.equal(isStrictMeaningfulTranscript('I was going to,', 1200), false);
  assert.equal(isStrictMeaningfulTranscript('Andrew', MIN_MEANINGFUL_AUDIO_MS - 1), false);
});

test('detects reassurance phrases that must never reach the caller', () => {
  assert.equal(containsForbiddenReassurance('Take your time.'), true);
  assert.equal(containsForbiddenReassurance('No rush, whenever you are ready.'), true);
  assert.equal(containsForbiddenReassurance("I'm still here."), true);
  assert.equal(containsForbiddenReassurance('What city or town is the project in?'), false);
  assert.equal(containsForbiddenReassurance('Okay...'), false);
});
