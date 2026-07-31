import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { businessInfoFromAppProfile, runtimeEnvironmentFromApp } from '../app-info-config.js';
import { pcm24kToPcmu8k, splitPcmuFrames } from '../audio-codec.js';
import {
  baseQuestionFor,
  captureDeterministicLead,
  enforceQuestionBlock,
  isObviouslyIncompleteTranscript,
  mergeCallerFragment,
  nextRequiredQuestion,
  repeatQuestionFor,
  shouldKeepHoldingFragment,
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
});

const completeLead = Object.freeze({
  name: 'Andrew Christensen',
  service: 'interior painting',
  projectLocation: '197 Lancaster Road, Berlin, Massachusetts',
  preferredDate: 'Tuesday',
  preferredTime: '4:00 PM',
  notes: 'none',
  contactConsent: true,
});

test('production starts the modular server with the Telnyx stream linker and keeps legacy explicit', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.main, 'server-modular.js');
  assert.equal(packageJson.scripts.start, 'node --import ./stream-call-link.js server-modular.js');
  assert.match(packageJson.scripts['start:legacy'], /server\.js$/);
  assert.match(packageJson.scripts.check, /modular-intake-logic\.js/);
});

test('the Telnyx stream linker carries the call ID and locks clean PCMU transport', () => {
  const linker = read('stream-call-link.js');
  assert.match(linker, /searchParams\.set\('callControlId', callControlId\)/);
  assert.match(linker, /searchParams\.get\('callControlId'\)/);
  assert.match(linker, /message\.call_control_id = message\.call_control_id \|\| linkedCallControlId/);
  assert.match(linker, /stream_bidirectional_codec: 'PCMU'/);
  assert.match(linker, /stream_bidirectional_sampling_rate: 8000/);
  assert.match(linker, /stream_bidirectional_target_legs: 'self'/);
  assert.match(linker, /send_silence_when_idle: true/);
});

test('the transcriber uses a realtime session with input transcription enabled', () => {
  const voice = read('openai-voice.js');
  assert.doesNotMatch(voice, /OpenAI-Beta/);
  assert.match(voice, /wss:\/\/api\.openai\.com\/v1\/realtime\?model=\$\{encodeURIComponent\(MODELS\.transcriptionSession\)\}/);
  assert.doesNotMatch(voice, /realtime\?model=\$\{encodeURIComponent\(MODELS\.transcription\)\}/);
  assert.match(voice, /session:[\s\S]*type: 'realtime'/);
  assert.match(voice, /transcription:[\s\S]*model: MODELS\.transcription/);
  assert.match(voice, /create_response: false/);
  assert.match(voice, /interrupt_response: false/);
});

test('24 kHz PCM silence becomes one clean 20 ms PCMU telephone frame', () => {
  const twentyMillisecondsOfPcm24k = Buffer.alloc(480 * 2);
  const pcmu = pcm24kToPcmu8k(twentyMillisecondsOfPcm24k);
  assert.equal(pcmu.length, 160);
  assert.ok(pcmu.every((value) => value === 0xff));
  const frames = splitPcmuFrames(pcmu);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 160);
});

test('each OpenAI model has exactly one fixed job', () => {
  assert.equal(MODELS.transcriptionSession, 'gpt-realtime-mini');
  assert.equal(MODELS.transcription, 'gpt-4o-mini-transcribe');
  assert.equal(MODELS.brain, 'gpt-4.1-mini');
  assert.equal(MODELS.speech, 'gpt-4o-mini-tts');
});

test('OCM business data cannot override models or the Tabor opening and closing', () => {
  const environment = runtimeEnvironmentFromApp({ profile: businessProfile, clientId: 'tabor-painting' });
  const business = businessInfoFromAppProfile(businessProfile);
  assert.equal(environment.AI_MODEL, 'gpt-realtime-mini');
  assert.equal(environment.AI_VOICE, 'alloy');
  assert.doesNotMatch(environment.BUSINESS_INFO, /OCM must not control/);
  assert.notEqual(business.openingLine, businessProfile.openingLine);
  assert.notEqual(business.closingLine, businessProfile.closingLine);
});

test('the structured memory box starts with a counter for every question', () => {
  const memory = createCallMemory();
  assert.deepEqual(Object.keys(memory.askedCounts), [...QUESTION_IDS]);
  assert.equal(memory.currentQuestionId, 'none');
  assert.deepEqual(memory.completedQuestionIds, []);
  assert.equal(memory.estimateStarted, false);
  assert.equal(memory.leadSaved, false);
});

test('field blocks sound natural, include required context, and end at the question mark', () => {
  const serviceBlock = baseQuestionFor(coreStub, 'service', completeLead);
  assert.equal(
    serviceBlock,
    'Next, we need to collect the service you need. Which service is this for: wood staining, exterior painting, interior painting, or small paint repair?',
  );

  const dateBlock = baseQuestionFor(coreStub, 'preferred_date_time', completeLead);
  assert.match(dateBlock, /^Estimate appointments are available Monday through Friday from 9:00 AM through 4:00 PM\./);
  assert.match(dateBlock, /What is your preferred estimate date and time\?$/);

  const notesBlock = baseQuestionFor(coreStub, 'notes', completeLead);
  assert.equal(notesBlock, "Before I send the request, is there anything else you'd like the estimator to know about the project?");

  const summaryBlock = baseQuestionFor(coreStub, 'confirm_summary', completeLead);
  assert.match(summaryBlock, /^Let me read that back\./);
  assert.match(summaryBlock, /Andrew Christensen requesting interior painting/);
  assert.match(summaryBlock, /197 Lancaster Road, Berlin, Massachusetts/);
  assert.match(summaryBlock, /Tuesday at 4:00 PM/);
  assert.match(summaryBlock, /There are no additional notes\./);
  assert.match(summaryBlock, /Does all of that sound right\?$/);

  const corrected = enforceQuestionBlock(
    coreStub,
    'Our estimate availability is Monday through Friday from 9 AM to 4 PM. Could you choose another time?',
    'preferred_date_time',
    completeLead,
  );
  assert.equal((corrected.match(/Estimate appointments are available/g) || []).length, 1);
  assert.match(corrected, /What is your preferred estimate date and time\?$/);
});

test('the estimate order cannot skip notes, consent, or the complete summary', () => {
  const memory = createCallMemory();
  memory.estimateStarted = true;
  memory.completedQuestionIds = ['service', 'name', 'project_location', 'preferred_date_time'];
  assert.equal(nextRequiredQuestion(memory, completeLead), 'notes');
  memory.completedQuestionIds.push('notes');
  assert.equal(nextRequiredQuestion(memory, completeLead), 'contact_consent');
  memory.completedQuestionIds.push('contact_consent');
  assert.equal(nextRequiredQuestion(memory, completeLead), 'confirm_summary');
  memory.completedQuestionIds.push('confirm_summary');
  assert.equal(nextRequiredQuestion(memory, completeLead), 'none');
});

test('modular lead fields map into the validator and OCM schema', () => {
  const mapped = validationLeadFromModular(completeLead);
  assert.deepEqual(mapped, {
    fullName: 'Andrew Christensen',
    serviceType: 'interior painting',
    streetNumber: '197',
    streetName: 'Lancaster Road',
    cityOrTown: 'Berlin',
    state: 'Massachusetts',
    preferredDateOrDay: 'Tuesday',
    preferredTime: '4:00 PM',
    additionalNotes: 'none',
    contactConsent: true,
  });
});

test('the requested weekday is the final relevant weekday mentioned by the caller', () => {
  const captured = captureDeterministicLead(
    coreStub,
    'preferred_date_time',
    'Today is Friday, so probably Monday at 2.',
    { ...completeLead, preferredDate: null, preferredTime: null },
  );
  assert.equal(captured.preferredDate, 'Monday');
  assert.equal(captured.preferredTime, '2:00 PM');

  const outsideHours = captureDeterministicLead(
    coreStub,
    'preferred_date_time',
    'Tuesday at 5?',
    { ...completeLead, preferredDate: null, preferredTime: null },
  );
  assert.equal(outsideHours.preferredDate, 'Tuesday');
  assert.equal(outsideHours.preferredTime, null);
});

test('unfinished caller phrases are held across filler turns until the real answer arrives', () => {
  assert.equal(isObviouslyIncompleteTranscript('Um...'), true);
  assert.equal(shouldKeepHoldingFragment('Um...', 'Can I do...'), true);
  assert.equal(shouldKeepHoldingFragment('Um Can I do', 'Right.'), true);
  assert.equal(mergeCallerFragment('Um Can I do Right.', 'Tuesday at 4?'), 'Um Can I do Right. Tuesday at 4?');
});

test('identity, stale-turn cancellation, field order, and failed-save guards are hard enforced', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /IDENTITY_PATTERN/);
  assert.match(controller, /FALSE_HUMAN_CLAIM_PATTERN/);
  assert.match(controller, /guard\.stale_turn_discarded/);
  assert.match(controller, /guard\.field_order_enforced/);
  assert.match(controller, /validationLeadFromModular\(state\.lead\)/);
  assert.match(controller, /guard\.submit_before_complete_blocked/);
  assert.match(controller, /shouldEndCall = false/);
  assert.match(controller, /lead\.validation_failed/);
});

test('five-second silence repeats use only the short question', () => {
  assert.equal(repeatQuestionFor(coreStub, 'confirm_summary'), 'Does all of that sound right?');
  assert.equal(repeatQuestionFor(coreStub, 'preferred_date_time'), 'What is your preferred estimate date and time?');
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /SILENCE_REPEAT_MS = 5000/);
  assert.match(controller, /repeatQuestionFor\(runtime\.core, questionId\)/);
  assert.match(controller, /silence\.base_question_repeat/);
});

test('a generic hello can never close a follow-up-question call', () => {
  const brain = read('receptionist-brain.js');
  assert.match(brain, /EXPLICIT_GOODBYE_PATTERN/);
  assert.match(brain, /NO_MORE_QUESTIONS_PATTERN/);
  assert.match(brain, /guardUnexpectedEnd/);
  assert.match(brain, /I'm still here\. Do you have any more questions about/);
  assert.match(brain, /Never end the call because the caller says \\"hello/);
});

test('successful save wording explicitly says submitted and sent', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /your estimate request has been submitted and sent/);
});

test('the closing hangs up only after its audio playback completes', () => {
  const controller = read('voice-pipeline-controller.js');
  assert.match(controller, /endAfterPlaybackReason: 'completed'/);
  assert.match(controller, /playback\.completed_hangup/);
  assert.match(controller, /endCall\?\.\(endReason\)/);
});

test('the brain requires notes, full readback, availability, and save-before-close behavior', () => {
  const brain = read('receptionist-brain.js');
  assert.match(brain, /Never skip the notes question/);
  assert.match(brain, /always state the configured estimate availability/);
  assert.match(brain, /read back the caller's name, service, full project address/);
  assert.match(brain, /When submitLead is true, endCall must be false/);
});

test('the production server uses the modular pipeline and never opens a reasoning Realtime socket', () => {
  const server = read('server-modular.js');
  assert.match(server, /createVoicePipeline/);
  assert.match(server, /transcribe -> brain -> tts/);
  assert.doesNotMatch(server, /createOpenAiSocket/);
  assert.doesNotMatch(server, /response\.create/);
  assert.doesNotMatch(server, /gpt-realtime-mini/);
});
