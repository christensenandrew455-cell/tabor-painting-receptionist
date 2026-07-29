import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCELLATION_PATTERN,
  RECEPTIONIST_COMMANDS,
  buildQuestionCatalog,
  buildReceptionistPrompt,
  callMemorySummary,
  createCallMemory,
  holdAcknowledgementFor,
  rememberAssistant,
  rememberCaller,
  resetIntakeMemory,
} from '../receptionist-customization.js';

const business = {
  name: 'Tabor Painting',
  receptionist: 'Alex',
  owner: 'Andrew Christensen',
  phone: '+15551234567',
  email: 'office@example.com',
  hours: 'Monday through Friday, 9:00 AM to 5:00 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '5:00 PM',
  base: 'Portland, Maine',
  serviceAreas: ['Portland'],
  services: {
    'interior painting': 'Interior painting.',
    'exterior painting': 'Exterior painting.',
  },
  about: [],
  extraInformation: '',
};

test('central commands contain only server timing rules that still exist', () => {
  assert.equal(RECEPTIONIST_COMMANDS.silenceReaskMs, 5000);
  assert.equal(RECEPTIONIST_COMMANDS.holdCheckMs, 30000);
  assert.equal('thinkingCueMs' in RECEPTIONIST_COMMANDS, false);
  assert.equal('thinkingCues' in RECEPTIONIST_COMMANDS, false);
});

test('core keeps grouped address and schedule intake before missing-part questions', () => {
  const questions = buildQuestionCatalog({ business, ownerFirstName: 'Andrew' });
  assert.equal(questions.project_location.text, 'What is your full project address?');
  assert.match(questions.estimate_schedule.text, /What day works best for you, and what time/i);
  assert.match(questions.estimate_schedule.text, /Monday through Friday/i);
  assert.match(questions.estimate_schedule.text, /9:00 AM to 5:00 PM/i);
});

test('always includes the complete service list on the first service question', () => {
  const questions = buildQuestionCatalog({ business, ownerFirstName: 'Andrew' });
  assert.equal(
    questions.service_type.text,
    'What service are you looking for? We specialize in interior painting, or exterior painting.',
  );
});

test('prompt preserves one-question state and silent waiting behavior', () => {
  const prompt = buildReceptionistPrompt({
    business,
    ownerFirstName: 'Andrew',
    currentDateLabel: 'Sunday, July 26, 2026',
  });
  assert.match(prompt, /When waiting for the caller, remain silent/i);
  assert.match(prompt, /Treat one normal answer as capable of supplying street number, street name, city or town, and state/i);
  assert.match(prompt, /first service question must always include the complete configured service list/i);
  assert.match(prompt, /return to the one unanswered intake question/i);
  assert.doesNotMatch(prompt, /1,100 millisecond thinking cue/i);
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
