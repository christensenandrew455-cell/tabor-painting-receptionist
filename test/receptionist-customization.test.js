import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCELLATION_PATTERN,
  RECEPTIONIST_COMMANDS,
  callMemorySummary,
  createCallMemory,
  holdAcknowledgementFor,
  rememberAssistant,
  rememberCaller,
  resetIntakeMemory,
} from '../receptionist-customization.js';

test('central commands contain the production timing rules', () => {
  assert.equal(RECEPTIONIST_COMMANDS.silenceReaskMs, 5000);
  assert.equal(RECEPTIONIST_COMMANDS.holdCheckMs, 30000);
  assert.equal(RECEPTIONIST_COMMANDS.thinkingCueMs, 1100);
  assert.deepEqual(RECEPTIONIST_COMMANDS.thinkingCues, ['Okay...', 'Hmm...']);
});

test('hold acknowledgements match the caller request without improvising', () => {
  assert.equal(holdAcknowledgementFor('give me a minute'), "Okay, I'll give you a minute.");
  assert.equal(holdAcknowledgementFor('wait one second'), "Okay, I'll give you a second.");
  assert.equal(holdAcknowledgementFor('let me think'), "Okay, I'll give you a moment.");
  assert.equal(holdAcknowledgementFor('hold on'), "Okay, I'll wait.");
});

test('clear intake cancellation language is recognized', () => {
  assert.match('I do not want to fill this out anymore', CANCELLATION_PATTERN);
  assert.match('cancel the estimate request', CANCELLATION_PATTERN);
  assert.doesNotMatch('stop talking for a second', CANCELLATION_PATTERN);
});

test('structured memory retains only five recent turns and resets intake fields', () => {
  const memory = createCallMemory();
  memory.stage = RECEPTIONIST_COMMANDS.stages.INTAKE;
  memory.currentField = 'fullName';
  memory.fieldAnswers.fullName = 'Andrew Christensen';
  for (let index = 0; index < 7; index += 1) {
    rememberCaller(memory, `caller ${index}`);
    rememberAssistant(memory, `assistant ${index}`);
  }
  assert.equal(memory.recentCallerUtterances.length, 5);
  assert.equal(memory.recentAssistantUtterances.length, 5);
  assert.match(callMemorySummary(memory), /Andrew Christensen/);
  resetIntakeMemory(memory);
  assert.equal(memory.stage, RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE);
  assert.deepEqual(memory.fieldAnswers, {});
  assert.equal(memory.intakeCancelled, true);
});
