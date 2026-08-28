import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessContext } from '../business-context.js';
import {
  DEFAULT_DEMO_PHONE_NUMBER,
  isDemoPhoneNumber,
  isDemoRuntime,
  loadRuntimeForCalledPhone,
  runtimeForCalledPhone,
} from '../demo-runtime.js';
import { createIntakeManager, matchService } from '../intake.js';

test('recognizes the dedicated ARC demo number in common Telnyx formats', () => {
  assert.equal(DEFAULT_DEMO_PHONE_NUMBER, '+17742316164');
  assert.equal(isDemoPhoneNumber('+1 (774) 231-6164'), true);
  assert.equal(isDemoPhoneNumber('tel:7742316164'), true);
  assert.equal(isDemoPhoneNumber('+15555550123'), false);
});

test('keeps the neutral demo completely separate from dynamic account fill-ins', () => {
  const dynamicRuntime = {
    clientId: 'dynamic-account',
    intakeUrl: 'https://private.example.test/intake',
    usageUrl: 'https://private.example.test/usage',
    usageKey: 'private-key',
    profile: {
      businessName: 'Unrelated Dynamic Business',
      earliestServiceRequestStart: '1:00 PM',
      latestServiceRequestStart: '2:00 PM',
      services: ['Unrelated Service'],
    },
  };

  const demo = runtimeForCalledPhone(dynamicRuntime, '+17742316164');
  assert.equal(demo.demo, true);
  assert.equal(demo.profile.businessName, 'AI Receptionist Demo');
  assert.equal(demo.profile.earliestServiceRequestStart, '9:00 AM');
  assert.equal(demo.profile.latestServiceRequestStart, '5:00 PM');
  assert.deepEqual(demo.profile.serviceRequestWeekdays, [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ]);
  assert.deepEqual(demo.profile.serviceAreas, []);
  assert.deepEqual(demo.profile.services, {});
  assert.deepEqual(demo.profile.businessInformation, []);
  assert.equal(demo.intakeUrl, undefined);
  assert.equal(demo.usageUrl, undefined);
  assert.equal(demo.usageKey, undefined);

  const account = runtimeForCalledPhone(dynamicRuntime, '+15555550123');
  assert.equal(account, dynamicRuntime);
  assert.equal(account.profile.businessName, 'Unrelated Dynamic Business');
});

test('loads the demo locally without requesting an ARC account', async () => {
  let accountLoads = 0;
  const demo = await loadRuntimeForCalledPhone('+17742316164', {
    loadAccountRuntime: async () => {
      accountLoads += 1;
      throw new Error('No ARC account is connected to that phone number.');
    },
  });

  assert.equal(accountLoads, 0);
  assert.equal(isDemoRuntime(demo), true);
  assert.equal(demo.calledPhone, '+17742316164');
  assert.equal(demo.profile.businessName, 'AI Receptionist Demo');
});

test('demo accepts any service only inside its Monday-through-Friday 9-to-5 window', () => {
  const runtime = runtimeForCalledPhone({}, '+17742316164');
  const context = createBusinessContext(runtime);
  assert.equal(context.businessName, 'AI Receptionist Demo');
  assert.deepEqual(context.services, []);
  assert.deepEqual(context.serviceRequestWeekdays, [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ]);
  assert.equal(context.earliestServiceRequestStart, '9:00 AM');
  assert.equal(context.latestServiceRequestStart, '5:00 PM');
  assert.equal(matchService('AC repair', context.services), 'AC repair');

  const manager = createIntakeManager({
    context,
    callControlId: 'demo-call',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true, demo: true }),
    now: () => new Date('2026-08-03T16:00:00.000Z'),
  });
  const request = {
    service: 'AC repair',
    name: 'Jordan Smith',
    address: '123 Main Street, Albany, New York',
    additional_notes: 'The AC will not run.',
    additional_notes_asked: true,
    consent_to_contact: true,
    consent_asked_separately: true,
  };

  assert.throws(
    () => manager.prepare({
      ...request,
      preferred_date: 'Sunday',
      preferred_time: '2:00 PM',
    }),
    /outside the business's service-request days/i,
  );
  assert.throws(
    () => manager.prepare({
      ...request,
      preferred_date: 'Tuesday',
      preferred_time: '5:01 PM',
    }),
    /outside the business's service-request hours/i,
  );

  const prepared = manager.prepare({
    ...request,
    preferred_date: 'Tuesday',
    preferred_time: '5:00 PM',
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.summary.service, 'AC repair');
  assert.equal(prepared.summary.preferredDateAndTime, 'Tuesday, August 4, 2026 at 5:00 PM');
});

test('loads every non-demo number through the unchanged ARC account path', async () => {
  const accountRuntime = {
    clientId: 'regular-account',
    profile: { businessName: 'Regular Business' },
  };
  let accountLoads = 0;
  const loaded = await loadRuntimeForCalledPhone('+15555550123', {
    loadAccountRuntime: async () => {
      accountLoads += 1;
      return accountRuntime;
    },
  });

  assert.equal(accountLoads, 1);
  assert.equal(loaded, accountRuntime);
  assert.equal(isDemoRuntime(loaded), false);
});
