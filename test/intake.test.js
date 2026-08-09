import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIntakeManager,
  normalizeRequestedTime,
  resolveRequestedDate,
} from '../intake.js';

const NOW = new Date('2026-08-03T16:00:00.000Z');
const CONTEXT = Object.freeze({
  clientId: 'client-123',
  timeZone: 'America/New_York',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '09:00',
  latestEstimateStart: '16:00',
  services: [
    { name: 'Interior Painting', description: 'Walls and ceilings' },
    { name: 'Exterior Painting', description: 'Siding and trim' },
  ],
});

const VALID_DRAFT = Object.freeze({
  service: 'interior painting',
  name: 'Jordan Smith',
  address: '123 Main Street, Albany, NY 12207',
  preferred_date: 'Tuesday',
  preferred_time: '3:30 PM',
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

test('requires AM or PM for an ambiguous time', () => {
  assert.throws(() => normalizeRequestedTime('3:30'), /AM or PM/);
  assert.equal(normalizeRequestedTime('3:30 pm'), '3:30 PM');
});

test('infers a bare hour when only one meridiem fits the estimate window', () => {
  assert.equal(normalizeRequestedTime('1', CONTEXT), '1:00 PM');
  assert.equal(normalizeRequestedTime('9', CONTEXT), '9:00 AM');
  assert.throws(
    () => normalizeRequestedTime('3', {
      earliestEstimateStart: '00:00',
      latestEstimateStart: '23:59',
    }),
    /AM or PM/,
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

test('rejects estimate dates and times outside the business availability', () => {
  const createManager = () => createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });

  assert.throws(
    () => createManager().prepare({ ...VALID_DRAFT, preferred_date: 'Sunday' }),
    /outside the business's estimate days.*Monday.*Friday/i,
  );
  assert.throws(
    () => createManager().prepare({ ...VALID_DRAFT, preferred_time: '5:00 PM' }),
    /outside the business's estimate hours.*9:00 AM through 4:00 PM/i,
  );
  assert.doesNotThrow(
    () => createManager().prepare({ ...VALID_DRAFT, preferred_time: '4:00 PM' }),
  );
});

test('prepares, confirms, and sends one normalized request to ARC', async () => {
  const deliveries = [];
  const manager = createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async (payload, options) => {
      deliveries.push({ payload, options });
      return { ok: true, estimateId: 'estimate-456' };
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
    'preferredDateAndTime',
    'notes',
  ]);
  assert.equal(
    prepared.summary.preferredDateAndTime,
    'Tuesday, August 4, 2026 at 3:30 PM',
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
  assert.equal(deliveries[0].payload.type, 'estimate_request');
  assert.equal(deliveries[0].payload.service, 'Interior Painting');
  assert.equal(deliveries[0].payload.requestedDate, '2026-08-04');
  assert.equal(deliveries[0].payload.requestedTime, '3:30 PM');
  assert.equal(deliveries[0].payload.consentToContact, true);
  assert.equal(deliveries[0].payload.summaryConfirmed, true);
  assert.equal(deliveries[0].payload.Name, 'Jordan Smith');
  assert.equal(deliveries[0].payload.Phone, '+15555550123');
  assert.equal(deliveries[0].payload.Address, '123 Main Street, Albany, NY 12207');
  assert.equal(deliveries[0].payload.Job, 'Interior Painting');
  assert.equal(deliveries[0].payload.PreferredDate, '2026-08-04');
  assert.equal(deliveries[0].payload.PreferredTime, '3:30 PM');
  assert.equal(deliveries[0].payload.Notes, 'The living room has vaulted ceilings.');
  assert.match(deliveries[0].options.idempotencyKey, /^[a-f0-9]{64}$/);

  const repeated = await manager.submit({ caller_confirmed: true });
  assert.equal(repeated.status, 'already_submitted');
  assert.equal(deliveries.length, 1);
});
