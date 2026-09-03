import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIntakeManager,
  matchService,
  normalizeCallerName,
  normalizeProjectAddress,
  normalizeRequestedTime,
  normalizeRequestedTimeWindow,
  resolveRequestedDate,
  sanitizeAdditionalNotes,
} from '../intake.js';

const NOW = new Date('2026-08-03T16:00:00.000Z');
const CONTEXT = Object.freeze({
  clientId: 'client-123',
  timeZone: 'America/New_York',
  serviceRequestWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestServiceRequestStart: '09:00',
  latestServiceRequestStart: '16:00',
  services: [
    { name: 'Interior Painting', description: 'Walls and ceilings' },
    { name: 'Exterior Painting', description: 'Siding and trim' },
  ],
});

const EMERGENCY_CONTEXT = Object.freeze({
  ...CONTEXT,
  serviceRequestRouting: Object.freeze({
    mode: 'asap-or-scheduled',
    timingQuestion: 'Do you need help as soon as possible, or would you prefer to schedule a time?',
    scheduled: Object.freeze({ enabled: true }),
    emergency: Object.freeze({
      enabled: true,
      availability: '24/7',
      intakeField: 'requestUrgency',
      intakeValue: 'emergency',
      requestedTimeWindow: 'As soon as possible',
    }),
  }),
});

const VALID_DRAFT = Object.freeze({
  service: 'interior painting',
  name: 'Jordan Smith',
  address: '123 Main Street, Albany, NY 12207',
  preferred_date: 'Tuesday',
  preferred_time: 'afternoon',
  additional_notes: '',
  additional_notes_asked: true,
  consent_to_contact: true,
  consent_asked_separately: true,
});

test('converts a spoken weekday to an exact date in the business timezone', () => {
  const date = resolveRequestedDate('Tuesday', {
    now: NOW,
    timeZone: 'America/New_York',
  });
  assert.equal(date.exactDate, '2026-08-04');
  assert.equal(date.spokenDate, 'Tuesday, August 4, 2026');
});

test('treats next weekday as the following week and makes it explicit', () => {
  const date = resolveRequestedDate('next Tuesday', {
    now: NOW,
    timeZone: 'America/New_York',
  });
  assert.equal(date.exactDate, '2026-08-11');
  assert.equal(date.spokenDate, 'Tuesday, August 11, 2026');
});

test('accepts a spoken day of the month and resolves its next occurrence', () => {
  const date = resolveRequestedDate('the 8th', {
    now: new Date('2026-08-09T16:00:00.000Z'),
    timeZone: 'America/New_York',
  });
  assert.equal(date.exactDate, '2026-09-08');
  assert.equal(date.spokenDate, 'Tuesday, September 8, 2026');

  const ordinal = resolveRequestedDate('the 10th', {
    now: new Date('2026-08-09T16:00:00.000Z'),
    timeZone: 'America/New_York',
  });
  assert.equal(ordinal.exactDate, '2026-08-10');
  assert.equal(ordinal.spokenDate, 'Monday, August 10, 2026');
});

test('asks for a broad window when a clock time is ambiguous', () => {
  assert.throws(() => normalizeRequestedTimeWindow('3:30'), /morning or afternoon/i);
  assert.equal(normalizeRequestedTimeWindow('3:30 pm'), 'Afternoon');
  assert.equal(normalizeRequestedTime('3:30 pm'), 'Afternoon');
});

test('normalizes broad preferences and volunteered exact times to time windows', () => {
  assert.throws(() => normalizeRequestedTimeWindow('1'), /morning or afternoon/i);
  assert.throws(() => normalizeRequestedTimeWindow('nine'), /morning or afternoon/i);
  assert.equal(normalizeRequestedTimeWindow('nine am'), 'Morning');
  assert.equal(normalizeRequestedTimeWindow('10 a.m.'), 'Morning');
  assert.equal(normalizeRequestedTimeWindow('7 in the morning'), 'Morning');
  assert.equal(normalizeRequestedTimeWindow('3 in the afternoon'), 'Afternoon');
  assert.equal(normalizeRequestedTimeWindow('after lunch'), 'Afternoon');
  assert.equal(normalizeRequestedTimeWindow('either morning or afternoon'), 'Flexible');
  assert.throws(() => normalizeRequestedTimeWindow('in the evening'), /morning or afternoon/i);
});

test('a volunteered clock time becomes a preference rather than a promised slot', () => {
  const manager = createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });
  const prepared = manager.prepare({ ...VALID_DRAFT, preferred_time: '6 PM' });
  assert.equal(prepared.summary.preferredDayAndTimeWindow, 'Tuesday, August 4, 2026, afternoon');
});

test('normalizes conversational names and maps natural service wording without a trade rule', () => {
  assert.equal(normalizeCallerName('Jordan Smith works well.'), 'Jordan Smith');
  assert.equal(
    matchService('I need the exterior of my house painted.', CONTEXT.services),
    'Exterior Painting',
  );
});

test('requires a full street address before preparing a service request', () => {
  assert.throws(
    () => normalizeProjectAddress('Berlin, Massachusetts'),
    /street number, street name, city or town, and state/i,
  );
  assert.throws(
    () => normalizeProjectAddress('Lancaster Road, Berlin, Massachusetts'),
    /street number/i,
  );
  assert.equal(
    normalizeProjectAddress('197 Lancaster Road, Berlin, Massachusetts'),
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(
    normalizeProjectAddress('123 Main Street, Albany, NY 12207'),
    '123 Main Street, Albany, NY 12207',
  );
});

test('removes conversation-repair chatter and consent from project notes', () => {
  assert.equal(
    sanitizeAdditionalNotes(
      'The shed has some rotten wood. Caller asked what I was talking about earlier; no other project notes were provided. They also said they consented to being contacted.',
    ),
    'The shed has some rotten wood.',
  );
  assert.equal(
    sanitizeAdditionalNotes("What's the question? I didn't even ask a question."),
    '',
  );
  assert.equal(
    sanitizeAdditionalNotes('Mm. How long will the job take?'),
    'How long will the job take?',
  );
});

test('requires explicit contact consent before preparing a summary', () => {
  const manager = createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });

  assert.throws(() => manager.prepare({
    ...VALID_DRAFT,
    consent_to_contact: false,
  }), /explicitly consenting/);
  assert.equal(manager.phase, 'collecting');
});

test('blocks preparation until notes and standalone consent gates are complete', () => {
  const createManager = () => createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });

  assert.throws(
    () => createManager().prepare({ ...VALID_DRAFT, additional_notes_asked: false }),
    /additional project notes/i,
  );
  assert.throws(
    () => createManager().prepare({ ...VALID_DRAFT, consent_asked_separately: false }),
    /separate question/i,
  );
});

test('rejects days outside availability while accepting broad time windows', () => {
  const createManager = () => createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });

  assert.throws(
    () => createManager().prepare({ ...VALID_DRAFT, preferred_date: 'Sunday' }),
    /outside the business's service-request days.*Monday.*Friday/i,
  );
  assert.doesNotThrow(
    () => createManager().prepare({ ...VALID_DRAFT, preferred_time: 'afternoon' }),
  );
});

test('configured clock hours do not turn a caller preference into an exact appointment', () => {
  const manager = createIntakeManager({
    context: {
      ...CONTEXT,
      earliestServiceRequestStart: '06:00',
      latestServiceRequestStart: '19:00',
    },
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });

  const prepared = manager.prepare({ ...VALID_DRAFT, preferred_time: '1:00 AM' });
  assert.equal(prepared.summary.preferredDayAndTimeWindow, 'Tuesday, August 4, 2026, morning');
});

test('prepares, confirms, and sends one normalized request to ARC', async () => {
  const deliveries = [];
  const manager = createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async (payload, options) => {
      deliveries.push({ payload, options });
      return { ok: true, serviceRequestId: 'service-request-456' };
    },
    now: () => NOW,
  });

  const prepared = manager.prepare({
    ...VALID_DRAFT,
    service: 'I need interior painting',
    additional_notes: 'The living room has vaulted ceilings.',
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.status, 'ready_for_confirmation');
  assert.deepEqual(Object.keys(prepared.summary), [
    'name',
    'service',
    'address',
    'preferredDayAndTimeWindow',
    'notes',
  ]);
  assert.equal(
    prepared.summary.preferredDayAndTimeWindow,
    'Tuesday, August 4, 2026, afternoon',
  );
  assert.equal(prepared.summary.notes, 'The living room has vaulted ceilings.');
  assert.equal('consentToContact' in prepared.summary, false);
  assert.equal(manager.phase, 'ready_for_confirmation');

  const blocked = await manager.submit({ caller_confirmed: false });
  assert.equal(blocked.ok, false);
  assert.equal(deliveries.length, 0);

  const submitted = await manager.submit({ caller_confirmed: true });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.status, 'submitted');
  assert.equal(manager.phase, 'submitted');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].payload.type, 'service_request');
  assert.equal(deliveries[0].payload.requestType, 'service_request');
  assert.equal(deliveries[0].payload.service, 'Interior Painting');
  assert.equal(deliveries[0].payload.requestedDate, '2026-08-04');
  assert.equal(deliveries[0].payload.requestedTimeWindow, 'Afternoon');
  assert.equal(deliveries[0].payload.requestedTime, 'Afternoon');
  assert.equal(
    deliveries[0].payload.requestSummary,
    [
      '- Service: Interior Painting',
      '- Preferred window: Tuesday, August 4, 2026 — Afternoon',
      '- Address: 123 Main Street, Albany, NY 12207',
      '- Notes: The living room has vaulted ceilings.',
    ].join('\n'),
  );
  assert.equal(deliveries[0].payload.consentToContact, true);
  assert.equal(deliveries[0].payload.summaryConfirmed, true);
  assert.equal(deliveries[0].payload.Name, 'Jordan Smith');
  assert.equal(deliveries[0].payload.Phone, '+15555550123');
  assert.equal(deliveries[0].payload.Address, '123 Main Street, Albany, NY 12207');
  assert.equal(deliveries[0].payload.Job, 'Interior Painting');
  assert.equal(deliveries[0].payload.PreferredDay, '2026-08-04');
  assert.equal(deliveries[0].payload.PreferredDate, '2026-08-04');
  assert.equal(deliveries[0].payload.PreferredTimeWindow, 'Afternoon');
  assert.equal(deliveries[0].payload.PreferredTime, 'Afternoon');
  assert.equal(deliveries[0].payload.Notes, 'The living room has vaulted ceilings.');
  assert.equal(deliveries[0].payload.RequestSummary, deliveries[0].payload.requestSummary);
  assert.match(deliveries[0].options.idempotencyKey, /^[a-f0-9]{64}$/);

  const repeated = await manager.submit({ caller_confirmed: true });
  assert.equal(repeated.status, 'already_submitted');
  assert.equal(deliveries.length, 1);
});

test('prepares and sends an explicit emergency request without inventing a scheduled date', async () => {
  const deliveries = [];
  const manager = createIntakeManager({
    context: EMERGENCY_CONTEXT,
    callControlId: 'call-emergency-123',
    callerPhone: '+15555550123',
    deliver: async (payload) => {
      deliveries.push(payload);
      return { ok: true };
    },
    now: () => NOW,
  });

  const prepared = manager.prepare({
    ...VALID_DRAFT,
    request_urgency: 'emergency',
    preferred_date: '',
    preferred_time: '',
    additional_notes: 'Water is entering the basement.',
  });
  assert.equal(prepared.summary.preferredDayAndTimeWindow, 'As soon as possible');

  await manager.submit({ caller_confirmed: true });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].requestUrgency, 'emergency');
  assert.equal(deliveries[0].RequestUrgency, 'emergency');
  assert.equal(deliveries[0].requestedDate, '');
  assert.equal(deliveries[0].PreferredDay, '');
  assert.equal(deliveries[0].requestedTimeWindow, 'As soon as possible');
  assert.equal(deliveries[0].PreferredTimeWindow, 'As soon as possible');
  assert.equal(
    deliveries[0].requestSummary,
    [
      '- Service: Interior Painting',
      '- Priority: Emergency / ASAP',
      '- Preferred window: As soon as possible',
      '- Address: 123 Main Street, Albany, NY 12207',
      '- Notes: Water is entering the basement.',
    ].join('\n'),
  );
});

test('an emergency-enabled business still sends scheduled requests without urgency fields', async () => {
  const deliveries = [];
  const manager = createIntakeManager({
    context: EMERGENCY_CONTEXT,
    callControlId: 'call-scheduled-123',
    callerPhone: '+15555550123',
    deliver: async (payload) => {
      deliveries.push(payload);
      return { ok: true };
    },
    now: () => NOW,
  });

  manager.prepare(VALID_DRAFT);
  await manager.submit({ caller_confirmed: true });

  assert.equal('requestUrgency' in deliveries[0], false);
  assert.equal('RequestUrgency' in deliveries[0], false);
  assert.equal(deliveries[0].requestedDate, '2026-08-04');
  assert.equal(deliveries[0].requestedTimeWindow, 'Afternoon');
});

test('rejects an emergency marker when ARC did not enable emergency routing', () => {
  const manager = createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-disabled-emergency',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });

  assert.throws(
    () => manager.prepare({ ...VALID_DRAFT, request_urgency: 'emergency' }),
    /emergency service is not enabled/i,
  );
});
