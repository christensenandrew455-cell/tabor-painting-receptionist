import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  REALTIME_MODEL,
  buildOcmPayload,
  getCallerPhone,
  instructions,
  normalizePreferredTime,
  tools,
  validateLead,
} from './receptionist-core-v2.js';

const productionServer = fs.readFileSync(new URL('./server-v2.js', import.meta.url), 'utf8');

test('hard-locks the requested realtime mini model', () => {
  assert.equal(REALTIME_MODEL, 'gpt-realtime-mini');
});

test('extracts caller ID from a Telnyx webhook', () => {
  assert.equal(getCallerPhone({ data: { payload: { from: '+17745551234' } } }), '+17745551234');
});

test('validates and maps the nine-field intake to Contacted Me', () => {
  const result = validateLead({
    fullName: 'Taylor Smith',
    email: 'taylor@example.com',
    serviceType: 'exterior painting',
    townOrCity: 'Berlin',
    streetAddress: '10 Main Street',
    contactMethod: 'text',
    preferredDay: 'wednesday',
    preferredTime: '4:30 pm',
    additionalNotes: 'A couple outside walls',
  });
  assert.equal(result.valid, true);
  assert.equal(result.lead.preferredDay, 'Wednesday');
  assert.equal(result.lead.preferredTime, '4:30 PM');

  const payload = buildOcmPayload('+17745551234', result.lead);
  assert.equal(payload.sectionKey, 'contactedMe');
  assert.equal(payload.Phone, '+17745551234');
  assert.equal(payload.Job, 'exterior painting');
  assert.match(payload.PreferredDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.EstimateDate, payload.PreferredDay);
  assert.equal(payload.RequestedWeekday, 'Wednesday');
  assert.equal(payload.PreferredTime, '4:30 PM');
  assert.match(payload.Notes, /Best contact method: text/);
  assert.match(payload.Notes, /Requested estimate: Wednesday at 4:30 PM/);
  assert.match(payload.Notes, /Additional notes: A couple outside walls/);
  assert.doesNotMatch(payload.Notes, /Project details:/);
});

test('accepts only estimate times from 9 AM through 4:30 PM', () => {
  assert.equal(normalizePreferredTime('9am'), '9:00 AM');
  assert.equal(normalizePreferredTime('1:15 PM'), '1:15 PM');
  assert.equal(normalizePreferredTime('4:30 pm'), '4:30 PM');
  assert.equal(normalizePreferredTime('8:59 am'), '');
  assert.equal(normalizePreferredTime('4:31 pm'), '');
  assert.equal(normalizePreferredTime('6 pm'), '');
});

test('rejects weekends and out-of-range estimate times', () => {
  const result = validateLead({
    fullName: 'Taylor Smith',
    email: 'taylor@example.com',
    serviceType: 'interior painting',
    townOrCity: 'Berlin',
    streetAddress: '10 Main Street',
    contactMethod: 'call',
    preferredDay: 'saturday',
    preferredTime: '5 pm',
    additionalNotes: '',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /preferred estimate day.*Monday.*Friday/i);
  assert.match(result.errors.join(' '), /preferred estimate time between 9:00 AM and 4:30 PM/i);
});

test('keeps the requested intake order and category-only service question', () => {
  const prompt = instructions();
  const questions = [
    'first and last name',
    'email address',
    'what service would you like',
    'what town or city',
    'street address',
    'best way we can contact you',
    'what day would work best',
    'what time would work best',
    'anything else you would like Jason to know',
  ];
  let previous = -1;
  for (const question of questions) {
    const index = prompt.toLowerCase().indexOf(question.toLowerCase());
    assert.ok(index > previous, `${question} must appear in order`);
    previous = index;
  }
  assert.match(prompt, /Monday through Friday/i);
  assert.match(prompt, /9:00 AM to 4:30 PM/i);
  assert.match(prompt, /We can only do estimate times between 9:00 AM and 4:30 PM/i);
  for (const service of ['interior painting', 'exterior painting', 'small paint repair', 'wood staining']) {
    assert.match(prompt, new RegExp(service, 'i'));
  }
  assert.match(prompt, /Do not ask about project size, scope/i);
  assert.doesNotMatch(prompt, /projectDetails/);
});

test('uses day and time in the lead tool schema without projectDetails', () => {
  const submitTool = tools.find((tool) => tool.name === 'submit_estimate_lead');
  assert.ok(submitTool);
  assert.equal('projectDetails' in submitTool.parameters.properties, false);
  assert.equal(submitTool.parameters.required.includes('projectDetails'), false);
  assert.equal(submitTool.parameters.required.includes('preferredDay'), true);
  assert.equal(submitTool.parameters.required.includes('preferredTime'), true);
  assert.deepEqual(submitTool.parameters.properties.preferredDay.enum, [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ]);
});

test('requires sustained speech before clearing Alex audio', () => {
  assert.match(productionServer, /const BARGE_IN_CONFIRM_MS = 450;/);
  assert.match(productionServer, /threshold: 0\.7/);
  assert.match(productionServer, /create_response: false/);
  assert.match(productionServer, /interrupt_response: false/);
  assert.match(productionServer, /setTimeout\(\(\) => confirmBargeIn\(ctx\), BARGE_IN_CONFIRM_MS\)/);
  assert.match(productionServer, /type: 'response\.cancel'/);
  assert.match(productionServer, /type: 'conversation\.item\.truncate'/);
  assert.doesNotMatch(productionServer, /input_audio_buffer\.speech_started'[\s\S]{0,120}event: 'clear'/);
});

test('paces PCMU audio and waits for Telnyx playback before hangup', () => {
  assert.match(productionServer, /const AUDIO_FRAME_MS = 20;/);
  assert.match(productionServer, /const AUDIO_FRAME_BYTES = AUDIO_FRAME_MS \* PCMU_BYTES_PER_MS;/);
  assert.match(productionServer, /const AUDIO_PREBUFFER_MS = 60;/);
  assert.match(productionServer, /setTimeout\(\(\) => pumpAudio\(ctx\), AUDIO_FRAME_MS\)/);
  assert.match(productionServer, /event: 'mark'/);
  assert.match(productionServer, /event === 'mark'/);
  assert.match(productionServer, /completeAssistantPlayback\(ctx\)/);
  assert.match(productionServer, /max_output_tokens: MAX_OUTPUT_TOKENS/);
  assert.match(productionServer, /speed: AUDIO_SPEED/);
  assert.doesNotMatch(productionServer, /setTimeout\(\(\) => \{[\s\S]{0,160}telnyxCommand\(ctx\.callControlId, 'hangup'\)[\s\S]{0,40}, 700\)/);
});

test('waits silently when the caller asks for a pause', () => {
  assert.match(productionServer, /const HOLD_PATTERN/);
  assert.match(productionServer, /ctx\.holdMode = true/);
  assert.match(productionServer, /if \(!ctx\.pendingNaturalResponse \|\| ctx\.holdMode\) return false/);
  assert.match(productionServer, /conversation\.item\.input_audio_transcription\.completed/);
  assert.match(productionServer, /gpt-4o-mini-transcribe/);
});

test('allows the complete recap and logs why a response ended', () => {
  assert.match(productionServer, /const MAX_OUTPUT_TOKENS = 800;/);
  assert.doesNotMatch(productionServer, /const MAX_OUTPUT_TOKENS = 600;/);
  assert.match(productionServer, /\[OpenAI response done\]/);
  assert.match(productionServer, /status_details\?\.reason/);
  assert.match(productionServer, /outputTokens: response\.usage\?\.output_tokens/);
});
