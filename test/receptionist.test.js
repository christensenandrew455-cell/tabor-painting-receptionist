import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSINESS,
  buildOcmPayload,
  getCallerPhone,
  instructions,
  normalizePreferredTime,
  openingLine,
  validateLead
} from '../receptionist-core.js';

function completeLead(overrides = {}) {
  return {
    fullName: 'Taylor Morgan',
    email: 'taylor@example.com',
    serviceType: 'interior painting',
    townOrCity: 'Berlin',
    streetAddress: '12 Main Street',
    contactMethod: 'text',
    preferredDay: 'Tuesday',
    preferredTime: '4:30 PM',
    additionalNotes: 'Please call before arriving',
    ...overrides
  };
}

test('uses the configured business in the opening', () => {
  assert.equal(BUSINESS.name, 'Tabor Painting');
  assert.match(openingLine, /Tabor Painting/);
  assert.match(openingLine, /Alex/);
});

test('accepts times inside the configured estimate window', () => {
  assert.equal(normalizePreferredTime('9 am'), '9:00 AM');
  assert.equal(normalizePreferredTime('4:30 PM'), '4:30 PM');
  assert.equal(normalizePreferredTime('5:00 PM'), '');
});

test('rejects incomplete leads', () => {
  const result = validateLead(completeLead({
    fullName: 'Taylor',
    preferredTime: '5:00 PM'
  }));

  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /first and last name/i);
  assert.match(result.errors.join(' '), /between 9:00 AM and 4:30 PM/i);
});

test('builds the OCM payload from configured client variables', () => {
  const previousClientId = process.env.OCM_CLIENT_ID;
  const previousSource = process.env.OCM_SOURCE;
  process.env.OCM_CLIENT_ID = 'sample-business';
  process.env.OCM_SOURCE = 'sample-receptionist';

  try {
    const result = validateLead(completeLead());
    assert.equal(result.valid, true);

    const payload = buildOcmPayload('+17745550123', result.lead);
    assert.equal(payload.clientId, 'sample-business');
    assert.equal(payload.source, 'sample-receptionist');
    assert.equal(payload.sectionKey, 'contactedMe');
    assert.equal(payload.Phone, '+17745550123');
    assert.equal(payload.Job, 'interior painting');
    assert.equal(payload.Address, '12 Main Street, Berlin');
    assert.match(payload.Notes, /Please call before arriving/);
  } finally {
    if (previousClientId === undefined) delete process.env.OCM_CLIENT_ID;
    else process.env.OCM_CLIENT_ID = previousClientId;
    if (previousSource === undefined) delete process.env.OCM_SOURCE;
    else process.env.OCM_SOURCE = previousSource;
  }
});

test('pulls the caller phone number from a Telnyx webhook', () => {
  assert.equal(
    getCallerPhone({ data: { payload: { from: '+17745550123' } } }),
    '+17745550123'
  );
});

test('instructions include configured business knowledge and the save workflow', () => {
  const prompt = instructions();
  assert.match(prompt, /BUSINESS INFORMATION/);
  assert.match(prompt, /Tabor Painting/);
  assert.match(prompt, /Only after the caller clearly confirms/);
  assert.match(prompt, /submit_estimate_lead/);
});
