import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  SILENCE_DURATION_MS,
  SPEECH_SPEED,
  afterSaveQuestion,
  buildOcmPayload,
  getCallerPhone,
  instructions,
  normalizePreferredTime,
  openingLine,
  questionCatalog,
  resolvePreferredDate,
  saveFailureLine,
  tools,
  validateLead,
} from '../receptionist-core.js';
import {
  callUsageOutcome,
  durationSeconds,
  noteTranscriptProgress,
} from '../call-policy.js';

function completeLead(overrides = {}) {
  return {
    fullName: 'Taylor Morgan',
    serviceType: 'interior painting',
    cityOrTown: 'Example City',
    state: 'Massachusetts',
    streetNumber: '12',
    streetName: 'Main Street',
    preferredDateOrDay: 'Tuesday',
    preferredTime: '4:30 PM',
    additionalNotes: 'Please call before arriving',
    contactConsent: true,
    ...overrides,
  };
}

function completeRuntimeEnv(overrides = {}) {
  return {
    ...process.env,
    AI_MODEL: 'gpt-realtime-mini',
    AI_SILENCE_MS: '1200',
    AI_SPEECH_SPEED: '0.94',
    AI_VOICE: 'alloy',
    BUSINESS_INFO: process.env.BUSINESS_INFO,
    OCM_CLIENT_ID: 'example-painting',
    OPENAI_API_KEY: 'test-openai-value',
    PUBLIC_URL: 'https://example-receptionist.example.com',
    TELNYX_API_KEY: 'test-telnyx-value',
    ...overrides,
  };
}

test('uses dynamic business fields with one centralized receptionist prompt', () => {
  const prompt = instructions();
  assert.equal(BUSINESS.name, 'Example Painting');
  assert.equal(BUSINESS.receptionist, 'Alex');
  assert.match(openingLine, /Example Painting/);
  assert.match(afterSaveQuestion, /Example Painting/);
  assert.match(prompt, /MASTER AI RECEPTIONIST PROMPT/);
  assert.match(prompt, /primary objective is to help the caller submit a complete estimate request/i);
  assert.match(prompt, /What is your first and last name\?/i);
  assert.match(prompt, /What state is the project in\?/i);
  assert.match(prompt, /What is the street number\?/i);
  assert.match(prompt, /Do you have any additional notes/i);
  assert.match(prompt, /additional notes are optional/i);
  assert.match(prompt, /Do you agree to be contacted by Example Painting about this estimate request\?/i);
  assert.match(prompt, /I am an AI receptionist working on behalf of Example Painting/i);
  assert.match(prompt, /reserved for estimate-request submissions/i);
  assert.doesNotMatch(prompt, /Would you like to add.*email|What.*email address|contact method/i);
  assert.equal(REALTIME_MODEL, 'gpt-realtime-mini');
  assert.equal(REALTIME_VOICE, 'alloy');
  assert.equal(SPEECH_SPEED, 0.94);
  assert.equal(SILENCE_DURATION_MS, 1200);
});

test('question catalog keeps optional notes immediately before consent', () => {
  const ids = Object.keys(questionCatalog);
  assert.ok(ids.indexOf('additional_notes_offer') < ids.indexOf('contact_consent'));
  assert.equal(questionCatalog.additional_notes_offer.field, 'additionalNotesRequested');
  assert.equal(questionCatalog.contact_consent.field, 'contactConsent');
});

test('accepts times inside the configured estimate window', () => {
  assert.equal(normalizePreferredTime('9 am'), '9:00 AM');
  assert.equal(normalizePreferredTime('4:30 PM'), '4:30 PM');
  assert.equal(normalizePreferredTime('5:00 PM'), '');
});

test('accepts an upcoming configured weekday or exact configured date', () => {
  const friday = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(resolvePreferredDate('Monday', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('2026-07-20', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('07/20/2026', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('2026-07-19', friday), '');
});

test('requires precise location, configured service, date, time, and consent', () => {
  assert.equal(validateLead(completeLead()).valid, true);
  assert.equal(validateLead(completeLead({ state: '' })).valid, false);
  assert.equal(validateLead(completeLead({ streetNumber: '' })).valid, false);
  assert.equal(validateLead(completeLead({ streetName: '' })).valid, false);
  assert.equal(validateLead(completeLead({ contactConsent: false })).valid, false);
});

test('additional notes are optional and caller email is not in the tool', () => {
  assert.equal(validateLead(completeLead({ additionalNotes: '' })).valid, true);
  const submitTool = tools.find((tool) => tool.name === 'submit_estimate_lead');
  assert.ok(submitTool);
  assert.equal('email' in submitTool.parameters.properties, false);
  assert.equal('contactMethod' in submitTool.parameters.properties, false);
  assert.equal(submitTool.parameters.required.includes('additionalNotes'), false);
  assert.equal(submitTool.parameters.required.includes('contactConsent'), true);
});

test('builds a precise OCM address and preserves optional notes', () => {
  const result = validateLead(completeLead());
  assert.equal(result.valid, true);
  const payload = buildOcmPayload('+17745550123', result.lead);
  assert.equal(payload.clientId, 'example-painting');
  assert.equal(payload.Phone, '+17745550123');
  assert.equal(payload.StreetAddress, '12 Main Street');
  assert.equal(payload.TownOrCity, 'Example City');
  assert.equal(payload.State, 'Massachusetts');
  assert.equal(payload.Address, '12 Main Street, Example City, Massachusetts');
  assert.equal('Email' in payload, false);
  assert.match(payload.Notes, /Please call before arriving/);
  assert.match(payload.EstimateDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('failed submission line does not promise a follow-up', () => {
  assert.match(saveFailureLine, /not submitted/i);
  assert.match(saveFailureLine, /24 hours/i);
  assert.doesNotMatch(saveFailureLine, /follow up/i);
});

test('pulls the caller phone number from a Telnyx webhook', () => {
  assert.equal(getCallerPhone({ data: { payload: { from: '+17745550123' } } }), '+17745550123');
});

test('BUSINESS_INFO rebrands every prompt and audio setting', () => {
  const businessInfo = {
    name: 'Sample Roofing',
    receptionist: 'Morgan',
    owner: 'Casey Rivera',
    phone: '(555) 555-0100',
    email: 'hello@example.com',
    hours: 'Monday through Saturday, 7 AM to 6 PM',
    timeZone: 'America/Chicago',
    estimateDays: 'Tuesday through Saturday',
    estimateWeekdays: ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    earliestEstimateStart: '8:00 AM',
    latestEstimateStart: '5:00 PM',
    base: 'Austin, Texas',
    serviceAreas: ['Austin', 'Round Rock'],
    services: {
      'roof repair': 'Repairing leaks and damaged roofing.',
      'roof replacement': 'Replacing residential roofing systems.',
    },
    about: ['Sample Roofing serves residential customers.'],
    openingLine: 'Thanks for calling {{business_name}}. This is {{receptionist_name}}, the receptionist. Would you like an estimate request?',
    closingLine: '{{owner_first_name}} will contact you soon. Goodbye.',
    extraInformation: 'Final pricing is provided after inspection.',
  };
  const code = `
    const core = await import('./receptionist-core.js');
    console.log(JSON.stringify({
      business: core.BUSINESS,
      openingLine: core.openingLine,
      closingLine: core.closingLine,
      instructions: core.instructions(),
      model: core.REALTIME_MODEL,
      voice: core.REALTIME_VOICE,
      speed: core.SPEECH_SPEED,
      silence: core.SILENCE_DURATION_MS,
      services: core.tools[0].parameters.properties.serviceType.enum,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: completeRuntimeEnv({
      BUSINESS_INFO: JSON.stringify(businessInfo),
      OCM_CLIENT_ID: 'sample-roofing',
      AI_VOICE: 'marin',
      AI_SPEECH_SPEED: '1.08',
      AI_SILENCE_MS: '900',
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.business.name, 'Sample Roofing');
  assert.match(output.instructions, /roof repair, or roof replacement/i);
  assert.match(output.instructions, /working on behalf of Sample Roofing/i);
  assert.doesNotMatch(output.instructions, /Example Painting|Tabor Painting/i);
  assert.deepEqual(output.services, ['roof repair', 'roof replacement']);
  assert.equal(output.voice, 'marin');
  assert.equal(output.speed, 1.08);
  assert.equal(output.silence, 900);
});

test('bootstrap uses the signed per-call runtime without a second script prompt', () => {
  const code = `
    await import('./ocm-bootstrap.js');
    const loader = await import('./runtime-loader.js');
    console.log(JSON.stringify({
      endpoint: loader.runtimeEndpoint(),
      model: process.env.AI_MODEL,
      hasLegacyScript: Boolean(process.env.RECEPTIONIST_SCRIPT),
    }));
  `;
  const env = completeRuntimeEnv({
    OCM_CLIENT_ID: '',
    BUSINESS_INFO: '',
    AI_VOICE: '',
    AI_SPEECH_SPEED: '',
    AI_SILENCE_MS: '',
  });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.endpoint, 'https://ark-websites-ocm-xi.vercel.app/api/receptionist/runtime');
  assert.equal(output.model, 'gpt-realtime-mini');
  assert.equal(output.hasLegacyScript, false);
});

test('tracks substantive progress but ignores repeated filler', () => {
  const seen = new Set();
  assert.equal(noteTranscriptProgress(seen, 'um, yeah, okay'), false);
  assert.equal(noteTranscriptProgress(seen, 'Taylor Morgan'), true);
  assert.equal(noteTranscriptProgress(seen, 'Taylor Morgan'), false);
  assert.equal(noteTranscriptProgress(seen, 'interior painting in Berlin'), true);
});

test('classifies call outcomes and rounds connected seconds up', () => {
  assert.equal(callUsageOutcome({ leadSaved: true, endReason: 'max-duration' }), 'lead-saved');
  assert.equal(callUsageOutcome({ leadSaved: false, endReason: 'max-duration' }), 'max-duration-no-lead');
  assert.equal(callUsageOutcome({ leadSaved: false, endReason: 'silence' }), 'silence-no-lead');
  assert.equal(callUsageOutcome({ leadSaved: false, endReason: 'no-progress' }), 'no-progress-no-lead');
  assert.equal(durationSeconds(1000, 61001), 61);
});
