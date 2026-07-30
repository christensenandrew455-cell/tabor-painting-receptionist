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

test('uses dynamic business fields with the new centralized receptionist specification', () => {
  const prompt = instructions();
  assert.equal(BUSINESS.name, 'Example Painting');
  assert.equal(BUSINESS.receptionist, 'Alex');
  assert.match(openingLine, /Example Painting/);
  assert.match(openingLine, /Alex/);
  assert.match(afterSaveQuestion, /Example Painting/);
  assert.match(prompt, /MASTER AI RECEPTIONIST SPECIFICATION/);
  assert.match(prompt, /main objective is to guide the caller through a complete estimate request/i);
  assert.match(prompt, /What is your full name\?/i);
  assert.match(prompt, /What is the full address for the project\?/i);
  assert.match(prompt, /What day and time would you prefer for the estimate\?/i);
  assert.match(prompt, /Do you have any additional notes/i);
  assert.match(prompt, /Additional notes are optional/i);
  assert.match(prompt, /Do you consent to being contacted by Example Painting regarding your estimate request\?/i);
  assert.match(prompt, /AI receptionist working on behalf of Example Painting/i);
  assert.match(prompt, /only answer questions related to the business/i);
  assert.match(prompt, /Never ask for a ZIP code, phone number, or email address/i);
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

test('builds the OCM payload without exposing caller email', () => {
  const validation = validateLead(completeLead());
  const payload = buildOcmPayload('+15551234567', validation.lead);
  assert.equal(payload.FirstName, 'Taylor');
  assert.equal(payload.LastName, 'Morgan');
  assert.equal(payload.Phone, '+15551234567');
  assert.equal(payload.Address, '12 Main Street, Example City, Massachusetts');
  assert.equal('Email' in payload, false);
});

test('extracts caller phone from supported event shapes', () => {
  assert.equal(getCallerPhone({ data: { payload: { from: '+15551234567' } } }), '+15551234567');
  assert.equal(getCallerPhone({ start: { caller_id_number: '+15557654321' } }), '+15557654321');
});

test('fails fast when required runtime configuration is missing', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import './receptionist-core.js'"],
    {
      cwd: process.cwd(),
      env: completeRuntimeEnv({ BUSINESS_INFO: '' }),
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /BUSINESS_INFO is required/i);
});

test('tracks usage outcome and transcript progress', () => {
  assert.equal(durationSeconds(0, 2500), 3);
  assert.equal(callUsageOutcome({ answered: false }), 'not-answered');
  assert.equal(callUsageOutcome({ answered: true, leadSaved: true }), 'lead-saved');
  const state = {};
  noteTranscriptProgress(state, 'hello there');
  assert.equal(state.transcriptReceived, true);
  assert.ok(state.lastTranscriptAt > 0);
});

test('save failure wording is honest', () => {
  assert.match(saveFailureLine, /not submitted|couldn't submit/i);
  assert.doesNotMatch(saveFailureLine, /will follow up/i);
});
