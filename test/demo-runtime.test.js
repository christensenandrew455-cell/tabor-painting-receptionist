import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEMO_PHONE_NUMBER,
  isDemoPhoneNumber,
  runtimeForCalledPhone,
} from '../demo-runtime.js';

test('recognizes the dedicated ARC demo number in common Telnyx formats', () => {
  assert.equal(DEFAULT_DEMO_PHONE_NUMBER, '+17742316164');
  assert.equal(isDemoPhoneNumber('+1 (774) 231-6164'), true);
  assert.equal(isDemoPhoneNumber('tel:7742316164'), true);
  assert.equal(isDemoPhoneNumber('+15555550123'), false);
});

test('keeps demo business information separate from dynamic account fill-ins', () => {
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
  assert.equal(demo.profile.businessName, 'Tabor Painting');
  assert.equal(demo.profile.earliestServiceRequestStart, '9:00 AM');
  assert.equal(demo.profile.latestServiceRequestStart, '4:30 PM');
  assert.deepEqual(Object.keys(demo.profile.services), [
    'Interior Painting',
    'Exterior Painting',
    'Wood Staining',
  ]);
  assert.equal(demo.intakeUrl, dynamicRuntime.intakeUrl);
  assert.equal(demo.usageUrl, dynamicRuntime.usageUrl);
  assert.equal(demo.usageKey, dynamicRuntime.usageKey);

  const account = runtimeForCalledPhone(dynamicRuntime, '+15555550123');
  assert.equal(account, dynamicRuntime);
  assert.equal(account.profile.businessName, 'Unrelated Dynamic Business');
});
