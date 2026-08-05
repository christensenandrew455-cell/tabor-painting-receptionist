import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessContext, normalizeServices } from '../business-context.js';

test('normalizes website services from an object map', () => {
  assert.deepEqual(normalizeServices({
    'Interior Painting': 'Walls and trim',
    'Exterior Painting': { description: 'Siding and decks' },
  }), [
    { name: 'Interior Painting', description: 'Walls and trim' },
    { name: 'Exterior Painting', description: 'Siding and decks' },
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
      services: [{ name: 'Cabinet Painting', description: 'Kitchen cabinets' }],
      apiKey: 'also-private',
      faq: [{ question: 'Do you paint cabinets?', answer: 'Yes.' }],
    },
  });

  assert.equal(context.businessName, 'Tabor Painting');
  assert.equal(context.timeZone, 'America/Chicago');
  assert.equal(context.clientId, 'client-123');
  assert.deepEqual(context.services, [
    { name: 'Cabinet Painting', description: 'Kitchen cabinets' },
  ]);
  assert.match(context.knowledgeJson, /Do you paint cabinets/);
  assert.doesNotMatch(context.knowledgeJson, /never-show-this-token/);
  assert.doesNotMatch(context.knowledgeJson, /also-private/);
  assert.doesNotMatch(context.knowledgeJson, /private\.example\.test/);
  assert.doesNotMatch(context.knowledgeJson, /Taylor/);
  assert.doesNotMatch(context.knowledgeJson, /alloy/);
  assert.equal('receptionistName' in context, false);
  assert.equal('voice' in context, false);
});

test('accepts ARC profile data supplied as a JSON string', () => {
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
        extraInformation: 'x'.repeat(10_000),
      },
    });
    assert.ok(context.knowledgeJson.length < 2_100);
    assert.match(context.knowledgeJson, /truncated for cost control/);
  } finally {
    if (previousLimit === undefined) delete process.env.MAX_WEBSITE_KNOWLEDGE_CHARACTERS;
    else process.env.MAX_WEBSITE_KNOWLEDGE_CHARACTERS = previousLimit;
  }
});
