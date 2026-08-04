import assert from 'node:assert/strict';
import test from 'node:test';

import { createReceptionistCore } from '../receptionist-core.js';
import {
  baseQuestionFor,
  captureDeterministicLead,
  markDeterministicCompletions,
  mergeLead,
  nextRequiredQuestion,
  validationLeadFromModular,
} from '../modular-intake-logic.js';
import { MODELS, TURN } from '../modular-models.js';
import {
  applyRealtimeInterpretation,
  buildRealtimeTurnPrompt,
  parseRealtimeTurnInterpretation,
} from '../realtime-turn-interpreter.js';
import {
  PHRASE_KEYS,
  RECEPTIONIST_PHRASES,
  receptionistPhrase,
} from '../receptionist-phrases.js';

const profile = Object.freeze({
  businessName: 'Tabor Painting',
  receptionistName: 'Alex',
  businessHours: 'Monday through Friday, 9 AM to 5 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:00 PM',
  businessBase: 'Berlin, Massachusetts',
  serviceAreas: ['Massachusetts'],
  services: {
    'wood staining': 'Wood staining services.',
    'exterior painting': 'Exterior painting services.',
    'interior painting': 'Interior painting services.',
    'small paint repair': 'Small paint repair services.',
  },
  aiVoice: 'alloy',
  aiSpeechSpeed: 0.94,
  aiSilenceMs: 1200,
});

const core = createReceptionistCore({ profile, clientId: 'tabor-painting' });
const completeLead = Object.freeze({
  name: 'Andrew Christensen',
  service: 'interior painting',
  callbackPhone: '+15085550100',
  projectLocation: '197 Lancaster Road, Berlin, MA',
  preferredDate: '2026-08-10',
  preferredTime: '2:00 PM',
  notes: 'none',
  contactConsent: true,
});
const AUGUST_FIRST_2026 = new Date('2026-08-01T16:00:00.000Z');

test('one realtime model remains configured behind the deterministic controller', () => {
  assert.equal(MODELS.realtime, 'gpt-realtime-2.1-mini');
  assert.equal(MODELS.realtimeVoice, MODELS.realtime);
  assert.equal(MODELS.brain, MODELS.realtime);
  assert.equal(Object.hasOwn(MODELS, 'transcription'), false);
  assert.equal(Object.hasOwn(MODELS, 'speech'), false);
  assert.ok(TURN.silenceMs >= 1200);
});

test('caller wording is intake-focused and remains in one phrase catalog', () => {
  assert.match(RECEPTIONIST_PHRASES.OPENING_01, /automated receptionist/i);
  assert.equal(RECEPTIONIST_PHRASES.QUESTION_SERVICE, 'What service do you need?');
  assert.match(RECEPTIONIST_PHRASES.QUESTION_PROJECT_ADDRESS, /unit and ZIP code/);
  assert.match(RECEPTIONIST_PHRASES.QUESTION_FINAL_CONFIRMATION, /agreed that/);
});

test('opening, consent decline, and closing render business placeholders', () => {
  assert.match(receptionistPhrase(core, PHRASE_KEYS.OPENING, completeLead), /Tabor Painting/);
  assert.match(receptionistPhrase(core, PHRASE_KEYS.CONSENT_DECLINED, completeLead), /won't submit/);
  assert.equal(
    receptionistPhrase(core, PHRASE_KEYS.CLOSING, completeLead),
    'Okay. Thank you for calling Tabor Painting. Have a good day.',
  );
});

test('question IDs map to approved exact phrases', () => {
  assert.equal(baseQuestionFor(core, 'service', completeLead), 'What service do you need?');
  assert.equal(baseQuestionFor(core, 'name', completeLead), 'What is your full name?');
  assert.match(baseQuestionFor(core, 'project_location', completeLead), /street number and name/);
  assert.match(baseQuestionFor(core, 'preferred_date_time', completeLead), /Monday through Friday/);
});

test('interpretation prompt is tenant-timezone-aware and emits no caller prose', () => {
  const prompt = buildRealtimeTurnPrompt({
    core,
    transcript: 'The whole inside of my house needs paint.',
    currentQuestionId: 'service',
    lead: { ...completeLead, service: null },
    history: [],
  });
  assert.match(prompt, /Do not write a caller-facing response/i);
  assert.match(prompt, /Never suggest hiring or contacting a painter/i);
  assert.match(prompt, /configuredServices/);
  assert.match(prompt, /YYYY-MM-DD/);
});

test('interpretation parsing permits only bounded actions, acknowledgements, and fields', () => {
  const turn = parseRealtimeTurnInterpretation(JSON.stringify({
    action: 'answer',
    ack: 'sorry',
    updates: { service: 'interior painting' },
  }));
  assert.equal(turn.action, 'answer');
  assert.equal(turn.ack, 'sorry');
  assert.equal(turn.updates.service, 'interior painting');
  assert.equal(turn.updates.name, null);
});

test('only a configured service can be committed', () => {
  const accepted = applyRealtimeInterpretation(core, { ...completeLead, service: null }, {
    action: 'answer',
    ack: 'sounds_good',
    updates: { service: 'interior painting' },
  });
  const rejected = applyRealtimeInterpretation(core, { ...completeLead, service: null }, {
    action: 'answer',
    ack: 'none',
    updates: { service: 'roofing' },
  });
  assert.equal(accepted.lead.service, 'interior painting');
  assert.equal(rejected.lead.service, null);
});

test('Unicode names survive interpretation and deterministic cleanup', () => {
  const interpreted = applyRealtimeInterpretation(core, { ...completeLead, name: null }, {
    action: 'answer',
    ack: 'thanks_name',
    updates: { name: 'Um José O’Neill' },
  });
  const deterministic = captureDeterministicLead(
    core,
    'name',
    'Um, José O’Neill.',
    { ...completeLead, name: null },
  );
  assert.equal(interpreted.lead.name, 'José O’Neill');
  assert.equal(deterministic.name, 'José O’Neill');
});

test('address corrections preserve other lead fields', () => {
  const result = applyRealtimeInterpretation(core, completeLead, {
    action: 'summary_correction',
    ack: 'thanks',
    updates: { projectLocation: '197 Lancaster Road, Unit 2, Berlin, MA 01503' },
  });
  assert.equal(result.lead.name, 'Andrew Christensen');
  assert.equal(result.lead.projectLocation, '197 Lancaster Road, Unit 2, Berlin, MA 01503');

  const merged = mergeLead(completeLead, { projectLocation: result.lead.projectLocation });
  assert.equal(merged.name, 'Andrew Christensen');
});

test('weekday phrases become canonical tenant-local ISO dates', () => {
  const result = applyRealtimeInterpretation(core, {
    ...completeLead,
    preferredDate: null,
    preferredTime: null,
  }, {
    action: 'answer',
    ack: 'sounds_good',
    updates: {
      preferredDate: 'Monday',
      preferredTime: 'two',
    },
  }, { now: AUGUST_FIRST_2026 });
  assert.equal(result.lead.preferredDate, '2026-08-03');
  assert.equal(result.lead.preferredTime, '2:00 PM');
});

test('out-of-schedule interpreted times are rejected immediately', () => {
  const result = applyRealtimeInterpretation(core, {
    ...completeLead,
    preferredDate: null,
    preferredTime: null,
  }, {
    action: 'answer',
    ack: 'none',
    updates: {
      preferredDate: 'Friday',
      preferredTime: '6:00 PM',
    },
  }, { now: AUGUST_FIRST_2026 });
  assert.equal(result.lead.preferredDate, '2026-08-07');
  assert.equal(result.lead.preferredTime, null);
});

test('deterministic service capture does not invent unconfigured categories', () => {
  const accepted = captureDeterministicLead(
    core,
    'service',
    'I need interior painting.',
    { ...completeLead, service: null },
  );
  const rejected = captureDeterministicLead(
    core,
    'service',
    'I need roofing.',
    { ...completeLead, service: null },
  );
  assert.equal(accepted.service, 'interior painting');
  assert.equal(rejected.service, null);
});

test('completed fields advance in locked order and consent false does not complete intake', () => {
  const memory = { completedQuestionIds: [] };
  for (const questionId of ['service', 'name', 'callback_phone', 'project_location', 'preferred_date_time', 'notes']) {
    memory.completedQuestionIds = markDeterministicCompletions(
      core,
      questionId,
      completeLead,
      memory.completedQuestionIds,
    );
  }
  assert.equal(nextRequiredQuestion(core, memory, { ...completeLead, contactConsent: false }), 'contact_consent');
  memory.completedQuestionIds = markDeterministicCompletions(
    core,
    'contact_consent',
    completeLead,
    memory.completedQuestionIds,
  );
  assert.equal(nextRequiredQuestion(core, memory, completeLead), 'confirm_summary');
});

test('modular lead validation uses the canonical structured address', () => {
  const mapped = validationLeadFromModular(core, {
    ...completeLead,
    projectLocation: '197 Lancaster Road, Unit 2, Berlin, Massachusetts 01503',
  });
  assert.equal(mapped.projectLocation, '197 Lancaster Road, Unit 2, Berlin, MA 01503');
  assert.equal(mapped.serviceType, 'interior painting');
  assert.equal(mapped.callbackPhone, '+15085550100');
});
