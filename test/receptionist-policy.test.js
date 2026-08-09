import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_FIELD_ORDER,
  callerVolunteeredName,
  classifyCallerTranscript,
  hasUsableNameAnswer,
  hasUsableServiceAnswer,
} from '../receptionist-policy.js';

const HVAC_CONTEXT = Object.freeze({
  services: [
    { name: 'Air Conditioning Repair', description: 'Cooling system diagnostics and repair' },
    { name: 'Heating Repair', description: 'Furnace and heating system repair' },
  ],
});

test('uses one canonical field order for every business', () => {
  assert.deepEqual(INTAKE_FIELD_ORDER, [
    'service',
    'name',
    'address',
    'schedule',
    'notes',
    'consent',
  ]);
});

test('accepts substantive service descriptions without hardcoding one trade', () => {
  const descriptions = [
    'My kitchen sink is leaking under the cabinet.',
    'I need the roof replaced.',
    'The air conditioner stopped cooling.',
    'Two outlets are not working.',
    'The driveway has several cracks.',
    'I need a tree trimmed away from the house.',
    'A couple of rooms need work.',
  ];
  for (const description of descriptions) {
    assert.equal(hasUsableServiceAnswer(description), true, description);
  }
});

test('reactions and non-answers cannot complete the service field', () => {
  for (const value of ['Oh.', 'Okay.', 'Yes.', "I don't know.", 'Not sure.', 'My name is Andrew.']) {
    assert.equal(hasUsableServiceAnswer(value), false, value);
  }
  assert.equal(classifyCallerTranscript('Oh.'), 'filler');
});

test('recognizes natural names while rejecting project descriptions as names', () => {
  for (const value of [
    'Andrew Christensen.',
    'María de la Cruz.',
    "My name is D'Andre Williams.",
    'You can use Anne-Marie Smith.',
  ]) {
    assert.equal(hasUsableNameAnswer(value, HVAC_CONTEXT), true, value);
  }

  for (const value of [
    'The air conditioner stopped cooling.',
    'Air Conditioning Repair.',
    'I need the roof replaced.',
    'Mowing lawns.',
    'Replacing a broken gate.',
    '197 Lancaster Road.',
    'Wednesday at 3 PM.',
    'Okay.',
  ]) {
    assert.equal(hasUsableNameAnswer(value, HVAC_CONTEXT), false, value);
  }
});

test('recognizes introduced names without treating action phrases as names', () => {
  for (const value of [
    "I'm Andrew Christensen.",
    'I am María de la Cruz.',
    "I'm Andrew, and I need a window fixed.",
  ]) {
    assert.equal(callerVolunteeredName(value), true, value);
  }

  for (const value of [
    "I'm mowing the lawn.",
    'I am replacing a gate.',
    'I am looking for an estimate.',
    'I am not sure.',
  ]) {
    assert.equal(callerVolunteeredName(value), false, value);
  }
});
