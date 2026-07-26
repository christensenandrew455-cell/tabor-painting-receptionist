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

test('groups normal address and schedule intake before itemizing missing parts', () => {
  const questions = buildQuestionCatalog({ business, ownerFirstName: 'Andrew' });
  assert.equal(
    questions.project_location.text,
    'What is the project address? Please give me the city or town, state, street number, and street name.',
  );
  assert.match(questions.estimate_schedule.text, /exact date or upcoming day and time works best/i);
  assert.match(questions.estimate_schedule.text, /Monday through Friday/i);
  assert.match(questions.estimate_schedule.text, /9:00 AM through 5:00 PM/i);
});

test('always includes the complete service list on the first service question', () => {
  const questions = buildQuestionCatalog({ business, ownerFirstName: 'Andrew' });
  assert.equal(
    questions.service_type.text,
    'What service are you looking for? We specialize in interior painting or exterior painting.',
  );
});

test('prompt requires silence while waiting and forbids a secondary cue voice', () => {
  const prompt = buildReceptionistPrompt({
    business,
    ownerFirstName: 'Andrew',
    currentDateLabel: 'Sunday, July 26, 2026',
  });
  assert.match(prompt, /When waiting for the caller, remain silent/i);
  assert.match(prompt, /There is no separate thinking cue or secondary voice/i);
  assert.match(prompt, /Do not itemize the address before the caller has a chance/i);
  assert.match(prompt, /first service question must always include the complete configured service list/i);
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
