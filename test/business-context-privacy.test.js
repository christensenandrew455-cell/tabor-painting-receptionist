import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessContext } from '../business-context.js';

test('removes private business contact and obsolete facts from model knowledge', () => {
  const context = createBusinessContext({
    clientId: 'client-123',
    businessName: 'Example Service',
    businessPhone: '+15555550123',
    businessEmail: 'private@example.com',
    about: 'Old freeform facts',
    extraInformation: 'More old facts',
    profile: {
      businessName: 'Example Service',
      ownerName: 'Taylor Owner',
      businessPhone: '+15555550123',
      businessEmail: 'private@example.com',
      contactPhone: '+15555550999',
      notificationEmail: 'alerts@example.com',
      about: 'Profile facts',
      extraInformation: 'Profile extra facts',
      businessHours: 'Monday through Friday, 9 AM to 5 PM',
      serviceAreas: ['Worcester, Massachusetts'],
      services: {
        plumbing: 'Plumbing',
      },
    },
  });

  assert.equal(context.businessName, 'Example Service');
  assert.deepEqual(context.services.map((service) => service.name), ['plumbing']);
  assert.match(context.knowledgeJson, /businessHours/);
  assert.match(context.knowledgeJson, /serviceAreas/);
  assert.doesNotMatch(context.knowledgeJson, /5555550123|5555550999/);
  assert.doesNotMatch(context.knowledgeJson, /private@example\.com|alerts@example\.com/);
  assert.doesNotMatch(context.knowledgeJson, /Old freeform facts|Profile facts|extra facts/);
  assert.doesNotMatch(context.knowledgeJson, /businessPhone|businessEmail|contactPhone|notificationEmail|"about"|extraInformation/);
});
