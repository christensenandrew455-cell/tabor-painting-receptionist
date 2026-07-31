import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { businessInfoFromAppProfile, runtimeEnvironmentFromApp } from '../app-info-config.js';
import {
  baseQuestionFor,
  callerAffirmsSummary,
  captureDeterministicLead,
  changedLeadFields,
  controlSpeechReply,
  enforceQuestionBlock,
  isControlSpeech,
  isLikelyTranscriptionArtifact,
  isObviouslyIncompleteTranscript,
  mergeCallerFragment,
  nextRequiredQuestion,
  reopenConfirmation,
  repeatQuestionFor,
  shouldKeepHoldingFragment,
  spokenPreferredDate,
  validationLeadFromModular,
} from '../modular-intake-logic.js';
import { MODELS } from '../modular-models.js';
import { QUESTION_IDS, createCallMemory } from '../receptionist-brain.js';

const ROOT = new URL('../', import.meta.url);

function read(path) {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

const businessProfile = Object.freeze({
  businessName: 'Tabor Painting',
  receptionistName: 'Alex',
  ownerName: 'Taylor Tabor',
  businessPhone: '+17742316164',
  businessEmail: 'office@example.com',
  businessHours: 'Monday through Friday, 9:00 AM to 5:00 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:00 PM',
  businessBase: 'Massachusetts',
  serviceAreas: ['Massachusetts'],
  services: {
    'wood staining': 'Wood staining services.',
    'exterior painting': 'Exterior painting services.',
    'interior painting': 'Interior painting services.',
    'small paint repair': 'Small paint repair services.',
  },
  about: ['Residential painting company.'],
  extraInformation: 'Business fact.',
  aiVoice: 'alloy',
  aiSpeechSpeed: 0.94,
  aiSilenceMs: 1200,
  aiModel: 'gpt-realtime-mini',
  openingLine: 'OCM must not control this opening.',
  closingLine: 'OCM must not control this closing.',
});

const coreStub = Object.freeze({
  BUSINESS: Object.freeze({
    name: 'Tabor Painting',
    services: businessProfile.services,
    estimateDays: 'Monday through Friday',
    earliestEstimateStart: '9:00 AM',
    latestEstimateStart: '4:00 PM',
  }),
  contactConsentQuestion: 'Do you consent to being contacted by Tabor Painting?',
  normalizePreferredTime(value) {
    const normalized = String(value).replace(/\./g, '').trim().toLowerCase();
    if (/^2(?::00)?(?:\s*pm)?$/.test(normalized)) return '2:00 PM';
    if (/^4(?::00)?(?:\s*pm)?$/.test(normalized)) return '4:00 PM';
    if (/^9(?::00)?(?:\s*am)?$/.test(normalized)) return '9:00 AM';
    return '';
  },
  resolvePreferredDate(value) {
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'monday') return '2026-08-03';
    if (normalized === 'tuesday') return '2026-08-04';
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
  },
});

const completeLead = Object.freeze({
  name: 'Andrew Christensen',
  service: 'interior painting',
  projectLocation: '197 Lancaster Road, Berlin, Massachusetts',
  preferredDate: '2026-08-04',
  preferredTime: '4:00 PM',
  notes: 'none',
  contactConsent: true,
});

test('production starts the modular server with the Telnyx stream linker', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.main, 'server-modular.js');
  assert.equal(packageJson.scripts.start, 'node --import ./stream-call-link.js server-modular.js');
  assert.match(packageJson.scripts['start:legacy'], /server\.js$/);
});

test('Telnyx transport stays PCMU 8 kHz on the self leg', () => {
  const linker = read('stream-call-link.js');
  assert.match(linker, /stream_bidirectional_codec: 'PCMU'/);
  assert.match(linker, /stream_bidirectional_sampling_rate: 8000/);
  assert.match(linker, /stream_bidirectional_target_legs: 'self'/);
  assert.match(linker, /send_silence_when_idle: true/);
});

test('one Realtime session owns caller audio, transcription, and PCMU speech output', () => {
  const voice = read('openai-voice.js');
  assert.match(voice, /export function createRealtimeVoice/);
  assert.match(voice, /realtime\?model=\$\{encodeURIComponent\(MODELS\.realtimeVoice\)\}/);
  assert.match(voice, /transcription:[\s\S]*model: MODELS\.transcription/);
  assert.match(voice, /turn_detection:[\s\S]*type: 'semantic_vad'/);
  assert.match(voice, /create_response: false/);
  assert.match(voice, /interrupt_response: false/);
  assert.match(voice, /output:[\s\S]*format: \{ type: 'audio\/pcmu' \}/);
  assert.match(voice, /type: 'response\.create'/);
  assert.match(voice, /conversation: 'none'/);
  assert.match(voice, /type: 'response\.cancel'/);
  assert.match(voice, /response\.output_audio\.delta/);
  assert.doesNotMatch(voice, /\/v1\/audio\/speech/);
  assert.doesNotMatch(voice, /gpt-4o-mini-tts/);
});

test('verified OpenAI models have fixed jobs', () => {
  assert.equal(MODELS.realtimeVoice, 'gpt-realtime-mini');
  assert.equal(MODELS.transcription, 'gpt-4o-mini-transcribe');
  assert.equal(MODELS.brain, 'gpt-5-mini');
  assert.equal(MODELS.voice, 'alloy');
});

test('controller uses the same Realtime session for transcription and output', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /import \{ createRealtimeVoice \}/);
  assert.match(controller, /const realtimeVoice = createRealtimeVoice/);
  assert.match(controller, /realtimeVoice\.synthesize/);
  assert.match(controller, /realtimeVoice\.cancelSpeech/);
  assert.match(controller, /realtimeVoice\.append/);
  assert.match(controller, /realtimeVoice\.close/);
  assert.doesNotMatch(controller, /createTranscriber/);
  assert.doesNotMatch(controller, /synthesizePcmu/);
});

test('server reports voice-brain-controller-voice architecture', () => {
  const server = read('server-modular.js');
  assert.match(server, /realtime voice -> GPT-5 Mini brain -> deterministic controller -> realtime voice/);
  assert.match(server, /realtimeVoiceModel: MODELS\.realtimeVoice/);
  assert.match(server, /brainModel: MODELS\.brain/);
  assert.doesNotMatch(server, /speechModel: MODELS\.speech/);
  assert.match(server, /Models: \$\{MODELS\.realtimeVoice\} -> \$\{MODELS\.brain\} -> \$\{MODELS\.realtimeVoice\}/);
});

test('OCM business data cannot override models or locked opening and closing', () => {
  const environment = runtimeEnvironmentFromApp({ profile: businessProfile, clientId: 'tabor-painting' });
  const business = businessInfoFromAppProfile(businessProfile);
  assert.equal(environment.AI_MODEL, 'gpt-realtime-mini');
  assert.equal(environment.AI_VOICE, 'alloy');
  assert.doesNotMatch(environment.BUSINESS_INFO, /OCM must not control/);
  assert.notEqual(business.openingLine, businessProfile.openingLine);
  assert.notEqual(business.closingLine, businessProfile.closingLine);
});

test('structured memory starts with every question counter', () => {
  const memory = createCallMemory();
  assert.deepEqual(Object.keys(memory.askedCounts), [...QUESTION_IDS]);
  assert.deepEqual(memory.completedQuestionIds, []);
  assert.equal(memory.estimateStarted, false);
  assert.equal(memory.leadSaved, false);
});

test('field blocks remain deterministic and natural', () => {
  assert.equal(baseQuestionFor(coreStub, 'service', completeLead), 'What service do you need?');
  assert.match(baseQuestionFor(coreStub, 'preferred_date_time', completeLead), /Monday through Friday from 9:00 AM through 4:00 PM/);
  assert.match(
    baseQuestionFor(coreStub, 'notes', completeLead),
    /Tuesday, August 4th at 4:00 PM is your requested estimate time/,
  );
  assert.match(baseQuestionFor(coreStub, 'notes', completeLead), /Do you have any additional notes about this project\?$/);
  const summary = baseQuestionFor(coreStub, 'confirm_summary', completeLead);
  assert.match(summary, /^Before I send this in/);
  assert.match(summary, /You consented to being contacted by Tabor Painting\./);
  assert.match(summary, /Does all of that sound right\?$/);

  const corrected = enforceQuestionBlock(
    coreStub,
    'Our estimate availability is Monday through Friday from 9 AM to 4 PM. Could you choose another time?',
    'preferred_date_time',
    completeLead,
  );
  assert.equal((corrected.match(/Estimate appointments are available/g) || []).length, 1);
});

test('estimate order cannot skip notes, consent, or summary', () => {
  const memory = createCallMemory();
  memory.estimateStarted = true;
  memory.completedQuestionIds = ['service', 'name', 'project_location', 'preferred_date_time'];
  assert.equal(nextRequiredQuestion(memory, completeLead), 'notes');
  memory.completedQuestionIds.push('notes');
  assert.equal(nextRequiredQuestion(memory, completeLead), 'contact_consent');
  memory.completedQuestionIds.push('contact_consent');
  assert.equal(nextRequiredQuestion(memory, completeLead), 'confirm_summary');
});

test('modular lead maps into validator schema', () => {
  assert.deepEqual(validationLeadFromModular(completeLead), {
    fullName: 'Andrew Christensen',
    serviceType: 'interior painting',
    streetNumber: '197',
    streetName: 'Lancaster Road',
    cityOrTown: 'Berlin',
    state: 'Massachusetts',
    preferredDateOrDay: '2026-08-04',
    preferredTime: '4:00 PM',
    additionalNotes: 'none',
    contactConsent: true,
  });
});

test('requested weekday is resolved to the final exact date', () => {
  const captured = captureDeterministicLead(
    coreStub,
    'preferred_date_time',
    'Today is Friday, so probably Monday at 2.',
    { ...completeLead, preferredDate: null, preferredTime: null },
  );
  assert.equal(captured.preferredDate, '2026-08-03');
  assert.equal(captured.preferredTime, '2:00 PM');
  assert.equal(spokenPreferredDate(captured.preferredDate), 'Monday, August 3rd');
});

test('control speech and transcription artifacts are never captured as field answers', () => {
  assert.equal(isControlSpeech('Hello?'), true);
  assert.equal(isControlSpeech('Can you hear me?'), true);
  assert.equal(isControlSpeech('small paint repair'), false);
  assert.equal(isLikelyTranscriptionArtifact('A caller speaking with a residential painting company receptionist.'), true);
  const notes = captureDeterministicLead(coreStub, 'notes', 'Hello.', { ...completeLead, notes: null });
  assert.equal(notes.notes, null);
  assert.equal(
    controlSpeechReply(coreStub, 'notes', completeLead),
    "I'm here. Do you have any additional notes about this project?",
  );
});

test('deterministic facts survive a cancelled brain reply', () => {
  const before = { ...completeLead, preferredDate: null, preferredTime: null };
  const captured = captureDeterministicLead(coreStub, 'preferred_date_time', 'Probably Monday at 9.', before);
  assert.deepEqual(changedLeadFields(before, captured), ['preferredDate', 'preferredTime']);
  assert.equal(captured.preferredDate, '2026-08-03');
  assert.equal(captured.preferredTime, '9:00 AM');
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /lead\.deterministic_committed/);
  assert.match(controller, /durableLead: state\.lead/);
});

test('name and split address are committed deterministically', () => {
  let lead = captureDeterministicLead(coreStub, 'name', 'Andrew Christensen.', { ...completeLead, name: null, projectLocation: null });
  assert.equal(lead.name, 'Andrew Christensen');
  lead = captureDeterministicLead(coreStub, 'project_location', '197 Lancaster Road.', lead);
  assert.equal(baseQuestionFor(coreStub, 'project_location', lead), 'What city or town is the project in?');
  lead = captureDeterministicLead(coreStub, 'project_location', 'Berlin, Massachusetts.', lead);
  assert.equal(lead.projectLocation, '197 Lancaster Road, Berlin, Massachusetts');
});

test('notes correction reopens summary and can affirm remaining details', () => {
  const corrected = captureDeterministicLead(
    coreStub,
    'confirm_summary',
    "There were no additional notes, but other than that, yeah.",
    { ...completeLead, notes: 'Hello.' },
  );
  assert.equal(corrected.notes, 'none');
  assert.equal(callerAffirmsSummary("There were no additional notes, but other than that, yeah."), true);
  const memory = createCallMemory();
  memory.completedQuestionIds = ['service', 'name', 'project_location', 'preferred_date_time', 'notes', 'contact_consent', 'confirm_summary'];
  reopenConfirmation(memory);
  assert.equal(memory.completedQuestionIds.includes('confirm_summary'), false);
});

test('unfinished phrases are held until continuation arrives', () => {
  assert.equal(isObviouslyIncompleteTranscript('Um...'), true);
  assert.equal(shouldKeepHoldingFragment('Um...', 'Can I do...'), true);
  assert.equal(shouldKeepHoldingFragment('Um Can I do', 'Right.'), true);
  assert.equal(mergeCallerFragment('Um Can I do Right.', 'Tuesday at 4?'), 'Um Can I do Right. Tuesday at 4?');
});

test('state-machine guards prevent dead loops and completed-answer regressions', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /state\.memory\.leadSaved \? 'more_questions' : 'confirm_summary'/);
  assert.doesNotMatch(controller, /state\.memory\.leadSaved \? 'more_questions' : 'continue_estimate'/);
  assert.match(controller, /guard\.summary_reopened_after_change/);
  assert.match(controller, /guard\.summary_affirmation_committed/);
  assert.match(controller, /guard\.submit_before_confirmation_blocked/);
  assert.match(controller, /state\.memory\.estimateStarted && !state\.memory\.leadSaved/);
  assert.match(controller, /caller\.transcription_artifact_ignored/);
  assert.doesNotMatch(controller, /onSpeechStarted:\s*\(\) => \{\s*state\.turnRevision \+= 1/);
});

test('silence repeats use only the short, context-aware question', () => {
  assert.equal(repeatQuestionFor(coreStub, 'confirm_summary', completeLead), 'Does all of that sound right?');
  assert.equal(repeatQuestionFor(coreStub, 'preferred_date_time', completeLead), 'What is your preferred estimate date and time?');
  assert.match(read('voice-pipeline-controller.js'), /SILENCE_REPEAT_MS = 5000/);
});

test('generic hello cannot end a call or poison completion memory', () => {
  const brain = read('receptionist-brain.js');
  assert.match(brain, /guardUnexpectedEnd/);
  assert.match(brain, /completedQuestionIds: \[\.\.\.\(callMemory\?\.completedQuestionIds/);
  assert.match(brain, /Never end the call because the caller says "hello/);
});

test('submission speech and closing finish cleanly', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /Okay, great\. Sending it in now\./);
  assert.match(controller, /caller\.ignored_during_submission/);
  assert.match(controller, /endAfterPlaybackReason: 'completed'/);
  assert.match(controller, /playback\.completed_hangup/);
});
