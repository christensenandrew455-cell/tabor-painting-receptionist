import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baseQuestionFor,
  captureDeterministicLead,
  markDeterministicCompletions,
  nextRequiredQuestion,
} from '../modular-intake-logic.js';
import { MODELS } from '../modular-models.js';
import {
  applyRealtimeInterpretation,
  buildRealtimeTurnPrompt,
  parseRealtimeTurnInterpretation,
} from '../realtime-turn-interpreter.js';
import {
  PHRASE_KEYS,
  RECEPTIONIST_PHRASES,
  receptionistPhrase,
} from '../receptionist-phrases.js';

const coreStub = Object.freeze({
  BUSINESS: Object.freeze({
    name: 'Tabor Painting',
    receptionist: 'Alex',
    services: {
      'wood staining': 'Wood staining services.',
      'exterior painting': 'Exterior painting services.',
      'interior painting': 'Interior painting services.',
      'small paint repair': 'Small paint repair services.',
    },
    estimateDays: 'Monday through Friday',
    earliestEstimateStart: '9:00 AM',
    latestEstimateStart: '4:00 PM',
  }),
  contactConsentQuestion: 'Do you consent to being contacted by Tabor Painting?',
  normalizePreferredTime(value) {
    const normalized = String(value).replace(/\./g, '').trim().toLowerCase();
    if (/^1(?::00)?(?:\s*pm)?$/.test(normalized)) return '1:00 PM';
    if (/^2(?::00)?(?:\s*pm)?$/.test(normalized)) return '2:00 PM';
    if (/^3(?::00)?(?:\s*pm)?$/.test(normalized)) return '3:00 PM';
    if (/^4(?::00)?(?:\s*pm)?$/.test(normalized)) return '4:00 PM';
    if (/^9(?::00)?(?:\s*am)?$/.test(normalized)) return '9:00 AM';
    return '';
  },
});

const completeLead = Object.freeze({
  name: 'Andrew Christensen',
  service: 'interior painting',
  projectLocation: '197 Lancaster Road, Berlin, MA',
  preferredDate: 'Monday',
  preferredTime: '2:00 PM',
  notes: 'none',
  contactConsent: true,
});

test('Realtime Mini is the active interpretation brain', () => {
  assert.equal(MODELS.brain, MODELS.realtime);
  assert.equal(MODELS.realtime, 'gpt-realtime-mini');
  assert.equal(MODELS.speech, 'gpt-4o-mini-tts');
});

test('all active caller wording remains in one phrase catalog', () => {
  assert.equal(RECEPTIONIST_PHRASES.QUESTION_SERVICE, 'What service do you need?');
  assert.equal(RECEPTIONIST_PHRASES.QUESTION_FULL_NAME, 'What is your full name?');
  assert.equal(RECEPTIONIST_PHRASES.QUESTION_PROJECT_ADDRESS, 'What is the full address for the project?');
  assert.equal(RECEPTIONIST_PHRASES.QUESTION_ADDITIONAL_NOTES, 'Now do you have any notes about the project?');
});

test('opening and closing render business placeholders', () => {
  assert.equal(
    receptionistPhrase(coreStub, PHRASE_KEYS.OPENING, completeLead),
    "Hi, thank you for calling Tabor Painting. I'm the receptionist, Alex. I'm here to answer questions or guide you through an estimate request. Would you like to submit an estimate request?",
  );
  assert.equal(
    receptionistPhrase(coreStub, PHRASE_KEYS.CLOSING, completeLead),
    'Okay. Thank you for calling Tabor Painting. Have a good day.',
  );
});

test('question IDs map to approved exact phrases', () => {
  assert.equal(baseQuestionFor(coreStub, 'service', completeLead), 'What service do you need?');
  assert.equal(baseQuestionFor(coreStub, 'name', completeLead), 'What is your full name?');
  assert.equal(baseQuestionFor(coreStub, 'project_location', completeLead), 'What is the full address for the project?');
  assert.equal(
    baseQuestionFor(coreStub, 'preferred_date_time', completeLead),
    'Next, we need a date and time request for the estimate. We schedule estimates Monday through Friday from 9:00 AM to 4:00 PM.',
  );
});

test('Realtime interpretation prompt forbids painter referrals and extra questions', () => {
  const prompt = buildRealtimeTurnPrompt({
    core: coreStub,
    transcript: 'The whole inside of my house needs paint.',
    currentQuestionId: 'service',
    lead: { ...completeLead, service: null },
    history: [],
  });
  assert.match(prompt, /Never suggest hiring or contacting a painter/i);
  assert.match(prompt, /Never ask whether the caller will do the work themselves/i);
  assert.match(prompt, /Do not write a caller-facing response/i);
  assert.match(prompt, /configuredServices/);
});

test('Realtime interpretation parses only bounded actions, acknowledgements, and updates', () => {
  const turn = parseRealtimeTurnInterpretation(JSON.stringify({
    action: 'answer',
    ack: 'sorry',
    updates: {
      service: 'interior painting',
      name: null,
      projectLocation: null,
      preferredDate: null,
      preferredTime: null,
      notes: null,
      contactConsent: null,
    },
  }));
  assert.equal(turn.action, 'answer');
  assert.equal(turn.ack, 'sorry');
  assert.equal(turn.updates.service, 'interior painting');
});

test('Realtime interpretation applies the configured service selected from natural speech', () => {
  const result = applyRealtimeInterpretation(coreStub, { ...completeLead, service: null }, {
    action: 'answer',
    ack: 'sorry',
    updates: { service: 'interior painting' },
  });
  assert.equal(result.lead.service, 'interior painting');
  assert.deepEqual(result.changedFields, ['service']);
});

test('Realtime interpretation removes leading fillers from names', () => {
  const result = applyRealtimeInterpretation(coreStub, { ...completeLead, name: null }, {
    action: 'answer',
    ack: 'thanks_name',
    updates: { name: 'Um Andrew Christensen' },
  });
  assert.equal(result.lead.name, 'Andrew Christensen');
});

test('Realtime interpretation normalizes spoken-number estimate times', () => {
  const result = applyRealtimeInterpretation(coreStub, {
    ...completeLead,
    preferredDate: null,
    preferredTime: null,
  }, {
    action: 'answer',
    ack: 'sounds_good',
    updates: {
      preferredDate: 'Monday',
      preferredTime: 'two',
    },
  });
  assert.equal(result.lead.preferredDate, 'Monday');
  assert.equal(result.lead.preferredTime, '2:00 PM');
});

test('out-of-schedule interpreted times are rejected by business validation', () => {
  const result = applyRealtimeInterpretation(coreStub, {
    ...completeLead,
    preferredDate: null,
    preferredTime: null,
  }, {
    action: 'answer',
    ack: 'none',
    updates: {
      preferredDate: 'Friday',
      preferredTime: '6:00 PM',
    },
  });
  assert.equal(result.lead.preferredDate, 'Friday');
  assert.equal(result.lead.preferredTime, null);
});

test('deterministic parsing remains a fallback rather than the decision brain', () => {
  const lead = captureDeterministicLead(
    coreStub,
    'service',
    'I just need a room painted at my house.',
    { ...completeLead, service: null },
  );
  assert.equal(lead.service, 'interior painting');
});

test('completed fields advance in the locked order', () => {
  const memory = { completedQuestionIds: [] };
  memory.completedQuestionIds = markDeterministicCompletions('service', completeLead, memory.completedQuestionIds);
  memory.completedQuestionIds = markDeterministicCompletions('name', completeLead, memory.completedQuestionIds);
  memory.completedQuestionIds = markDeterministicCompletions('project_location', completeLead, memory.completedQuestionIds);
  assert.equal(nextRequiredQuestion(memory, completeLead), 'preferred_date_time');
});
