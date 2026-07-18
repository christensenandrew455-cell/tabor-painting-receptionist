import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOcmPayload,
  instructions,
  resolvePreferredDate,
  tools,
  validateLead,
} from './receptionist-core-v2.js';

function completeLead(overrides = {}) {
  return {
    fullName: 'Test Caller',
    email: 'test@example.com',
    serviceType: 'interior painting',
    townOrCity: 'Berlin',
    streetAddress: '1 Main Street',
    contactMethod: 'text',
    preferredDay: 'Monday',
    preferredTime: '1:30 PM',
    additionalNotes: '',
    ...overrides,
  };
}

test('resolves the next requested weekday in the business timezone', () => {
  const friday = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(resolvePreferredDate('Monday', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('Friday', friday), '2026-07-17');
});

test('adds an actual estimate date to the OCM payload', () => {
  const payload = buildOcmPayload('+15085551234', completeLead());

  assert.match(payload.EstimateDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.PreferredDay, payload.EstimateDate);
  assert.equal(payload.RequestedWeekday, 'Monday');
});

test('allows callers to decline email unless email is their contact method', () => {
  const declined = validateLead(completeLead({ email: '', contactMethod: 'text' }));
  assert.equal(declined.valid, true);
  assert.equal(declined.lead.email, '');

  const emailContact = validateLead(completeLead({ email: '', contactMethod: 'email' }));
  assert.equal(emailContact.valid, false);
  assert.match(emailContact.errors.join(' '), /complete email address/i);
});

test('makes email optional in the lead tool schema', () => {
  const submitTool = tools.find((tool) => tool.name === 'submit_estimate_lead');
  assert.ok(submitTool);
  assert.equal(submitTool.parameters.required.includes('email'), false);
  assert.match(submitTool.parameters.properties.email.description, /optional/i);
});

test('instructions use only available contact methods', () => {
  const prompt = instructions();
  assert.match(prompt, /If no email was provided[\s\S]*call or text\?/i);
  assert.match(prompt, /If an email was provided[\s\S]*call, text, or email\?/i);
  assert.match(prompt, /Do not offer email/i);
});

test('instructions include optional email, phone privacy, save, and strict silent hold behavior', () => {
  const prompt = instructions();
  assert.match(prompt, /Would you like to add your email\? Yes or no/i);
  assert.match(prompt, /email as an empty string/i);
  assert.match(prompt, /Never say or repeat the caller-ID phone number/i);
  assert.match(prompt, /give me one second to save that/i);
  assert.match(prompt, /Silence is mandatory/i);
  assert.match(prompt, /take your time[\s\S]*forbidden/i);
  assert.match(prompt, /standalone filler/i);
  assert.match(prompt, /natural, measured pace/i);
});
