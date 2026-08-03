import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUSINESS,
  REALTIME_VOICE,
  SILENCE_DURATION_MS,
  SPEECH_SPEED,
  buildOcmPayload,
  normalizePreferredTime,
  resolvePreferredDate,
  validateLead,
} from '../receptionist-core.js';
import {
  businessInfoFromAppProfile,
  runtimeEnvironmentFromApp,
} from '../app-info-config.js';

function completeLead(overrides = {}) {
  return {
    fullName: 'Taylor Morgan',
    serviceType: 'interior painting',
    cityOrTown: 'Example City',
    state: 'Massachusetts',
    streetNumber: '12',
    streetName: 'Main Street',
    preferredDateOrDay: 'Monday',
    preferredTime: '4:30 PM',
    additionalNotes: 'Please call before arriving',
    contactConsent: true,
    ...overrides,
  };
}

test('runtime core exposes only configured business and voice settings', () => {
  assert.equal(BUSINESS.name, 'Example Painting');
  assert.equal(BUSINESS.receptionist, 'Alex');
  assert.deepEqual(Object.keys(BUSINESS.services), ['interior painting', 'exterior painting']);
  assert.equal(REALTIME_VOICE, 'alloy');
  assert.equal(SPEECH_SPEED, 0.94);
  assert.equal(SILENCE_DURATION_MS, 1200);
});

test('profile mapping contains business facts without script or model ownership', () => {
  const profile = {
    businessName: 'Tabor Painting',
    receptionistName: 'Alex',
    ownerName: 'Andrew Christensen',
    businessPhone: '+15551234567',
    businessEmail: 'office@example.com',
    businessHours: 'Monday through Friday, 9 AM to 5 PM',
    timeZone: 'America/New_York',
    estimateDays: 'Monday through Friday',
    estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    earliestEstimateStart: '9:00 AM',
    latestEstimateStart: '4:30 PM',
    businessBase: 'Berlin, Massachusetts',
    serviceAreas: ['Berlin'],
    services: { 'interior painting': 'Interior painting.' },
    about: ['Residential painting.'],
    aiVoice: 'alloy',
    aiSpeechSpeed: 0.94,
    aiSilenceMs: 1050,
  };

  const business = businessInfoFromAppProfile(profile);
  const environment = runtimeEnvironmentFromApp({ profile, clientId: 'tabor-painting' });
  assert.equal(business.name, 'Tabor Painting');
  assert.equal('openingLine' in business, false);
  assert.equal('closingLine' in business, false);
  assert.equal('AI_MODEL' in environment, false);
  assert.equal(environment.OCM_CLIENT_ID, 'tabor-painting');
});

test('normalizes only times inside the configured estimate window', () => {
  assert.equal(normalizePreferredTime('9 am'), '9:00 AM');
  assert.equal(normalizePreferredTime('4:30 PM'), '4:30 PM');
  assert.equal(normalizePreferredTime('5:00 PM'), '');
});

test('resolves configured weekdays and explicit dates', () => {
  const friday = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(resolvePreferredDate('Monday', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('2026-07-20', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('07/20/2026', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('2026-07-19', friday), '');
});

test('validates the complete lead and rejects missing required fields', () => {
  const now = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(validateLead(completeLead(), now).valid, true);
  assert.equal(validateLead(completeLead({ state: '' }), now).valid, false);
  assert.equal(validateLead(completeLead({ streetNumber: '' }), now).valid, false);
  assert.equal(validateLead(completeLead({ contactConsent: false }), now).valid, false);
});

test('builds one compact OCM payload from a validated lead', () => {
  const now = new Date('2026-07-17T16:00:00.000Z');
  const validation = validateLead(completeLead(), now);
  const payload = buildOcmPayload('+15551234567', validation.lead);
  assert.equal(payload.FirstName, 'Taylor');
  assert.equal(payload.LastName, 'Morgan');
  assert.equal(payload.Phone, '+15551234567');
  assert.equal(payload.Address, '12 Main Street, Example City, Massachusetts');
  assert.equal(payload.EstimateDate, '2026-07-20');
  assert.equal(payload.Notes, 'Please call before arriving');
});
