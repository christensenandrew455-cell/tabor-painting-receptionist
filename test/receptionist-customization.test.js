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

test('central commands use the approved five-second and thirty-second timing rules', () => {
  assert.equal(RECEPTIONIST_COMMANDS.silenceReaskMs, 5000);
  assert.equal(RECEPTIONIST_COMMANDS.holdCheckMs, 30000);
  assert.equal('thinkingCueMs' in RECEPTIONIST_COMMANDS, false);
  assert.equal('thinkingCues' in RECEPTIONIST_COMMANDS, false);
});

test('approved intake asks for one full address and one combined schedule', () => {
  const questions = buildQuestionCatalog({ business });
  assert.equal(questions.project_location.text, 'What is the full address for the project?');
  assert.match(questions.estimate_schedule.text, /What day and time would you prefer for the estimate/i);
  assert.match(questions.estimate_schedule.text, /Monday through Friday/i);
  assert.match(questions.estimate_schedule.text, /9:00 AM to 5:00 PM/i);
});

test('always includes the complete service list on the first service question', () => {
  const questions = buildQuestionCatalog({ business });
  assert.equal(
    questions.service_type.text,
    'What service are you looking for? We specialize in interior painting, or exterior painting.',
  );
});

test('prompt uses approved script, one-question state, and memory-box behavior', () => {
  const prompt = buildReceptionistPrompt({
    business,
    currentDateLabel: 'Sunday, July 26, 2026',
  });
  assert.match(prompt, /MASTER AI RECEPTIONIST SPECIFICATION/i);
  assert.match(prompt, /Ask one question at a time and stop to listen/i);
  assert.match(prompt, /project-address question asks for the full address in one step/i);
  assert.match(prompt, /complete configured service list|We specialize in interior painting, or exterior painting/i);
  assert.match(prompt, /return to the same unanswered question/i);
  assert.match(prompt, /memory box, not conversational recollection/i);
  assert.match(prompt, /Never ask for a ZIP code, phone number, or email address/i);
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
  assert.match(callMemorySummary(memory), /Question memory:/);
  resetIntakeMemory(memory);
  assert.equal(memory.stage, RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE);
  assert.deepEqual(memory.fieldAnswers, {});
  assert.equal(memory.intakeCancelled, true);
});
