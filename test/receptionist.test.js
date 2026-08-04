import assert from 'node:assert/strict';
import test from 'node:test';

import { createReceptionistCore } from '../receptionist-core.js';
import {
  isValidFullName,
  parseProjectAddress,
  resolveEstimateDate,
  validateClientId,
} from '../intake-schema.js';
import {
  businessInfoFromAppProfile,
  runtimeEnvironmentFromApp,
} from '../app-info-config.js';

const profile = Object.freeze({
  businessName: 'Example Painting',
  receptionistName: 'Alex',
  ownerName: 'Example Owner',
  businessPhone: '(555) 555-0100',
  businessEmail: 'hello@example.com',
  businessHours: 'Monday through Friday, 8 AM to 5 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:30 PM',
  businessBase: 'Example City',
  serviceAreas: ['Massachusetts'],
  services: {
    'interior painting': 'Interior painting services.',
    'exterior painting': 'Exterior painting services.',
  },
  about: ['Example Painting provides residential painting services.'],
  extraInformation: 'Project details are confirmed during the estimate.',
  aiVoice: 'alloy',
  aiSpeechSpeed: 0.94,
  aiSilenceMs: 1200,
});

const core = createReceptionistCore({ profile, clientId: 'Client:Example_01' });

function completeLead(overrides = {}) {
  return {
    fullName: 'Taylor Morgan',
    serviceType: 'interior painting',
    projectLocation: '12 Main Street, Apt 4, Example City, Massachusetts 01503',
    preferredDateOrDay: '2026-07-20',
    preferredTime: '4:30 PM',
    additionalNotes: 'Please call before arriving',
    contactConsent: true,
    ...overrides,
  };
}

test('creates an isolated core directly from one tenant profile', () => {
  assert.equal(core.BUSINESS.name, 'Example Painting');
  assert.equal(core.REALTIME_VOICE, 'alloy');
  assert.equal(core.SPEECH_SPEED, 0.94);
  assert.equal(core.SILENCE_DURATION_MS, 1200);
  assert.equal(core.CLIENT_ID, 'Client:Example_01');
});

test('client IDs are validated but never rewritten', () => {
  assert.equal(validateClientId('Client:Example_01'), 'Client:Example_01');
  assert.throws(() => validateClientId('client id with spaces'), /invalid format/);
});

test('profile mapping contains business facts without script or model ownership', () => {
  const business = businessInfoFromAppProfile(profile);
  const environment = runtimeEnvironmentFromApp({ profile, clientId: 'Client:Example_01' });
  assert.equal(business.name, 'Example Painting');
  assert.equal('openingLine' in business, false);
  assert.equal('closingLine' in business, false);
  assert.equal('AI_MODEL' in environment, false);
  assert.equal(environment.OCM_CLIENT_ID, 'Client:Example_01');
});

test('normalizes only times inside the configured estimate window', () => {
  assert.equal(core.normalizePreferredTime('9 am'), '9:00 AM');
  assert.equal(core.normalizePreferredTime('four thirty'), '');
  assert.equal(core.normalizePreferredTime('4:30 PM'), '4:30 PM');
  assert.equal(core.normalizePreferredTime('5:00 PM'), '');
});

test('resolves dates once using the tenant timezone and configured weekdays', () => {
  const friday = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(core.resolvePreferredDate('Monday', friday), '2026-07-20');
  assert.equal(core.resolvePreferredDate('2026-07-20', friday), '2026-07-20');
  assert.equal(core.resolvePreferredDate('07/20/2026', friday), '2026-07-20');
  assert.equal(core.resolvePreferredDate('2026-07-19', friday), '');
  assert.equal(core.resolvePreferredDate('today', friday), '');
  assert.equal(core.resolvePreferredDate('February 31 2027', friday), '');
});

test('the shared resolver handles next weekday semantics without rolling bad dates', () => {
  const saturday = new Date('2026-08-01T16:00:00.000Z');
  assert.equal(resolveEstimateDate('Monday', {
    now: saturday,
    timeZone: 'America/New_York',
    allowedWeekdays: profile.estimateWeekdays,
  }), '2026-08-03');
  assert.equal(resolveEstimateDate('next Monday', {
    now: saturday,
    timeZone: 'America/New_York',
    allowedWeekdays: profile.estimateWeekdays,
  }), '2026-08-10');
});

test('accepts Unicode names and rejects incomplete names', () => {
  assert.equal(isValidFullName('José O’Neill'), true);
  assert.equal(isValidFullName('Prince'), false);
});

test('parses unit and ZIP without shifting the city or state', () => {
  const address = parseProjectAddress('12 Main Street, Apt 4, Example City, Massachusetts 01503');
  assert.equal(address.valid, true);
  assert.equal(address.unit, 'Apt 4');
  assert.equal(address.cityOrTown, 'Example City');
  assert.equal(address.state, 'MA');
  assert.equal(address.postalCode, '01503');
  assert.equal(address.formatted, '12 Main Street, Apt 4, Example City, MA 01503');
});

test('validates a complete lead and rejects missing consent, phone, and unknown services', () => {
  const now = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(core.validateLead(completeLead(), { now, callerPhone: '+15555550100' }).valid, true);
  assert.equal(core.validateLead(completeLead({ contactConsent: false }), {
    now,
    callerPhone: '+15555550100',
  }).valid, false);
  assert.equal(core.validateLead(completeLead(), { now, callerPhone: '' }).valid, false);
  assert.equal(core.validateLead(completeLead({ serviceType: 'roofing' }), {
    now,
    callerPhone: '+15555550100',
  }).valid, false);
});

test('builds an exact-client OCM payload from the canonical lead', () => {
  const now = new Date('2026-07-17T16:00:00.000Z');
  const validation = core.validateLead(completeLead(), { now, callerPhone: '+15555550100' });
  const payload = core.buildOcmPayload('+15555550100', validation.lead);
  assert.equal(payload.clientId, 'Client:Example_01');
  assert.equal(payload.FirstName, 'Taylor');
  assert.equal(payload.LastName, 'Morgan');
  assert.equal(payload.Phone, '+15555550100');
  assert.equal(payload.Address, '12 Main Street, Apt 4, Example City, MA 01503');
  assert.equal(payload.EstimateDate, '2026-07-20');
});
