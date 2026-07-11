import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REALTIME_MODEL, buildOcmPayload, getCallerPhone, instructions, validateLead } from './receptionist-core.js';

test('hard-locks the requested realtime mini model', () => {
  assert.equal(REALTIME_MODEL, 'gpt-realtime-mini');
});

test('extracts caller ID from a Telnyx webhook', () => {
  assert.equal(getCallerPhone({ data: { payload: { from: '+17745551234' } } }), '+17745551234');
});

test('validates and maps the seven-field intake to Contacted Me', () => {
  const result = validateLead({
    fullName: 'Taylor Smith',
    email: 'taylor@example.com',
    serviceType: 'exterior painting',
    projectDetails: 'A couple outside walls',
    townOrCity: 'Berlin',
    streetAddress: '10 Main Street',
    contactMethod: 'text',
    additionalNotes: ''
  });
  assert.equal(result.valid, true);
  const payload = buildOcmPayload('+17745551234', result.lead);
  assert.equal(payload.sectionKey, 'contactedMe');
  assert.equal(payload.Phone, '+17745551234');
  assert.equal(payload.Job, 'exterior painting');
  assert.match(payload.Notes, /Best contact method: text/);
});

test('keeps the requested intake order and removes appointment scheduling fields', () => {
  const prompt = instructions();
  const questions = [
    'first and last name',
    'email address',
    'what service were you looking to get',
    'what town or city',
    'street address',
    'best way we can contact you',
    'Jason to know anything else'
  ];
  let previous = -1;
  for (const question of questions) {
    const index = prompt.toLowerCase().indexOf(question.toLowerCase());
    assert.ok(index > previous, `${question} must appear in order`);
    previous = index;
  }
  assert.doesNotMatch(prompt, /preferred day|preferred time/i);
});

test('requires sustained speech before clearing Alex audio', () => {
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /const BARGE_IN_CONFIRM_MS = 450;/);
  assert.match(server, /threshold: 0\.7/);
  assert.match(server, /create_response: false/);
  assert.match(server, /interrupt_response: false/);
  assert.match(server, /setTimeout\(\(\) => confirmBargeIn\(ctx\), BARGE_IN_CONFIRM_MS\)/);
  assert.match(server, /type: 'response\.cancel'/);
  assert.match(server, /type: 'conversation\.item\.truncate'/);
  assert.doesNotMatch(server, /input_audio_buffer\.speech_started'[\s\S]{0,120}event: 'clear'/);
});
