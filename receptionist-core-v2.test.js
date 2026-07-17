import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOcmPayload, instructions, resolvePreferredDate } from './receptionist-core-v2.js';

test('resolves the next requested weekday in the business timezone', () => {
  const friday = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(resolvePreferredDate('Monday', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('Friday', friday), '2026-07-17');
});

test('adds an actual estimate date to the OCM payload', () => {
  const payload = buildOcmPayload('+15085551234', {
    fullName: 'Test Caller',
    email: 'test@example.com',
    serviceType: 'interior painting',
    townOrCity: 'Berlin',
    streetAddress: '1 Main Street',
    contactMethod: 'text',
    preferredDay: 'Monday',
    preferredTime: '1:30 PM',
    additionalNotes: '',
  });

  assert.match(payload.EstimateDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.PreferredDay, payload.EstimateDate);
  assert.equal(payload.RequestedWeekday, 'Monday');
});

test('instructions include the save phrase and silent hold behavior', () => {
  const prompt = instructions();
  assert.match(prompt, /give me one second to save that/i);
  assert.match(prompt, /remain completely silent/i);
  assert.match(prompt, /calm, measured pace/i);
});
