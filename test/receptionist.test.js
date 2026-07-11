import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appointmentWindow,
  buildOcmPayload,
  getCallerPhone,
  hasFirstAndLastName,
  promptForOpening,
  realtimeInstructions,
  validateAppointmentTime,
  validateEstimateLead
} from '../receptionist.js';

const BUSINESS_HOURS = 'Monday through Friday, 9 AM to 5 PM';

function completeLead(overrides = {}) {
  return {
    fullName: 'Taylor Morgan',
    email: 'taylor@example.com',
    contactMethod: 'text',
    serviceType: 'interior painting',
    projectDetails: 'I need interior painting for about five walls',
    townOrCity: 'Berlin',
    streetAddress: '12 Main Street',
    preferredDay: 'Tuesday',
    preferredTime: '4:30 PM',
    additionalNotes: '',
    ...overrides
  };
}

test('uses the requested short opening and asks nothing else', () => {
  assert.equal(
    promptForOpening('Tabor Painting'),
    'Hey, this is Alex, the receptionist for Tabor Painting. Would you like to set up an appointment for an estimate?'
  );
});

test('requires both first and last name', () => {
  assert.equal(hasFirstAndLastName('Taylor'), false);
  assert.equal(hasFirstAndLastName('Taylor Morgan'), true);
});

test('sets the latest appointment 30 minutes before closing', () => {
  const window = appointmentWindow(BUSINESS_HOURS, 30);
  assert.equal(window.openingLabel, '9:00 AM');
  assert.equal(window.closingLabel, '5:00 PM');
  assert.equal(window.latestStartLabel, '4:30 PM');
  assert.equal(validateAppointmentTime('4:30 PM', BUSINESS_HOURS, 30).valid, true);
  assert.equal(validateAppointmentTime('5:00 PM', BUSINESS_HOURS, 30).valid, false);
});

test('rejects incomplete leads and end-of-day appointment times', () => {
  const result = validateEstimateLead(
    completeLead({ fullName: 'Taylor', preferredTime: '5:00 PM' }),
    BUSINESS_HOURS,
    30
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /first and last name/i);
  assert.match(result.errors.join(' '), /latest estimate start is 4:30 PM/i);
});

test('keeps service category clean and moves project details into notes', () => {
  const payload = buildOcmPayload(
    { callerPhone: '+17745550123' },
    completeLead({ additionalNotes: 'Please call before arriving' })
  );

  assert.equal(payload.Phone, '+17745550123');
  assert.equal(payload.Job, 'interior painting');
  assert.equal(payload.Address, '12 Main Street, Berlin');
  assert.match(payload.Notes, /Project details: I need interior painting for about five walls/);
  assert.match(payload.Notes, /Additional notes: Please call before arriving/);
});

test('pulls the caller phone number from a Telnyx webhook', () => {
  assert.equal(
    getCallerPhone({ data: { payload: { from: '+17745550123' } } }),
    '+17745550123'
  );
});

test('prompt enforces ordered questions and waits before ending', () => {
  const prompt = realtimeInstructions({
    businessName: 'Tabor Painting',
    businessHours: BUSINESS_HOURS,
    schedulingBufferMinutes: 30
  });

  assert.match(prompt, /Ask exactly one question per turn/);
  assert.match(prompt, /Town or city.*Street address/s);
  assert.match(prompt, /latest estimate start is 4:30 PM/i);
  assert.match(prompt, /Never end the call immediately after asking whether they have questions/);
});
