import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantProfile, getCalledPhone, getTelnyxConnectionId, normalizePhone } from '../tenant-profile.js';

const profileInput = {
  clientId: 'example-client',
  connectionKey: 'private-key',
  ocmWebhookUrl: 'https://example.com/api/intake?clientId=example-client&key=private-key',
  ocmUsageUrl: 'https://example.com/api/receptionist/call-usage?clientId=example-client&key=private-key',
  receptionistScript: 'Collect the caller details and confirm them before saving.',
  ai: { model: 'gpt-realtime', voice: 'alloy', speechSpeed: 1, silenceMs: 900 },
  business: {
    name: 'Example Business',
    receptionist: 'Alex',
    owner: 'Jamie Example',
    phone: '+15555550100',
    email: 'hello@example.com',
    hours: 'Monday through Friday, 8 AM to 5 PM',
    timeZone: 'America/New_York',
    estimateDays: 'Monday through Friday',
    estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    earliestEstimateStart: '9:00 AM',
    latestEstimateStart: '4:30 PM',
    base: 'Example City',
    serviceAreas: ['Example County'],
    services: { painting: 'Interior and exterior painting.' },
    openingLine: 'Hi, this is {{receptionist_name}} with {{business_name}}.',
    closingLine: 'Thanks for calling {{business_name}}. Goodbye.',
  },
};

test('normalizes North American destination numbers', () => {
  assert.equal(normalizePhone('(978) 555-0100'), '+19785550100');
  assert.equal(getCalledPhone({ data: { payload: { to: '+19785550100' } } }), '+19785550100');
  assert.equal(getTelnyxConnectionId({ data: { payload: { connection_id: '12345' } } }), '12345');
});

test('builds one isolated tenant profile', () => {
  const profile = createTenantProfile(profileInput);
  assert.equal(profile.clientId, 'example-client');
  assert.equal(profile.business.name, 'Example Business');
  assert.equal(profile.openingLine, 'Hi, this is Alex with Example Business.');
  assert.equal(profile.tools[0].parameters.properties.serviceType.enum[0], 'painting');
});

test('a saved lead is routed to the tenant client ID', () => {
  const profile = createTenantProfile(profileInput);
  const validation = profile.validateLead({
    fullName: 'Taylor Customer',
    email: '',
    serviceType: 'painting',
    townOrCity: 'Example City',
    streetAddress: '10 Main Street',
    contactMethod: 'call',
    preferredDay: 'monday',
    preferredTime: '10:00 AM',
    additionalNotes: '',
  });
  assert.equal(validation.valid, true);
  const payload = profile.buildOcmPayload('+19785550101', validation.lead);
  assert.equal(payload.clientId, 'example-client');
  assert.equal(payload.Phone, '+19785550101');
  assert.equal(payload.source, 'example-client-receptionist');
});
