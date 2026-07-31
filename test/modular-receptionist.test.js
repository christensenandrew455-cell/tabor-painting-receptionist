import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baseQuestionFor,
  captureDeterministicLead,
  changedLeadFields,
  enforceQuestionBlock,
  markDeterministicCompletions,
  mergeLead,
  nextRequiredQuestion,
  repeatQuestionFor,
} from '../modular-intake-logic.js';
import {
  assembleIntakeReply,
  sanitizeIntakePreface,
} from '../intake-response-policy.js';
import { createCallMemory } from '../receptionist-brain.js';

const coreStub = Object.freeze({
  BUSINESS: Object.freeze({
    name: 'Tabor Painting',
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
    if (/^4(?::00)?(?:\s*pm)?$/.test(normalized)) return '4:00 PM';
    if (/^9(?::00)?(?:\s*am)?$/.test(normalized)) return '9:00 AM';
    return '';
  },
});

const completeLead = Object.freeze({
  name: 'Andrew Christensen',
  service: 'interior painting',
  projectLocation: '197 Lancaster Road, Berlin, Massachusetts',
  preferredDate: 'Tuesday',
  preferredTime: '4:00 PM',
  notes: 'none',
  contactConsent: true,
});

test('service question is server-owned and never reads the service list', () => {
  const question = baseQuestionFor(coreStub, 'service', completeLead);
  assert.equal(question, 'What service do you need?');
  assert.equal(repeatQuestionFor(coreStub, 'service'), 'What service do you need?');
  assert.doesNotMatch(question, /wood staining|exterior painting|interior painting|small paint repair/i);
});

test('safe natural preface is attached before the exact question', () => {
  assert.equal(
    assembleIntakeReply(coreStub, 'That sounds great, Andrew.', 'name', completeLead),
    'That sounds great, Andrew. What is your full name?',
  );
});

test('an exact canonical question is never duplicated', () => {
  assert.equal(
    enforceQuestionBlock(coreStub, 'What is your full name?', 'name', completeLead),
    'What is your full name?',
  );
  assert.equal(
    enforceQuestionBlock(
      coreStub,
      'What is the full address for the project?',
      'project_location',
      completeLead,
    ),
    'What is the full address for the project?',
  );
});

test('availability wording is not duplicated', () => {
  assert.equal(
    enforceQuestionBlock(
      coreStub,
      'Our estimate availability is Monday through Friday, 9:00 AM through 4:00 PM. What is your preferred estimate date and time?',
      'preferred_date_time',
      completeLead,
    ),
    'Estimate appointments are available Monday through Friday from 9:00 AM through 4:00 PM. What is your preferred estimate date and time?',
  );
});

test('model questions are removed and cannot replace the canonical question', () => {
  assert.equal(
    enforceQuestionBlock(
      coreStub,
      'Sounds good. Which service are you calling about: wood staining or exterior painting?',
      'service',
      completeLead,
    ),
    'What service do you need?',
  );
});

test('service names, collection explanations, and instructions are blocked from prefaces', () => {
  assert.equal(sanitizeIntakePreface(coreStub, 'Wood staining sounds great.', 'name'), '');
  assert.equal(sanitizeIntakePreface(coreStub, 'We collect this information so we know who you are.', 'name'), '');
  assert.equal(sanitizeIntakePreface(coreStub, 'Please provide your legal name.', 'name'), '');
});

test('long prefaces are bounded and remain declarative', () => {
  const safe = sanitizeIntakePreface(
    coreStub,
    'Great, thank you for explaining that in a lot of detail and giving me everything I could possibly need to understand the situation before moving forward with the request',
    'name',
  );
  assert.ok(safe.length <= 121);
  assert.match(safe, /\.$/);
  assert.doesNotMatch(safe, /\?/);
});

test('natural service descriptions are mapped before the model returns', () => {
  const empty = { ...completeLead, service: null };
  assert.equal(
    captureDeterministicLead(
      coreStub,
      'service',
      'I need the whole outside of my house repainted.',
      empty,
    ).service,
    'exterior painting',
  );
  assert.equal(
    captureDeterministicLead(
      coreStub,
      'service',
      'I need the whole house painted.',
      empty,
    ).service,
    'exterior painting',
  );
  assert.equal(
    captureDeterministicLead(coreStub, 'service', 'The walls inside need paint.', empty).service,
    'interior painting',
  );
});

test('valid name and project address are captured before the model returns', () => {
  const empty = { ...completeLead, name: null, projectLocation: null };
  const named = captureDeterministicLead(coreStub, 'name', 'Andrew Christensen.', empty);
  assert.equal(named.name, 'Andrew Christensen');

  const located = captureDeterministicLead(
    coreStub,
    'project_location',
    '197 Lancaster Road, Berlin, Massachusetts.',
    named,
  );
  assert.equal(located.projectLocation, '197 Lancaster Road, Berlin, Massachusetts');
  assert.deepEqual(changedLeadFields(named, located), ['projectLocation']);
});

test('conversation and complaint sentences are not saved as name or address', () => {
  const empty = { ...completeLead, name: null, projectLocation: null };
  const badName = 'Um, well, I called you, so I think you are, you know.';
  const badAddress = 'I was in the middle of filling out an estimate request.';

  const afterName = captureDeterministicLead(coreStub, 'name', badName, empty);
  assert.equal(afterName.name, null);

  const afterAddress = captureDeterministicLead(
    coreStub,
    'project_location',
    badAddress,
    afterName,
  );
  assert.equal(afterAddress.projectLocation, null);

  assert.deepEqual(
    mergeLead(empty, { name: badName, projectLocation: badAddress }),
    empty,
  );
});

test('invalid model values cannot advance the state machine', () => {
  const memory = createCallMemory();
  memory.estimateStarted = true;
  memory.completedQuestionIds = ['service', 'name', 'project_location'];

  const lead = {
    ...completeLead,
    name: 'I think you know',
    projectLocation: 'What are you talking about?',
  };

  assert.equal(nextRequiredQuestion(memory, lead), 'name');
});

test('deterministic completions advance the state machine', () => {
  const memory = createCallMemory();
  memory.estimateStarted = true;

  const lead = { ...completeLead };
  memory.completedQuestionIds = markDeterministicCompletions('service', lead, memory.completedQuestionIds);
  memory.completedQuestionIds = markDeterministicCompletions('name', lead, memory.completedQuestionIds);
  memory.completedQuestionIds = markDeterministicCompletions('project_location', lead, memory.completedQuestionIds);

  assert.equal(nextRequiredQuestion(memory, lead), 'preferred_date_time');
});

test('date and time capture remains deterministic', () => {
  const captured = captureDeterministicLead(
    coreStub,
    'preferred_date_time',
    'Monday at 2 PM.',
    { ...completeLead, preferredDate: null, preferredTime: null },
  );
  assert.equal(captured.preferredDate, 'Monday');
  assert.equal(captured.preferredTime, '2:00 PM');
});

test('summary and consent remain server-owned', () => {
  const summary = baseQuestionFor(coreStub, 'confirm_summary', completeLead);
  assert.match(summary, /^Let me read that back\./);
  assert.match(summary, /Does all of that sound right\?$/);
  assert.equal(
    baseQuestionFor(coreStub, 'contact_consent', completeLead),
    coreStub.contactConsentQuestion,
  );
});
