import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummaryRecoverySpeech,
  buildSummarySpeech,
  buildTurnAnalysisInstructions,
  createReceptionistConversation,
  isGroundedInCallerEvidence,
} from '../receptionist-conversation.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  clientId: 'client-123',
  serviceRequestWeekdays: [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ],
  earliestServiceRequestStart: '09:00',
  latestServiceRequestStart: '16:00',
  services: [
    { name: 'Wood Staining', description: 'Wood staining' },
    { name: 'Exterior Painting', description: 'Exterior painting' },
    { name: 'Interior Painting', description: 'Interior painting' },
    { name: 'Small Paint Repair', description: 'Small paint repair' },
  ],
  businessInformation: [
    { title: 'Business hours', info: 'Every day, 5 PM to 9 PM.' },
  ],
  knowledgeJson: JSON.stringify({
    businessInformation: [
      { title: 'Business hours', info: 'Every day, 5 PM to 9 PM.' },
    ],
    serviceAreas: ['Albany', 'Troy'],
  }),
});

function analysis(overrides = {}) {
  const { fields = {}, ...rest } = overrides;
  return {
    turn_status: 'complete',
    address_status: 'not_addressed',
    service_status: 'not_addressed',
    project_note: '',
    notes_summary: '',
    notes_complete: false,
    contact_consent: 'not_answered',
    summary_confirmation: 'not_answered',
    correction_field: 'none',
    business_answer_status: 'not_a_question',
    business_question: '',
    business_question_type: 'none',
    business_support: '',
    ...rest,
    fields: {
      service: '',
      name: '',
      address: '',
      preferred_date: '',
      preferred_time: '',
      ...fields,
    },
  };
}

function analyzedTurn(conversation, transcript, overrides = {}) {
  conversation.recordCallerTranscript(transcript);
  const preflight = conversation.preflight(transcript);
  if (preflight.type !== 'analyze') return preflight;
  return conversation.applyAnalysis(analysis(overrides), transcript);
}

function completeThroughSchedule(conversation) {
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', {
    fields: { name: 'Jordan Smith' },
  });
  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });
  return analyzedTurn(conversation, 'Tuesday at 1 PM.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '1 PM' },
  });
}

function completeToSummary(conversation) {
  completeThroughSchedule(conversation);
  analyzedTurn(conversation, 'No.', { notes_complete: true });
  const consent = analyzedTurn(conversation, 'Yes.', { contact_consent: 'yes' });
  assert.equal(consent.type, 'prepare');
  conversation.enterSummary({
    name: 'Jordan Smith',
    service: 'Exterior Painting',
    address: '123 Main Street, Albany, New York',
    preferredDateAndTime: 'Tuesday, August 11, 2099 at 1:00 PM',
    notes: 'None',
  });
}

test('one authoritative state advances through the required field order exactly once', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });

  let action = analyzedTurn(conversation, 'I need the exterior of my house painted.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  assert.match(action.text, /what name should I use/i);
  assert.equal(conversation.snapshot().pendingField, 'name');

  action = analyzedTurn(conversation, 'Jordan Smith works.', {
    fields: { name: 'Jordan Smith' },
  });
  assert.match(action.text, /full address.*service is needed/i);
  assert.equal(conversation.snapshot().pendingField, 'address');

  action = analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });
  assert.match(action.text, /day or date/i);
  assert.equal(conversation.snapshot().pendingField, 'schedule');

  action = analyzedTurn(conversation, 'Tuesday at 1 PM.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '1 PM' },
  });
  assert.match(action.text, /additional notes/i);
  assert.equal(conversation.snapshot().pendingField, 'notes');

  action = analyzedTurn(conversation, 'No.', { notes_complete: true });
  assert.match(action.text, /consent to being contacted/i);
  assert.equal(conversation.snapshot().pendingField, 'consent');

  action = analyzedTurn(conversation, 'Yes.', { contact_consent: 'yes' });
  assert.equal(action.type, 'prepare');
  assert.deepEqual(conversation.snapshot().completed, {
    service: true,
    name: true,
    address: true,
    schedule: true,
    notes: true,
    consent: true,
  });
});

test('a natural supplied-service request is accepted even when it ends as an availability question', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  const transcript = "I just got a new deck, and the crew didn't stain it, so I need wood staining done. Do you offer that?";
  const action = analyzedTurn(conversation, transcript, {
    service_status: 'complete',
    project_note: 'Stain the new deck.',
    fields: { service: 'Wood Staining' },
  });

  assert.match(action.text, /what name should I use/i);
  assert.equal(conversation.snapshot().values.service, 'Wood Staining');
  assert.deepEqual(conversation.snapshot().notes, ['Stain the new deck.']);
});

test('a reaction or unfinished thought stays silent and cannot complete service', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  assert.deepEqual(analyzedTurn(conversation, 'Oh.'), { type: 'wait', preserve: false });
  assert.deepEqual(analyzedTurn(conversation, 'Hey.'), { type: 'wait', preserve: false });
  assert.deepEqual(analyzedTurn(conversation, 'Um...'), { type: 'wait', preserve: false });
  assert.deepEqual(analyzedTurn(conversation, 'Mm.'), { type: 'wait', preserve: false });
  assert.equal(conversation.snapshot().pendingField, 'service');
});

test('a clearly spoken full address advances even when the analyzer omits it', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'I need the exterior of my house painted.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', { fields: { name: 'Andrew Christensen' } });

  const action = analyzedTurn(
    conversation,
    '197 Lancaster Road, Berlin, Massachusetts.',
    { address_status: 'not_addressed' },
  );

  assert.equal(conversation.snapshot().values.address, '197 Lancaster Road, Berlin, Massachusetts');
  assert.equal(conversation.snapshot().pendingField, 'schedule');
  assert.match(action.text, /day or date/i);
});

test('a city and state alone stay pending until a numbered street address is supplied', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });

  let action = analyzedTurn(conversation, 'Berlin, Massachusetts.', {
    address_status: 'complete',
    address_parts: { street: '', locality: 'Berlin', state: 'Massachusetts' },
    fields: { address: 'Berlin, Massachusetts' },
  });

  assert.equal(conversation.snapshot().values.address, '');
  assert.equal(conversation.snapshot().pendingField, 'address');
  assert.match(action.text, /street address/i);

  action = analyzedTurn(conversation, '197 Lancaster Road.', {
    address_status: 'partial',
    address_parts: { street: '197 Lancaster Road', locality: '', state: '' },
    fields: { address: '197 Lancaster Road' },
  });

  assert.equal(
    conversation.snapshot().values.address,
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(conversation.snapshot().pendingField, 'schedule');
  assert.match(action.text, /day or date/i);
});

test('a grounded full address outranks a false unintelligible label', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'I need the exterior of my house painted.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });

  const action = analyzedTurn(
    conversation,
    "It'd be 197 Lancaster Road, Berlin, Massachusetts.",
    {
      turn_status: 'unintelligible',
      address_status: 'complete',
      fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
    },
  );

  assert.match(action.text, /day or date/i);
  assert.doesNotMatch(action.text, /didn't catch/i);
  assert.equal(
    conversation.snapshot().values.address,
    '197 Lancaster Road, Berlin, Massachusetts',
  );
});

test('the logged spoken-number address is accepted once without another address question', () => {
  const context = {
    ...CONTEXT,
    services: [{ name: 'Mulching', description: 'Mulch installation and refreshing' }],
  };
  const conversation = createReceptionistConversation({ context });
  analyzedTurn(conversation, 'I need mulching redone.', {
    service_status: 'complete',
    fields: { service: 'Mulching' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.');

  const action = analyzedTurn(
    conversation,
    'Give one ninety seven Lancaster Road, Berlin, Massachusetts.',
    {
      address_status: 'complete',
      fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
    },
  );

  assert.equal(
    conversation.snapshot().values.address,
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(conversation.snapshot().pendingField, 'schedule');
  assert.match(action.text, /day or date/i);
  assert.doesNotMatch(action.text, /street address|where the service is needed|what state/i);
});

test('an unfinished notes question stays silent and is never stored as a note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  const action = analyzedTurn(conversation, 'I was wondering if you guys could...', {
    project_note: 'I was wondering if you guys could...',
  });

  assert.deepEqual(action, { type: 'wait', preserve: true });
  assert.equal(conversation.snapshot().pendingField, 'notes');
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('a caller note is saved and acknowledged when the analyzer leaves project_note blank', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  const action = analyzedTurn(
    conversation,
    'The side gate sticks, so please use the back gate.',
  );

  assert.equal(action.type, 'speak');
  assert.match(action.text, /Okay, I put that down\./);
  assert.match(action.text, /other notes or business questions/i);
  assert.deepEqual(
    conversation.snapshot().notes,
    ['The side gate sticks, so please use the back gate.'],
  );

  analyzedTurn(conversation, 'No.', { notes_complete: true });
  assert.equal(
    conversation.intakeArguments().additional_notes,
    'The side gate sticks, so please use the back gate.',
  );
});

test('an affirmative-prefixed note is saved immediately without an analyzer round trip', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  const action = conversation.captureObviousNote(
    "Yeah, uh, the lawn's a little bumpy, so just tell them to look out, you know.",
  );

  assert.equal(action.type, 'speak');
  assert.equal(
    action.text,
    'Okay, I put that down. Do you have any other notes or business questions?',
  );
  assert.deepEqual(conversation.snapshot().notes, [
    "The lawn's a little bumpy, so just tell them to look out, you know.",
  ]);
});

test('conversation-repair wording is never included in a saved note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  conversation.captureObviousNote("I already told you. The lawn's a little bumpy.");

  assert.deepEqual(conversation.snapshot().notes, ["The lawn's a little bumpy."]);
});

test('a plain lawn-mowing request is not duplicated into project notes', () => {
  const context = {
    ...CONTEXT,
    services: [{ name: 'Lawn Mowing', description: 'Lawn mowing' }],
  };
  const conversation = createReceptionistConversation({ context });

  analyzedTurn(
    conversation,
    'I was wondering if I could get someone to come over here and mow my lawn.',
    {
      service_status: 'complete',
      fields: { service: 'Lawn Mowing' },
    },
  );

  assert.deepEqual(conversation.snapshot().notes, []);
  assert.equal(conversation.snapshot().pendingField, 'name');
});

test('a grounded caller note replaces an analyzer note that was not supported by the call', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  const action = analyzedTurn(
    conversation,
    'Please park beside the red shed.',
    { project_note: 'Use the front entrance.' },
  );

  assert.match(action.text, /Okay, I put that down\./);
  assert.deepEqual(conversation.snapshot().notes, ['Please park beside the red shed.']);
});

test('the supplied call transcript no longer skips fields, repeats the address, or stores an abandoned note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });

  assert.deepEqual(analyzedTurn(conversation, 'Hey.'), { type: 'wait', preserve: false });
  assert.equal(conversation.snapshot().pendingField, 'service');

  let action = analyzedTurn(
    conversation,
    "I was looking to get the exterior of my house painted because it's just way too old.",
    {
      service_status: 'complete',
      fields: { service: 'Exterior Painting' },
    },
  );
  assert.match(action.text, /what name should I use/i);

  action = analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  assert.match(action.text, /full address.*service is needed/i);

  action = analyzedTurn(
    conversation,
    '197 Lancaster Road, Berlin, Massachusetts.',
    { address_status: 'not_addressed' },
  );
  assert.match(action.text, /day or date/i);
  assert.equal(conversation.snapshot().values.address, '197 Lancaster Road, Berlin, Massachusetts');

  action = analyzedTurn(conversation, 'Tuesday at 2 PM.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '2 PM' },
  });
  assert.match(action.text, /Do you have any additional notes and\/or business questions\?$/);

  action = analyzedTurn(conversation, 'Uh, yeah.');
  assert.equal(action.text, 'What notes or business questions would you like me to add?');

  assert.deepEqual(
    analyzedTurn(conversation, 'I was wondering if you guys could...', {
      project_note: 'I was wondering if you guys could...',
    }),
    { type: 'wait', preserve: true },
  );
  assert.doesNotMatch(conversation.snapshot().notes.join(' '), /wondering if you guys could/i);

  action = analyzedTurn(
    conversation,
    "I was wondering if you guys could... Actually, no, I don't.",
    {
      project_note: 'I was wondering if you guys could...',
      notes_complete: true,
    },
  );
  assert.match(action.text, /consent to being contacted/i);
  assert.doesNotMatch(conversation.snapshot().notes.join(' '), /wondering if you guys could/i);
});

test('conversation repair repeats only the genuinely pending question', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const action = analyzedTurn(conversation, 'What was the question?');
  assert.equal(action.type, 'speak');
  assert.equal(action.text, 'Do you have any additional notes and/or business questions?');
  assert.equal(conversation.snapshot().notes.length, 0);
});

test('several caller-provided fields in one turn are retained without skipping the next missing field', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  const transcript = 'I need exterior painting. My name is Jordan Smith, the address is 123 Main Street, Albany, New York, and Tuesday at 2 PM works.';
  const action = analyzedTurn(conversation, transcript, {
    service_status: 'complete',
    address_status: 'complete',
    fields: {
      service: 'Exterior Painting',
      name: 'Jordan Smith',
      address: '123 Main Street, Albany, New York',
      preferred_date: 'Tuesday',
      preferred_time: '2 PM',
    },
  });
  assert.match(action.text, /additional notes/i);
  assert.equal(conversation.snapshot().pendingField, 'notes');
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('project scope captured earlier stays in notes while the caller is asked only for additional notes', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'I need two upstairs rooms painted.', {
    service_status: 'complete',
    project_note: 'The two upstairs rooms need painting.',
    fields: { service: 'Interior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', {
    fields: { name: 'Jordan Smith' },
  });
  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });
  const action = analyzedTurn(conversation, 'Tuesday at 2 PM.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '2 PM' },
  });

  assert.match(action.text, /Do you have any additional notes and\/or business questions\?/i);
  assert.match(action.text, /business questions/i);
  assert.deepEqual(conversation.snapshot().notes, ['Paint the two upstairs rooms.']);
});

test('code owns service-note wording and rejects a bad analyzer paraphrase without going silent', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  const action = analyzedTurn(
    conversation,
    'I think I need a couple of rooms painted.',
    {
      service_status: 'complete',
      project_note: 'Needs rooms changed.',
      fields: { service: 'Interior Painting' },
    },
  );

  assert.equal(action.type, 'speak');
  assert.match(action.text, /what name should I use/i);
  assert.equal(conversation.snapshot().values.service, 'Interior Painting');
  assert.deepEqual(conversation.snapshot().notes, ['Paint a couple of rooms.']);
  assert.doesNotMatch(conversation.snapshot().notes.join(' '), /changed/i);
});

test('a contradictory complete-service analysis asks for clarification instead of staying silent', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  const action = analyzedTurn(conversation, 'I need a couple of rooms done.', {
    service_status: 'complete',
  });

  assert.equal(action.type, 'speak');
  assert.match(action.text, /tell me a little more about the work/i);
  assert.equal(conversation.snapshot().pendingField, 'service');
});

test('valid intake answers outrank a false business-question label and extra details become notes', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });

  let transcript = 'I just need, like, my whole basement repainted.';
  let action = analyzedTurn(conversation, transcript, {
    service_status: 'complete',
    project_note: 'My whole basement repainted.',
    business_answer_status: 'unanswerable',
    business_question: transcript,
    business_question_type: 'other',
    fields: { service: 'Interior Painting' },
  });
  assert.match(action.text, /what name should I use/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.equal(conversation.snapshot().values.service, 'Interior Painting');
  assert.deepEqual(conversation.snapshot().notes, ['Repaint the whole basement.']);

  transcript = 'Andrew Christensen.';
  action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
    business_question: transcript,
    business_question_type: 'other',
    fields: { name: 'Andrew Christensen' },
  });
  assert.match(action.text, /full address.*service is needed/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.equal(conversation.snapshot().values.name, 'Andrew Christensen');
  assert.deepEqual(conversation.snapshot().notes, ['Repaint the whole basement.']);

  transcript = '197 Lancaster Road, Berlin, Massachusetts. It is the big blue house so you do not miss it.';
  action = analyzedTurn(conversation, transcript, {
    address_status: 'complete',
    project_note: 'It is the big blue house so you do not miss it.',
    business_answer_status: 'unanswerable',
    business_question: transcript,
    business_question_type: 'other',
    fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
  });
  assert.match(action.text, /day or date/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.equal(
    conversation.snapshot().values.address,
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.deepEqual(conversation.snapshot().notes, [
    'Repaint the whole basement.',
    'It is the big blue house so you do not miss it.',
  ]);

  transcript = 'Tuesday at 2 PM.';
  action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
    business_question: transcript,
    business_question_type: 'other',
    fields: { preferred_date: 'Tuesday', preferred_time: '2 PM' },
  });
  assert.match(action.text, /additional notes/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.deepEqual(conversation.snapshot().notes, [
    'Repaint the whole basement.',
    'It is the big blue house so you do not miss it.',
  ]);
});

test('business-question fallback is disabled before notes and the pending service question repeats', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  const transcript = 'How do you remember?';
  let action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
    business_question: transcript,
    business_question_type: 'other',
  });

  assert.equal(action.text, 'What kind of work are you looking to have done?');
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.deepEqual(conversation.snapshot().notes, []);
  assert.equal(conversation.snapshot().pendingField, 'service');

  action = analyzedTurn(conversation, 'Uh, get my basement painted.', {
    service_status: 'complete',
    business_answer_status: 'unanswerable',
    business_question: 'Get my basement painted.',
    business_question_type: 'other',
    fields: { service: 'Interior Painting' },
  });
  assert.match(action.text, /what name should I use/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.equal(conversation.snapshot().values.service, 'Interior Painting');
  assert.deepEqual(conversation.snapshot().notes, ['Paint the basement.']);
});

test('useful service-step scope is retained even when the analyzer omits project_note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(
    conversation,
    "Um, I'm going to need my entire lower level repainted. The walls are peeling badly.",
    {
      service_status: 'complete',
      fields: { service: 'Interior Painting' },
    },
  );

  assert.equal(conversation.snapshot().values.service, 'Interior Painting');
  assert.deepEqual(conversation.snapshot().notes, [
    'Repaint the entire lower level. The walls are peeling badly.',
  ]);

  const simple = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(simple, 'I need interior painting.', {
    service_status: 'complete',
    fields: { service: 'Interior Painting' },
  });
  assert.deepEqual(simple.snapshot().notes, []);

  const scoped = createReceptionistConversation({ context: CONTEXT });
  const scopedAction = analyzedTurn(scoped, 'Can you paint my detached workshop?', {
    service_status: 'complete',
    business_answer_status: 'unanswerable',
    fields: { service: 'Exterior Painting' },
  });
  assert.doesNotMatch(scopedAction.text, /I don't know that/i);
  assert.deepEqual(scoped.snapshot().notes, ['Paint my detached workshop?']);
});

test('a question-mark inflection on a day and time is still a preference, never a note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', { fields: { name: 'Jordan Smith' } });
  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });

  const action = analyzedTurn(conversation, 'Probably, like, Monday at 1 PM?', {
    fields: { preferred_date: 'Monday', preferred_time: '1 PM' },
    project_note: 'Probably, like, Monday at 1 PM.',
    business_answer_status: 'unanswerable',
  });

  assert.match(action.text, /additional notes/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('a spoken schedule correction updates the locked preference and never becomes a note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  let action = analyzedTurn(conversation, 'Oh wait, no, scratch that. Can you do D12?', {
    project_note: 'Can you do D12?',
    business_answer_status: 'unanswerable',
  });

  assert.match(action.text, /update that preference/i);
  assert.match(action.text, /additional notes/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.equal(conversation.snapshot().values.preferredDate, '12');
  assert.equal(conversation.snapshot().values.preferredTime, '1 PM');
  assert.deepEqual(conversation.snapshot().notes, []);

  action = analyzedTurn(conversation, 'Não.');
  assert.match(action.text, /consent to being contacted/i);
  assert.equal(conversation.snapshot().pendingField, 'consent');
});

test('an ordinal day-of-month answer completes the date instead of becoming a note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', { fields: { name: 'Jordan Smith' } });
  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });

  const action = analyzedTurn(conversation, 'The 10th works for me.', {
    project_note: 'The 10th works for me.',
  });

  assert.equal(conversation.snapshot().values.preferredDate, 'The 10th');
  assert.equal(conversation.snapshot().pendingField, 'schedule');
  assert.equal(
    action.text,
    'What time, including AM or PM, would work best for the service request?',
  );
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('a question-shaped date request records only a preference and never claims availability', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', { fields: { name: 'Jordan Smith' } });
  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });

  const action = analyzedTurn(conversation, 'Can you do the 10th?', {
    project_note: 'The 10th.',
    business_answer_status: 'unanswerable',
  });

  assert.match(action.text, /put the 10th down as your preferred date/i);
  assert.match(action.text, /business will confirm the appointment/i);
  assert.doesNotMatch(action.text, /(?:date|10th) is available/i);
  assert.equal(conversation.snapshot().values.preferredDate, 'the 10th');
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('service-request-window questions use app constraints without promising availability', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', { fields: { name: 'Jordan Smith' } });
  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });
  const action = analyzedTurn(conversation, 'When do you accept service requests?', {
    business_answer_status: 'unanswerable',
    business_question: 'When do you accept service requests?',
    business_question_type: 'service_request_window',
  });

  assert.match(action.text, /accepts service requests/i);
  assert.match(action.text, /9:00 AM to 4:00 PM/i);
  assert.match(action.text, /business will confirm the request/i);
  assert.doesNotMatch(action.text, /available/i);
  assert.match(action.text, /day or date/i);
  assert.equal(conversation.snapshot().pendingField, 'schedule');
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('an invented project detail cannot enter notes even when the analyzer returns it', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'I need the exterior of my house painted.', {
    service_status: 'complete',
    project_note: 'The detached garage needs painting.',
    fields: { service: 'Exterior Painting' },
  });
  assert.equal(conversation.snapshot().values.service, 'Exterior Painting');
  assert.deepEqual(conversation.snapshot().notes, ['Paint the exterior of the house.']);
  assert.doesNotMatch(conversation.snapshot().notes.join(' '), /detached garage/i);
});

test('field reason questions get a short explanation and repeat only the pending question', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  let action = analyzedTurn(conversation, 'Why do you need to know the service?');
  assert.equal(action.text, 'So the business knows what kind of work you need. What kind of work are you looking to have done?');

  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  action = analyzedTurn(conversation, 'Why do you need my name?');
  assert.match(action.text, /knows who the service request is for.*What name should I use/i);

  analyzedTurn(conversation, 'Jordan Smith.', { fields: { name: 'Jordan Smith' } });
  action = analyzedTurn(conversation, 'What do you need my address for?');
  assert.match(action.text, /knows where the service is needed.*full address/i);

  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });
  action = analyzedTurn(conversation, 'Why do you need the date and time?');
  assert.match(action.text, /preferred day and time.*What day or date/i);

  analyzedTurn(conversation, 'Tuesday at 2 PM.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '2 PM' },
  });
  action = analyzedTurn(conversation, 'Why do you need additional notes?');
  assert.match(action.text, /other project details.*Do you have any additional notes/i);

  analyzedTurn(conversation, 'No.', { notes_complete: true });
  action = analyzedTurn(conversation, 'Why do you need my consent?');
  assert.match(action.text, /permission to contact you.*Do you consent/i);
  assert.deepEqual(conversation.snapshot().notes, []);
  assert.equal(conversation.snapshot().customerResistanceCount, 5);
});

test('AI identity questions are answered directly without changing intake state', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  const action = analyzedTurn(conversation, 'Are you a bot?');
  assert.equal(
    action.text,
    "I'm an AI receptionist working for Tabor Painting, managed by ARC Client Center. What kind of work are you looking to have done?",
  );
  assert.equal(conversation.snapshot().pendingField, 'service');
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('background speech does not advance a field or become a caller fragment', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  let action = analyzedTurn(conversation, 'Robert, move that box over there.', {
    turn_status: 'background_speech',
  });
  assert.deepEqual(action, { type: 'wait', preserve: false });

  action = analyzedTurn(conversation, 'Move the other one over there.', {
    turn_status: 'complete',
  });
  assert.deepEqual(action, { type: 'wait', preserve: false });
  assert.equal(conversation.snapshot().pendingField, 'service');
});

test('partial addresses stay pending and later fragments combine without invented geography', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', { fields: { name: 'Jordan Smith' } });

  let action = analyzedTurn(conversation, '123 Main Street.', {
    address_status: 'partial',
  });
  assert.equal(action.text, 'What city or town and state is that in?');
  assert.equal(conversation.snapshot().pendingField, 'address');

  action = analyzedTurn(conversation, 'Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });
  assert.match(action.text, /day or date/i);
  assert.equal(conversation.snapshot().values.address, '123 Main Street, Albany, New York');
});

test('a supplied town is retained and only the missing state is requested', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Wood staining.', {
    service_status: 'complete',
    fields: { service: 'Wood Staining' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });

  let action = analyzedTurn(conversation, '197 Lancaster Road. Berlin', {
    address_status: 'partial',
    fields: { address: '197 Lancaster Road, Berlin' },
  });
  assert.equal(action.text, 'What state is Berlin in?');
  assert.deepEqual(conversation.snapshot().partialAddressParts, {
    street: '197 Lancaster Road',
    locality: 'Berlin',
    state: '',
  });

  action = analyzedTurn(conversation, 'Earlon, Massachusetts.', {
    address_status: 'partial',
    address_parts: { street: '', locality: 'Earlon', state: 'Massachusetts' },
  });
  assert.match(action.text, /day or date/i);
  assert.equal(
    conversation.snapshot().values.address,
    '197 Lancaster Road, Berlin, Massachusetts',
  );
});

test('the logged address sequence ignores a bad fragment and accepts the later city and state', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Interior painting.', {
    service_status: 'complete',
    fields: { service: 'Interior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });

  let action = analyzedTurn(conversation, "That'd be 197 Lancaster Road.", {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road' },
  });
  assert.equal(action.text, 'What city or town and state is that in?');
  assert.equal(conversation.snapshot().partialAddress, '197 Lancaster Road');

  action = analyzedTurn(conversation, 'Brown University.', {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road, Brown University' },
  });
  assert.deepEqual(action, { type: 'wait', preserve: true });
  assert.equal(conversation.snapshot().values.address, '');

  action = analyzedTurn(conversation, 'Berlin, Massachusetts.', {
    turn_status: 'background_speech',
  });
  assert.match(action.text, /day or date/i);
  assert.equal(
    conversation.snapshot().values.address,
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(conversation.snapshot().partialAddress, '');
});

test('the supplied split-address call waits for locality, avoids schedule repetition, and saves a concise note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });

  let action = analyzedTurn(
    conversation,
    'I was just looking to see if I could get my basement painted.',
    {
      service_status: 'complete',
      project_note: 'I was just looking to see if I could get my basement painted.',
      fields: { service: 'Interior Painting' },
    },
  );
  assert.match(action.text, /what name should I use/i);
  assert.deepEqual(conversation.snapshot().notes, ['Paint the basement.']);

  action = analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  assert.match(action.text, /full address.*service is needed/i);

  action = analyzedTurn(conversation, 'That would be 197 Lancaster Road.', {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road' },
  });
  assert.equal(action.text, 'What city or town and state is that in?');
  assert.equal(conversation.snapshot().values.address, '');
  assert.equal(conversation.snapshot().pendingField, 'address');

  action = analyzedTurn(conversation, 'Berlin, Massachusetts.', {
    turn_status: 'conversation_repair',
    address_status: 'complete',
    fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
  });
  assert.match(action.text, /day or date/i);
  assert.equal(
    conversation.snapshot().values.address,
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(conversation.snapshot().pendingField, 'schedule');

  action = analyzedTurn(conversation, 'Probably Thursday at like 3 PM.', {
    business_answer_status: 'answerable',
    business_question: 'Probably Thursday at like 3 PM.',
    business_question_type: 'service_request_window',
    business_support: 'Monday through Friday from 9:00 AM to 5:00 PM.',
    fields: { preferred_date: 'Thursday', preferred_time: '3 PM' },
  });
  assert.match(action.text, /additional notes and\/or business questions/i);
  assert.doesNotMatch(action.text, /accepts service requests/i);
  assert.doesNotMatch(action.text, /what day or date/i);
  assert.equal(conversation.snapshot().pendingField, 'notes');
  assert.deepEqual(conversation.snapshot().notes, ['Paint the basement.']);
});

test('caller evidence prevents names and addresses from being copied from business data', () => {
  assert.equal(isGroundedInCallerEvidence('Jordan Smith', ['Jordan Smith works.']), true);
  assert.equal(isGroundedInCallerEvidence('123 Main Street', ['The address is 123 Main Street.']), true);
  assert.equal(isGroundedInCallerEvidence('Pat Owner', ['I need exterior painting.']), false);
  assert.equal(isGroundedInCallerEvidence('999 Invented Street', ['123 Main Street.']), false);
  assert.equal(isGroundedInCallerEvidence('10', ['The 10th works.']), true);
});

test('a grounded project phrase still cannot be mislabeled as the caller name', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'I need exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  const action = analyzedTurn(conversation, 'A couple rooms painted.', {
    fields: { name: 'A couple rooms painted' },
  });
  assert.equal(conversation.snapshot().values.name, '');
  assert.match(action.text, /what name should I use/i);
});

test('a literal caller name advances even when analysis incorrectly calls it unintelligible', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'I need exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });

  const action = analyzedTurn(conversation, 'Andrew Christensen.', {
    turn_status: 'unintelligible',
  });

  assert.match(action.text, /full address.*service is needed/i);
  assert.doesNotMatch(action.text, /what name should I use/i);
  assert.equal(conversation.snapshot().values.name, 'Andrew Christensen');
  assert.equal(conversation.snapshot().pendingField, 'address');
});

test('a bare hour always asks for AM or PM and a meridiem-only reply completes it', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  analyzedTurn(conversation, '197 Lincoln Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lincoln Road, Berlin, Massachusetts' },
  });

  let action = analyzedTurn(conversation, 'Tuesday at 1.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '1' },
  });
  assert.equal(action.text, 'Do you mean AM or PM?');
  assert.equal(conversation.snapshot().pendingField, 'schedule');

  action = analyzedTurn(conversation, 'PM.');
  assert.match(action.text, /additional notes/i);
  assert.equal(conversation.snapshot().values.preferredTime, '1 pm');
  assert.equal(conversation.snapshot().pendingField, 'notes');
});

test('a natural daypart-only clarification completes a previously bare hour', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  analyzedTurn(conversation, '197 Lincoln Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lincoln Road, Berlin, Massachusetts' },
  });

  let action = analyzedTurn(conversation, 'Tuesday at 1.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '1' },
  });
  assert.equal(action.text, 'Do you mean AM or PM?');

  action = analyzedTurn(conversation, 'In the afternoon.');
  assert.match(action.text, /additional notes/i);
  assert.equal(conversation.snapshot().values.preferredTime, '1 pm');
});

test('Tuesday at 3 in the afternoon advances when the analyzer drops the time', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  analyzedTurn(conversation, '197 Lincoln Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lincoln Road, Berlin, Massachusetts' },
  });

  const action = analyzedTurn(conversation, 'Tuesday at 3 in the afternoon.', {
    fields: { preferred_date: 'Tuesday', preferred_time: '' },
  });

  assert.match(action.text, /additional notes/i);
  assert.equal(conversation.snapshot().values.preferredDate, 'Tuesday');
  assert.equal(conversation.snapshot().values.preferredTime, '3 in the afternoon');
  assert.equal(conversation.snapshot().pendingField, 'notes');
});

test('a bare time-only reply asks for AM or PM after saving the date', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  analyzedTurn(conversation, '197 Lincoln Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lincoln Road, Berlin, Massachusetts' },
  });

  let action = analyzedTurn(conversation, 'Tuesday.', {
    fields: { preferred_date: 'Tuesday' },
  });
  assert.equal(
    action.text,
    'What time, including AM or PM, would work best for the service request?',
  );

  action = analyzedTurn(conversation, '3.');
  assert.equal(action.text, 'Do you mean AM or PM?');
  assert.equal(conversation.snapshot().pendingField, 'schedule');

  action = analyzedTurn(conversation, 'PM.');
  assert.match(action.text, /additional notes/i);
  assert.equal(conversation.snapshot().values.preferredTime, '3 pm');
  assert.equal(conversation.snapshot().pendingField, 'notes');
});

test('a clearly spoken exact time wins over a false unintelligible analysis', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.');
  analyzedTurn(conversation, '197 Lincoln Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lincoln Road, Berlin, Massachusetts' },
  });
  analyzedTurn(conversation, 'Tuesday.', {
    fields: { preferred_date: 'Tuesday' },
  });

  const action = analyzedTurn(conversation, '3 p.m.', {
    turn_status: 'unintelligible',
  });

  assert.match(action.text, /additional notes/i);
  assert.doesNotMatch(action.text, /didn't catch|what time would work best/i);
  assert.equal(conversation.snapshot().values.preferredTime, '3 pm');
  assert.equal(conversation.snapshot().pendingField, 'notes');
});

test('an exact time stays structured while a separate timing detail becomes a concise note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.');
  analyzedTurn(conversation, '197 Lincoln Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lincoln Road, Berlin, Massachusetts' },
  });

  const action = analyzedTurn(
    conversation,
    'Next Monday at 9 a.m. You can come an hour earlier if you want.',
    {
      project_note: 'Can come an hour earlier.',
      fields: { preferred_date: 'Next Monday', preferred_time: '9 a.m.' },
    },
  );

  assert.match(action.text, /additional notes/i);
  assert.equal(conversation.snapshot().values.preferredTime, '9 a.m.');
  assert.deepEqual(conversation.snapshot().notes, ['Can come an hour earlier.']);
  assert.doesNotMatch(conversation.snapshot().notes.join(' '), /9\s*a\.?m/i);
});

test('a bare hour asks for AM or PM before checking the service-request window', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Interior painting.', {
    service_status: 'complete',
    fields: { service: 'Interior Painting' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  analyzedTurn(conversation, '197 Lancaster Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
  });

  let action = analyzedTurn(conversation, 'Next Monday at 6.', {
    fields: { preferred_date: 'Next Monday', preferred_time: '6' },
  });
  assert.equal(action.text, 'Do you mean AM or PM?');

  action = analyzedTurn(conversation, 'PM.');
  assert.equal(
    action.text,
    "I'm sorry, I need a time between 9:00 AM and 4:00 PM. What time in that range would you prefer?",
  );
  assert.equal(conversation.snapshot().values.preferredDate, 'Next Monday');
  assert.equal(conversation.snapshot().values.preferredTime, '');
});

test('an unavailable day stays pending with a useful replacement question', () => {
  const context = {
    ...CONTEXT,
    serviceRequestWeekdays: ['monday'],
  };
  const conversation = createReceptionistConversation({ context });
  analyzedTurn(conversation, 'Exterior painting.', {
    service_status: 'complete',
    fields: { service: 'Exterior Painting' },
  });
  analyzedTurn(conversation, 'Jordan Smith.', { fields: { name: 'Jordan Smith' } });
  analyzedTurn(conversation, '123 Main Street, Albany, New York.', {
    address_status: 'complete',
    fields: { address: '123 Main Street, Albany, New York' },
  });
  const action = analyzedTurn(conversation, 'Tuesday, August 11, 2099 at 2 PM.', {
    fields: { preferred_date: 'August 11 2099', preferred_time: '2 PM' },
  });
  assert.match(action.text, /listed service-request days are Monday/i);
  assert.doesNotMatch(action.text, /available/i);
  assert.equal(conversation.snapshot().pendingField, 'schedule');
  assert.equal(conversation.snapshot().values.preferredDate, '');
});

test('a project statement with a conversational question tag remains a note', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const note = 'The shed is rotted out a bit, so please avoid damaging it further, you know what I mean?';
  const action = analyzedTurn(conversation, note, {
    project_note: note,
    business_answer_status: 'unanswerable',
    business_question: note,
    business_question_type: 'other',
  });
  assert.match(action.text, /other notes/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.doesNotMatch(action.text, /business information/i);
  assert.deepEqual(conversation.snapshot().notes, [note]);
});

test('an indirect business question is still recognized without a question mark', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const transcript = 'I was wondering what hours you are open';
  const action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'answerable',
    business_support: 'Every day, 5 PM to 9 PM.',
  });
  assert.match(action.text, /business information, Every day, 5 PM to 9 PM/i);
  assert.match(action.text, /other notes or business questions/i);
  assert.equal(conversation.snapshot().pendingField, 'notes');
});

test('the analyzer can identify a business question by meaning without a keyword-shaped sentence', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const transcript = "Turnaround for something like this is information I'd appreciate.";
  const action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
    business_question: transcript,
  });

  assert.equal(
    action.text,
    "I'm sorry, I don't know that one. I'll add it to the notes. Do you have any other notes or business questions?",
  );
  assert.deepEqual(conversation.snapshot().notes, [transcript]);
});

test('notes-step duration questions from the supplied transcript are answered or recorded instead of reprompted', () => {
  for (const [transcript, savedQuestion] of [
    [
      'Yeah, um, I was just wondering, like, how long will it take for the job to get done?',
      'How long will it take for the job to get done?',
    ],
    [
      'I just asked how long will it take for the job to get done.',
      'How long will it take for the job to get done?',
    ],
    [
      'Yeah, I was wondering how long it takes to have the job done, like how long will it be?',
      'How long does it take to have the job done?',
    ],
  ]) {
    const conversation = createReceptionistConversation({ context: CONTEXT });
    completeThroughSchedule(conversation);
    const action = analyzedTurn(conversation, transcript, {
      service_status: 'complete',
      business_answer_status: 'unanswerable',
      business_question: transcript,
      business_question_type: 'other',
      fields: { service: 'Exterior Painting' },
    });

    assert.equal(
      action.text,
      "I'm sorry, I don't know that one. I'll add it to the notes. Do you have any other notes or business questions?",
    );
    assert.deepEqual(conversation.snapshot().notes, [savedQuestion]);
    assert.equal(conversation.snapshot().pendingField, 'notes');
  }
});

test('the latest supplied call becomes concise notes without preserving a hesitation', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(
    conversation,
    'The house painted like the whole outside of my house is painted.',
    {
      service_status: 'complete',
      project_note: 'Paint the whole outside of the house.',
      fields: { service: 'Exterior Painting' },
    },
  );
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  analyzedTurn(conversation, '197 Lancaster Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
  });
  analyzedTurn(conversation, 'Tuesday at noon.', {
    fields: { preferred_date: 'Tuesday', preferred_time: 'noon' },
  });

  assert.deepEqual(analyzedTurn(conversation, 'Mm.'), {
    type: 'wait',
    preserve: false,
  });
  const question = 'Yeah, I was wondering how long it takes to have the job done, like how long will it be?';
  const action = analyzedTurn(conversation, question, {
    business_answer_status: 'unanswerable',
    business_question: 'How long will the job take?',
    business_question_type: 'other',
  });

  assert.match(action.text, /I don't know that/i);
  assert.deepEqual(conversation.snapshot().notes, [
    'Paint the whole outside of the house.',
    'How long will the job take?',
  ]);
});

test('the supplied repair call simplifies its notes and handles a duration question despite a false notes correction', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  const serviceTurn = "Um, well, uh, I'm just looking to get, like, a hole in my wall fixed. I, yeah, I accidentally punched it, if I'm gonna be honest with you.";
  analyzedTurn(conversation, serviceTurn, {
    service_status: 'complete',
    project_note: "Fix I'm just looking to get, like, a hole in the wall. I, yeah, I accidentally punched it, if I'm gonna be honest with you.",
    fields: { service: 'Small Paint Repair' },
  });
  analyzedTurn(conversation, 'Andrew works fine.', {
    fields: { name: 'Andrew' },
  });
  analyzedTurn(conversation, '197 Lancaster Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
  });
  analyzedTurn(conversation, 'Next Thursday at 3 PM.', {
    fields: { preferred_date: 'Next Thursday', preferred_time: '3 PM' },
  });

  const question = 'Yeah, I was wondering how long the patch will take?';
  const action = analyzedTurn(conversation, question, {
    correction_field: 'notes',
    project_note: 'How long the patch will take?',
  });

  assert.equal(
    action.text,
    "I'm sorry, I don't know that one. I'll add it to the notes. Do you have any other notes or business questions?",
  );
  assert.deepEqual(conversation.snapshot().notes, [
    'Fix a hole in the wall. Accidentally punched it.',
    'How long will the patch take?',
  ]);
});

test('service and callback questions use supplied data while only an unknown duration is saved cleanly', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  let transcript = 'Uh, yeah, I was wondering, like, how long would it take just to paint, like, one room?';
  let action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
    business_question: 'how long would it take just to paint one room?',
    business_question_type: 'other',
  });
  assert.match(action.text, /I don't know that/i);
  assert.deepEqual(conversation.snapshot().notes, ['How long would it take to paint one room?']);

  transcript = 'Yeah, so after you send them this request, how long would it take for them to get back to me?';
  action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'answerable',
    business_question: 'how long would it take for them to get back to me?',
    business_question_type: 'lead_response_time',
  });
  assert.match(action.text, /hear back from Tabor Painting within one week/i);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.deepEqual(conversation.snapshot().notes, ['How long would it take to paint one room?']);

  transcript = 'Yeah, how many services does paper painting offer?';
  action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
    business_question: 'how many services does paper painting offer?',
    business_question_type: 'service_count',
  });
  assert.match(action.text, /Tabor Painting offers four services/i);
  assert.doesNotMatch(action.text, /I don't know that/i);

  transcript = 'Yeah, what services does paper painting offer?';
  action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
    business_question: 'what services does paper painting offer?',
    business_question_type: 'service_list',
  });
  assert.match(action.text, /Wood Staining/);
  assert.match(action.text, /Exterior Painting/);
  assert.match(action.text, /Interior Painting/);
  assert.match(action.text, /Small Paint Repair/);
  assert.doesNotMatch(action.text, /I don't know that/i);
  assert.deepEqual(conversation.snapshot().notes, ['How long would it take to paint one room?']);
});

test('misclassified questions about other services fall back to the dynamic supplied catalog', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  analyzedTurn(conversation, 'Wood staining.', {
    service_status: 'complete',
    fields: { service: 'Wood Staining' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.', {
    fields: { name: 'Andrew Christensen' },
  });
  analyzedTurn(conversation, '197 Lancaster Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
  });
  analyzedTurn(conversation, 'Friday at 3 PM.', {
    fields: { preferred_date: 'Friday', preferred_time: '3 PM' },
  });

  let action = analyzedTurn(conversation, 'Yeah, how many other services do you guys offer?', {
    correction_field: 'notes',
    business_question_type: 'other',
  });
  assert.match(action.text, /Tabor Painting lists three other services/i);
  assert.doesNotMatch(action.text, /I don't know/i);
  assert.deepEqual(conversation.snapshot().notes, []);

  action = analyzedTurn(conversation, 'What other services are available?', {
    business_answer_status: 'unanswerable',
    business_question: 'What other services are available?',
    business_question_type: 'remaining_service_list',
  });
  assert.match(action.text, /Exterior Painting/);
  assert.match(action.text, /Interior Painting/);
  assert.match(action.text, /Small Paint Repair/);
  assert.doesNotMatch(action.text, /Wood Staining/);
  assert.deepEqual(conversation.snapshot().notes, []);
});

test('service-catalog answers use an unrelated business context without trade-specific rules', () => {
  const context = {
    ...CONTEXT,
    businessName: 'Northside Home Services',
    services: [
      { name: 'Drain Clearing', description: 'Clear blocked household drains' },
      { name: 'Water Heater Repair', description: 'Diagnose and repair water heaters' },
      { name: 'Sewer Camera Inspection', description: 'Inspect sewer lines by camera' },
    ],
  };
  const conversation = createReceptionistConversation({ context });

  let action = analyzedTurn(conversation, 'Which services do you provide?', {
    business_answer_status: 'unanswerable',
    business_question: 'Which services do you provide?',
    business_question_type: 'service_list',
  });
  assert.match(action.text, /Drain Clearing/);
  assert.match(action.text, /Water Heater Repair/);
  assert.match(action.text, /Sewer Camera Inspection/);
  assert.match(action.text, /kind of work/i);

  action = analyzedTurn(conversation, "The kitchen sink won't empty. Can you take care of it?", {
    service_status: 'complete',
    project_note: 'The kitchen sink will not empty.',
    fields: { service: 'Drain Clearing' },
  });
  assert.match(action.text, /what name should I use/i);
  assert.equal(conversation.snapshot().values.service, 'Drain Clearing');
});

test('an owner-supplied Title and Info fact answers a semantic business question', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const transcript = 'When could I stop by?';
  const action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'answerable',
    business_question: 'When could I stop by?',
    business_question_type: 'other',
    business_support: 'Every day, 5 PM to 9 PM.',
  });
  assert.match(action.text, /business information, Every day, 5 PM to 9 PM/i);
  assert.match(action.text, /other notes or business questions/i);
  assert.equal(conversation.snapshot().pendingField, 'notes');
  assert.equal(conversation.snapshot().notes.length, 0);
});

test('turn analysis receives owner-supplied Title and Info facts as semantic evidence', () => {
  const instructions = buildTurnAnalysisInstructions({
    state: { pendingField: 'notes' },
    callerTranscript: 'When could I stop by?',
    context: CONTEXT,
  });

  assert.match(instructions, /SUPPLIED_BUSINESS_INFORMATION=/);
  assert.match(instructions, /Every day, 5 PM to 9 PM/);
  assert.match(instructions, /mark it unanswerable/);
  assert.match(instructions, /only the requested service may be semantically mapped/i);
  assert.match(instructions, /summarize the complete AUTHORITATIVE_CALL_STATE\.notes list/i);
  assert.match(instructions, /saved unanswered business question/i);
});

test('an unsupported business question is not answered from general knowledge and is saved once', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const transcript = 'How long does it take to paint a shed?';
  const action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'unanswerable',
  });
  assert.match(action.text, /I don't know that/i);
  assert.match(action.text, /other notes or business questions/i);
  assert.deepEqual(conversation.snapshot().notes, [transcript]);
});

test('a claimed business answer without exact supplied support is rejected', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const transcript = 'Do you guarantee the work?';
  const action = analyzedTurn(conversation, transcript, {
    business_answer_status: 'answerable',
    business_support: 'All work has a lifetime guarantee',
  });
  assert.match(action.text, /I don't know that/i);
  assert.doesNotMatch(action.text, /lifetime guarantee/i);
});

test('notes cannot be skipped until the caller explicitly completes that step', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  let action = analyzedTurn(conversation, 'The back wall has peeling paint.', {
    project_note: 'The back wall has peeling paint.',
    contact_consent: 'yes',
  });
  assert.match(action.text, /other notes/i);
  assert.equal(conversation.snapshot().pendingField, 'notes');

  action = analyzedTurn(conversation, 'No more.', { notes_complete: true });
  assert.match(action.text, /consent to being contacted/i);
  assert.doesNotMatch(action.text, /thanks for the notes/i);
  assert.equal(conversation.snapshot().pendingField, 'consent');
});

test('a clear Nao completes the notes step even when analysis calls it unintelligible', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);

  const action = analyzedTurn(conversation, 'Nao.', {
    turn_status: 'unintelligible',
  });

  assert.match(action.text, /consent to being contacted/i);
  assert.equal(conversation.snapshot().completed.notes, true);
  assert.equal(conversation.snapshot().pendingField, 'consent');
});

test('the logged split rubber-mulch note is summarized, acknowledged, and retained', () => {
  const context = {
    ...CONTEXT,
    earliestServiceRequestStart: '08:00',
    services: [{ name: 'Mulching', description: 'Mulch installation and refreshing' }],
  };
  const conversation = createReceptionistConversation({ context });
  const serviceTranscript = "I don't know, I just need some, uh I had mulching done last year and I need like redone or filled in, whatever the hell they call it.";
  analyzedTurn(conversation, serviceTranscript, {
    service_status: 'complete',
    project_note: serviceTranscript,
    fields: { service: 'Mulching' },
  });
  analyzedTurn(conversation, 'Andrew Christensen.');
  analyzedTurn(conversation, '197 Lancaster Road, Berlin, Massachusetts.', {
    address_status: 'complete',
    fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
  });
  analyzedTurn(conversation, 'Wednesday at 8 a.m.', {
    fields: { preferred_date: 'Wednesday', preferred_time: '8 a.m.' },
  });

  const firstFragment = 'Mmm. Yeah. I so my note is um I want a, I want the the rubber mulch that they, that they sell at, I think they sell it at the Home Depot or something like that';
  const unfinished = analyzedTurn(conversation, firstFragment, {
    turn_status: 'unfinished',
  });
  assert.deepEqual(unfinished, { type: 'wait', preserve: true });

  const fullNote = `${firstFragment} I already have two bags of it, so they could just use those two bags and then get some more and then do it like that. That'd be great`;
  const action = analyzedTurn(conversation, fullNote, {
    project_note: 'Use two existing bags of rubber mulch and get more from Home Depot.',
  });

  assert.equal(
    action.text,
    'Okay, I put that down. Do you have any other notes or business questions?',
  );
  assert.deepEqual(conversation.snapshot().notes, [
    'Mulching done last year needs to be redone or filled in.',
    'Use two existing bags of rubber mulch and get more from Home Depot.',
  ]);

  analyzedTurn(conversation, 'No, not anymore.', { notes_complete: true });
  assert.equal(
    conversation.intakeArguments().additional_notes,
    'Mulching done last year needs to be redone or filled in. Use two existing bags of rubber mulch and get more from Home Depot.',
  );
});

test('an explicit mid-call correction updates a locked field without changing the flow order', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  const transcript = 'Actually, use 456 Oak Avenue, Albany, New York.';
  const action = analyzedTurn(conversation, transcript, {
    correction_field: 'address',
    address_status: 'complete',
    fields: { address: '456 Oak Avenue, Albany, New York' },
  });
  assert.equal(conversation.snapshot().values.address, '456 Oak Avenue, Albany, New York');
  assert.equal(conversation.snapshot().pendingField, 'notes');
  assert.match(action.text, /additional notes/i);
});

test('contact permission cannot confirm the final summary', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  analyzedTurn(conversation, 'No.', { notes_complete: true });
  const consent = analyzedTurn(conversation, 'Yes.', {
    contact_consent: 'yes',
    summary_confirmation: 'yes',
  });
  assert.equal(consent.type, 'prepare');
  assert.notEqual(consent.type, 'submit');
});

test('the analyzer\'s explicit consent refusal wins over a misleading leading yes', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  analyzedTurn(conversation, 'No notes.', { notes_complete: true });
  const action = analyzedTurn(conversation, 'Yes—actually, do not contact me.', {
    contact_consent: 'no',
  });
  assert.equal(action.type, 'end');
  assert.equal(conversation.snapshot().phase, 'ending');
});

test('summary corrections replace only the corrected field and require another readback', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeToSummary(conversation);
  const transcript = 'No, the address is 456 Oak Avenue, Albany, New York.';
  const action = analyzedTurn(conversation, transcript, {
    summary_confirmation: 'no',
    correction_field: 'address',
    address_status: 'complete',
    fields: { address: '456 Oak Avenue, Albany, New York' },
  });
  assert.equal(action.type, 'prepare');
  assert.equal(conversation.snapshot().values.address, '456 Oak Avenue, Albany, New York');
  assert.equal(conversation.snapshot().values.name, 'Jordan Smith');
});

test('a summary correction wins over a leading yes and cannot accidentally submit', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeToSummary(conversation);
  const transcript = 'Yes, but the address is 456 Oak Avenue, Albany, New York.';
  const action = analyzedTurn(conversation, transcript, {
    summary_confirmation: 'yes',
    correction_field: 'address',
    address_status: 'complete',
    fields: { address: '456 Oak Avenue, Albany, New York' },
  });
  assert.equal(action.type, 'prepare');
  assert.equal(conversation.snapshot().phase, 'preparing');
  assert.equal(conversation.snapshot().values.address, '456 Oak Avenue, Albany, New York');
});

test('correcting only the summary time preserves the already confirmed day', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeToSummary(conversation);
  const action = analyzedTurn(conversation, 'No, make that 3 PM.', {
    summary_confirmation: 'no',
    correction_field: 'schedule',
    fields: { preferred_time: '3 PM' },
  });
  assert.equal(action.type, 'prepare');
  assert.equal(conversation.snapshot().values.preferredDate, 'Tuesday');
  assert.equal(conversation.snapshot().values.preferredTime, '3 PM');
});

test('only a separate yes to the complete readback permits submission', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeToSummary(conversation);
  const action = analyzedTurn(conversation, 'Yes, that all sounds right.', {
    summary_confirmation: 'yes',
  });
  assert.deepEqual(action, { type: 'submit' });
  assert.equal(conversation.snapshot().phase, 'submitting');
});

test('summary speech omits empty notes and includes actual notes once', () => {
  const base = {
    name: 'Jordan Smith',
    service: 'Exterior Painting',
    address: '123 Main Street, Albany, New York',
    preferredDateAndTime: 'Tuesday, August 11, 2099 at 1:00 PM',
  };
  const empty = buildSummarySpeech({ ...base, notes: 'None' });
  assert.doesNotMatch(empty, /notes/i);
  assert.match(empty, /Does that all sound right\?$/);

  const withNotes = buildSummarySpeech({ ...base, notes: 'The back wall has peeling paint.' });
  assert.equal((withNotes.match(/back wall has peeling paint/gi) || []).length, 1);

  const recovery = buildSummaryRecoverySpeech({
    ...base,
    notes: 'The back wall has peeling paint. How long would it take to paint one room?',
  });
  assert.match(recovery, /readback was cut off/i);
  assert.match(recovery, /included the additional notes/i);
  assert.doesNotMatch(recovery, /back wall has peeling paint/i);
  assert.equal((recovery.match(/Does that all sound right\?/g) || []).length, 1);
});

test('refusing contact permission ends without preparing or submitting', () => {
  const conversation = createReceptionistConversation({ context: CONTEXT });
  completeThroughSchedule(conversation);
  analyzedTurn(conversation, 'No notes.', { notes_complete: true });
  const action = analyzedTurn(conversation, 'No, do not contact me.', { contact_consent: 'no' });
  assert.equal(action.type, 'end');
  assert.match(action.text, /can't submit/i);
  assert.equal(conversation.snapshot().phase, 'ending');
});
