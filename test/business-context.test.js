import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBusinessContext,
  normalizeBusinessInformation,
  normalizeServices,
} from '../business-context.js';

test('normalizes website services from an object map', () => {
  assert.deepEqual(normalizeServices({
    'Interior Painting': 'Walls and trim',
    'Exterior Painting': { description: 'Siding and decks' },
  }), [
    { name: 'Interior Painting', description: 'Walls and trim' },
    { name: 'Exterior Painting', description: 'Siding and decks' },
  ]);
});

test('normalizes owner-supplied Title and Info items without inventing values', () => {
  assert.deepEqual(normalizeBusinessInformation([
    { title: ' Warranty ', info: ' One year on labor. ' },
    { title: 'Warranty', info: 'One year on labor.' },
    { title: '', info: 'Missing title' },
    { title: 'Missing info', info: '' },
  ]), [
    { title: 'Warranty', info: 'One year on labor.' },
  ]);
});

test('builds business context while removing connection secrets', () => {
  const context = createBusinessContext({
    clientId: 'client-123',
    intakeUrl: 'https://private.example.test/intake',
    intakeToken: 'never-show-this-token',
    profile: {
      businessName: 'Tabor Painting',
      receptionistName: 'Taylor',
      aiVoice: 'alloy',
      timeZone: 'America/Chicago',
      serviceRequestWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      earliestServiceRequestStart: '09:00',
      latestServiceRequestStart: '16:00',
      businessCounty: 'Worcester County',
      serviceAreas: ['Worcester County', 'Middlesex County'],
      services: [{ name: 'Cabinet Painting', description: 'Kitchen cabinets' }],
      businessInformation: [
        { title: 'Warranty', info: 'One year on labor.' },
      ],
      apiKey: 'also-private',
      faq: [{ question: 'Do you paint cabinets?', answer: 'Yes.' }],
    },
  });

  assert.equal(context.businessName, 'Tabor Painting');
  assert.equal(context.timeZone, 'America/Chicago');
  assert.deepEqual(context.serviceRequestWeekdays, [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ]);
  assert.equal(context.earliestServiceRequestStart, '09:00');
  assert.equal(context.latestServiceRequestStart, '16:00');
  assert.equal(context.businessCounty, 'Worcester County');
  assert.deepEqual(context.serviceAreas, ['Worcester County', 'Middlesex County']);
  assert.equal(context.clientId, 'client-123');
  assert.deepEqual(context.services, [
    { name: 'Cabinet Painting', description: 'Kitchen cabinets' },
  ]);
  assert.deepEqual(context.businessInformation, [
    { title: 'Warranty', info: 'One year on labor.' },
  ]);
  assert.match(context.knowledgeJson, /One year on labor/);
  assert.match(context.knowledgeJson, /Do you paint cabinets/);
  assert.doesNotMatch(context.knowledgeJson, /never-show-this-token/);
  assert.doesNotMatch(context.knowledgeJson, /also-private/);
  assert.doesNotMatch(context.knowledgeJson, /private\.example\.test/);
  assert.doesNotMatch(context.knowledgeJson, /Taylor/);
  assert.doesNotMatch(context.knowledgeJson, /alloy/);
  assert.equal('receptionistName' in context, false);
  assert.equal('voice' in context, false);
});

test('normalizes textual service-request day ranges from Ark', () => {
  const context = createBusinessContext({
    profile: {
      serviceRequestDays: 'Monday through Friday',
    },
  });

  assert.deepEqual(context.serviceRequestWeekdays, [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ]);
});

test('keeps Ark structured service-area states and counties for risk checks', () => {
  const context = createBusinessContext({
    profile: {
      businessName: 'County Plumbing',
      serviceAreas: ['Massachusetts', 'Worcester County', 'Middlesex County'],
      serviceAreaMode: 'counties',
      serviceAreaStates: ['Massachusetts'],
      serviceAreaCounties: ['Worcester County', 'Middlesex County'],
      services: ['Emergency Plumbing'],
    },
  });

  assert.equal(context.serviceAreaMode, 'counties');
  assert.deepEqual(context.serviceAreaStates, ['Massachusetts']);
  assert.deepEqual(context.serviceAreaCounties, ['Worcester County', 'Middlesex County']);
  assert.match(context.knowledgeJson, /serviceAreaStates/);
  assert.match(context.knowledgeJson, /Middlesex County/);
});

test('keeps service-request availability empty when the owner does not configure it', () => {
  const context = createBusinessContext({
    profile: {
      businessName: 'Optional Schedule Services',
      timeZone: 'America/New_York',
      services: ['General Repair'],
    },
  });

  assert.deepEqual(context.serviceRequestWeekdays, []);
  assert.equal(context.earliestServiceRequestStart, '');
  assert.equal(context.latestServiceRequestStart, '');
});

test('accepts legacy estimate scheduling fields without exposing their old names to the model', () => {
  const context = createBusinessContext({
    profile: {
      estimateDays: 'Monday through Friday',
      earliestEstimateStart: '09:00',
      latestEstimateStart: '16:00',
    },
  });

  assert.deepEqual(context.serviceRequestWeekdays, [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ]);
  assert.equal(context.earliestServiceRequestStart, '09:00');
  assert.equal(context.latestServiceRequestStart, '16:00');
  assert.match(context.knowledgeJson, /serviceRequestDays/);
  assert.match(context.knowledgeJson, /earliestServiceRequestStart/);
  assert.doesNotMatch(context.knowledgeJson, /estimateDays|earliestEstimateStart/);
});

test('accepts Ark profile data supplied as a JSON string', () => {
  const context = createBusinessContext({
    clientId: 'client-456',
    profile: JSON.stringify({
      businessName: 'String Profile Painting',
      timeZone: 'America/Denver',
      services: ['Deck Staining'],
    }),
  });

  assert.equal(context.businessName, 'String Profile Painting');
  assert.equal(context.timeZone, 'America/Denver');
  assert.deepEqual(context.services, [{ name: 'Deck Staining', description: '' }]);
});

test('caps website knowledge included in the model prompt', () => {
  const previousLimit = process.env.MAX_WEBSITE_KNOWLEDGE_CHARACTERS;
  process.env.MAX_WEBSITE_KNOWLEDGE_CHARACTERS = '2000';
  try {
    const context = createBusinessContext({
      profile: {
        businessName: 'Large Website Painting',
      },
      knowledge: {
        serviceDetails: 'x'.repeat(10_000),
      },
    });
    assert.ok(context.knowledgeJson.length < 2_100);
    assert.match(context.knowledgeJson, /truncated for cost control/);
  } finally {
    if (previousLimit === undefined) delete process.env.MAX_WEBSITE_KNOWLEDGE_CHARACTERS;
    else process.env.MAX_WEBSITE_KNOWLEDGE_CHARACTERS = previousLimit;
  }
});

test('accepts only the explicit Ark emergency-routing contract and otherwise fails closed', () => {
  const enabled = createBusinessContext({
    profile: {
      businessName: 'Emergency Plumbing',
      serviceRequestRouting: {
        mode: 'asap-or-scheduled',
        timingQuestion: 'Do you need help as soon as possible, or would you prefer to schedule a time?',
        scheduled: { enabled: true },
        emergency: {
          enabled: true,
          availability: '24/7',
          intakeField: 'requestUrgency',
          intakeValue: 'emergency',
          requestedTimeWindow: 'As soon as possible',
        },
      },
    },
  });

  assert.deepEqual(enabled.serviceRequestRouting, {
    mode: 'asap-or-scheduled',
    timingQuestion: 'Do you need help as soon as possible, or would you prefer to schedule a time?',
    scheduled: { enabled: true },
    emergency: {
      enabled: true,
      availability: '24/7',
      intakeField: 'requestUrgency',
      intakeValue: 'emergency',
      requestedTimeWindow: 'As soon as possible',
    },
  });

  const disabled = createBusinessContext({
    profile: {
      emergencyServiceEnabled: true,
      emergencyService24Hours: true,
      serviceRequestRouting: { mode: 'scheduled-only', timingQuestion: '' },
    },
  });
  assert.deepEqual(disabled.serviceRequestRouting, {
    mode: 'scheduled-only',
    timingQuestion: '',
    scheduled: { enabled: true },
  });
  assert.equal('emergency' in disabled.serviceRequestRouting, false);
});
