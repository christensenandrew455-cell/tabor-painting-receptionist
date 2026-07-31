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
});

test('date and time wording explains schedule and request status', () => {
  const expected = 'Next, we need a date and time for the estimate. We schedule estimates Monday through Friday from 9:00 AM to 4:00 PM. This date and time is only a request and is not a confirmed appointment. What date and time would you like to request?';
  assert.equal(baseQuestionFor(coreStub, 'preferred_date_time', completeLead), expected);
  assert.equal(repeatQuestionFor(coreStub, 'preferred_date_time', completeLead), expected);
  assert.equal(
    enforceQuestionBlock(
      coreStub,
      'Our estimators are available Monday through Friday, 9:00 AM to 4:00 PM. What is your preferred estimate date and time?',
      'preferred_date_time',
      completeLead,
    ),
    expected,
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
    captureDeterministicLead(coreStub, 'service', 'I need the whole outside of my house repainted.', empty).service,
    'exterior painting',
  );
  assert.equal(
    captureDeterministicLead(coreStub, 'service', 'I need the whole house painted.', empty).service,
    'exterior painting',
  );
  assert.equal(
    captureDeterministicLead(coreStub, 'service', 'I just need a room painted at my house.', empty).service,
    'interior painting',
  );
});

test('valid name and complete project address are captured before the model returns', () => {
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

test('partial street address is retained and only missing city and state are requested', () => {
  const empty = { ...completeLead, projectLocation: null };
  const partial = captureDeterministicLead(
    coreStub,
    'project_location',
    'That would be 197 Lancaster Road.',
    empty,
  );
  assert.equal(partial.projectLocation, '197 Lancaster Road');
  assert.equal(
    baseQuestionFor(coreStub, 'project_location', partial),
    'What city and state is that address in?',
  );

  const completed = captureDeterministicLead(
    coreStub,
    'project_location',
    'Berlin, Massachusetts.',
    partial,
  );
  assert.equal(completed.projectLocation, '197 Lancaster Road, Berlin, Massachusetts');
});

test('conversational lead-in is removed from a full address', () => {
  const empty = { ...completeLead, projectLocation: null };
  const located = captureDeterministicLead(
    coreStub,
    'project_location',
    'I just told you, 197 Lincoln Road, Berlin, Massachusetts.',
    empty,
  );
  assert.equal(located.projectLocation, '197 Lincoln Road, Berlin, Massachusetts');
});

test('conversation and complaint sentences are not saved as name or address', () => {
  const empty = { ...completeLead, name: null, projectLocation: null };
  const badName = 'Um, well, I called you, so I think you are, you know.';
  const badAddress = 'I was in the middle of filling out an estimate request.';

  const afterName = captureDeterministicLead(coreStub, 'name', badName, empty);
  assert.equal(afterName.name, null);

  const afterAddress = captureDeterministicLead(coreStub, 'project_location', badAddress, afterName);
  assert.equal(afterAddress.projectLocation, null);

  assert.deepEqual(mergeLead(empty, { name: badName, projectLocation: badAddress }), empty);
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

test('partial address does not complete the address field', () => {
  const memory = createCallMemory();
  memory.estimateStarted = true;
  memory.completedQuestionIds = ['service', 'name'];
  const lead = { ...completeLead, projectLocation: '197 Lancaster Road' };
  memory.completedQuestionIds = markDeterministicCompletions(
    'project_location',
    lead,
    memory.completedQuestionIds,
  );
  assert.equal(nextRequiredQuestion(memory, lead), 'project_location');
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

test('summary emphasizes requested date and consent remains server-owned', () => {
  const summary = baseQuestionFor(coreStub, 'confirm_summary', completeLead);
  assert.match(summary, /^Let me read that back\./);
  assert.match(summary, /date and time requested for Tuesday at 4:00 PM/);
  assert.match(summary, /Does all of that sound right\?$/);
  assert.equal(baseQuestionFor(coreStub, 'contact_consent', completeLead), coreStub.contactConsentQuestion);
});
