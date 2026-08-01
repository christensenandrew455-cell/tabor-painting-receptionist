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
    if (/^2(?::00)?(?:\s*pm)?$/.test(normalized)) return '2:00 PM';
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

test('there is no separate GPT-5 Mini brain model', () => {
  assert.equal(MODELS.brain, 'deterministic-controller');
  assert.equal(MODELS.realtime, 'gpt-realtime-mini');
});

test('all active caller wording comes from one phrase catalog', () => {
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

test('question IDs map to the approved exact phrases', () => {
  assert.equal(baseQuestionFor(coreStub, 'service', completeLead), 'What service do you need?');
  assert.equal(baseQuestionFor(coreStub, 'name', completeLead), 'What is your full name?');
  assert.equal(baseQuestionFor(coreStub, 'project_location', completeLead), 'What is the full address for the project?');
  assert.equal(
    baseQuestionFor(coreStub, 'preferred_date_time', completeLead),
    'Next, we need a date and time request for the estimate. We schedule estimates Monday through Friday from 9:00 AM to 4:00 PM.',
  );
  assert.equal(baseQuestionFor(coreStub, 'notes', completeLead), 'Now do you have any notes about the project?');
});

test('final confirmation renders only collected lead values', () => {
  assert.equal(
    baseQuestionFor(coreStub, 'confirm_summary', completeLead),
    'Let me read that back. I have Andrew Christensen requesting interior painting at 197 Lancaster Road, Berlin, MA, with the estimate date and time requested for Monday at 2:00 PM. There are no additional notes. Does all of that sound right?',
  );
});

test('natural service descriptions are captured deterministically', () => {
  const lead = captureDeterministicLead(
    coreStub,
    'service',
    'I just need a room painted at my house.',
    { ...completeLead, service: null },
  );
  assert.equal(lead.service, 'interior painting');
});

test('date and time are captured without a decision model', () => {
  const lead = captureDeterministicLead(
    coreStub,
    'preferred_date_time',
    'Monday at 2 PM.',
    { ...completeLead, preferredDate: null, preferredTime: null },
  );
  assert.equal(lead.preferredDate, 'Monday');
  assert.equal(lead.preferredTime, '2:00 PM');
});

test('completed deterministic fields advance in fixed order', () => {
  const memory = {
    completedQuestionIds: [],
  };
  memory.completedQuestionIds = markDeterministicCompletions('service', completeLead, memory.completedQuestionIds);
  memory.completedQuestionIds = markDeterministicCompletions('name', completeLead, memory.completedQuestionIds);
  memory.completedQuestionIds = markDeterministicCompletions('project_location', completeLead, memory.completedQuestionIds);
  assert.equal(nextRequiredQuestion(memory, completeLead), 'preferred_date_time');
});
