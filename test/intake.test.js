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
  services: [
    { name: 'Interior Painting', description: 'Walls and ceilings' },
    { name: 'Exterior Painting', description: 'Siding and trim' },
  ],
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

test('requires explicit contact consent before preparing a summary', () => {
  const manager = createIntakeManager({
    context: CONTEXT,
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    now: () => NOW,
  });

  assert.throws(() => manager.prepare({
    service: 'interior painting',
    name: 'Jordan Smith',
    address: '123 Main Street, Albany, NY 12207',
    preferred_date: 'Tuesday',
    preferred_time: '3:30 PM',
    additional_notes: '',
    consent_to_contact: false,
  }), /explicitly consenting/);
  assert.equal(manager.phase, 'collecting');
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
    service: 'I need interior painting',
    name: 'Jordan Smith',
    address: '123 Main Street, Albany, NY 12207',
    preferred_date: 'Tuesday',
    preferred_time: '3:30 PM',
    additional_notes: 'The living room has vaulted ceilings.',
    consent_to_contact: true,
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.status, 'ready_for_confirmation');
  assert.equal(prepared.summary.requestedDate, '2026-08-04');
  assert.equal(prepared.summary.requestedDateSpoken, 'Tuesday, August 4, 2026');
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
