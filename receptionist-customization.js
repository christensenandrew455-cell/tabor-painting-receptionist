// Compatibility layer used by the live receptionist runtime.
// Business facts come from app-info-config.js.
// Caller-facing wording comes from receptionist-script.js.
// Objectives, rules, commands, timing, and memory-box behavior come from script-commands.js.

import {
  buildBusinessKnowledge,
  serviceListFromBusiness,
} from './app-info-config.js';
import { RECEPTIONIST_SCRIPT_SECTIONS } from './receptionist-script.js';
import {
  QUESTION_KEYS,
  QUESTION_ORDER,
  RECEPTIONIST_OBJECTIVES,
  RECEPTIONIST_RULES,
  MEMORY_BOX_RULES,
  TIMING_RULES,
  ANSWER_VALIDATION,
  commandRulesPrompt,
  createScriptCommandState,
} from './script-commands.js';

export const RECEPTIONIST_COMMANDS = Object.freeze({
  stages: Object.freeze({
    BEFORE_ESTIMATE: 'BEFORE_ESTIMATE',
    INTAKE: 'INTAKE',
    CONFIRMATION: 'CONFIRMATION',
    CONSENT: 'CONSENT',
    SAVING: 'SAVING',
    AFTER_ESTIMATE: 'AFTER_ESTIMATE',
    HOLD: 'HOLD',
    ENDING: 'ENDING',
  }),
  silenceReaskMs: TIMING_RULES.unansweredQuestionRepeatMs,
  holdCheckMs: TIMING_RULES.holdWaitMs,
  recentTurnLimit: 5,
});

export const CANCELLATION_PATTERN = /\b(?:i\s+(?:do\s+not|don't)\s+want\s+to\s+(?:do|continue|fill\s+(?:this|it)\s+out)|cancel\s+(?:the\s+)?(?:estimate|request)|forget\s+(?:the\s+)?estimate|i\s+changed\s+my\s+mind|do\s+not\s+submit|don't\s+submit|stop\s+(?:the\s+)?(?:estimate|request))\b/i;
export const HOLD_PATTERN = /\b(?:hold on|hang on|wait(?: a moment| a second| a minute)?|one (?:moment|second|minute)|give me (?:a|one) (?:moment|second|minute)|let me (?:check|think)|pause for (?:a|one) (?:moment|second|minute))\b/i;

export function holdAcknowledgementFor(value = '') {
  const text = String(value || '').toLowerCase();
  if (/minute/.test(text)) return "Okay, I'll give you a minute.";
  if (/second/.test(text)) return "Okay, I'll give you a second.";
  if (/moment|let me check|let me think/.test(text)) return "Okay, I'll give you a moment.";
  return "Okay, I'll wait.";
}

export const serviceList = serviceListFromBusiness;

function scriptValues(business = {}) {
  return {
    business_name: business.name || '',
    ai_name: business.receptionist || '',
    receptionist_name: business.receptionist || '',
    service_list: serviceListFromBusiness(business.services || {}),
    estimate_days: business.estimateDays || '',
    earliest_estimate_time: business.earliestEstimateStart || '',
    latest_estimate_time: business.latestEstimateStart || '',
  };
}

export function renderScript(value, business = {}) {
  if (Array.isArray(value)) return value.map((part) => renderScript(part, business)).join(' ');
  const values = scriptValues(business);
  return String(value || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const replacement = values[String(key).toLowerCase()];
    return replacement === undefined ? match : replacement;
  }).replace(/\s+/g, ' ').trim();
}

export function buildQuestionCatalog({ business }) {
  const script = RECEPTIONIST_SCRIPT_SECTIONS;
  return Object.freeze({
    estimate_offer: {
      stage: RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE,
      field: '',
      key: QUESTION_KEYS.estimateOffer,
      text: 'Would you like to submit an estimate request?',
      explanation: '',
    },
    full_name: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'fullName',
      key: QUESTION_KEYS.fullName,
      text: renderScript(script.fullNameQuestion, business),
      explanation: renderScript(script.fallbacks.whyReasons.fullName, business),
    },
    service_type: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'serviceType',
      key: QUESTION_KEYS.service,
      text: renderScript(script.serviceQuestion, business),
      explanation: renderScript(script.fallbacks.whyReasons.service, business),
    },
    project_location: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'projectLocation',
      key: QUESTION_KEYS.projectAddress,
      text: renderScript(script.projectAddressQuestion, business),
      explanation: renderScript(script.fallbacks.whyReasons.address, business),
    },
    city_or_town: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'cityOrTown',
      key: QUESTION_KEYS.projectAddress,
      text: 'What city or town is the project in?',
      explanation: renderScript(script.fallbacks.whyReasons.address, business),
    },
    state: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'state',
      key: QUESTION_KEYS.projectAddress,
      text: 'What state is the project in?',
      explanation: renderScript(script.fallbacks.whyReasons.address, business),
    },
    street_number: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'streetNumber',
      key: QUESTION_KEYS.projectAddress,
      text: 'What is the street number?',
      explanation: renderScript(script.fallbacks.whyReasons.address, business),
    },
    street_name: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'streetName',
      key: QUESTION_KEYS.projectAddress,
      text: 'What is the street name?',
      explanation: renderScript(script.fallbacks.whyReasons.address, business),
    },
    estimate_schedule: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'preferredSchedule',
      key: QUESTION_KEYS.estimateSchedule,
      text: renderScript(script.estimateScheduleQuestion, business),
      explanation: renderScript(script.fallbacks.whyReasons.schedule, business),
    },
    preferred_date: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'preferredDateOrDay',
      key: QUESTION_KEYS.estimateSchedule,
      text: 'What day would you prefer for the estimate?',
      explanation: renderScript(script.fallbacks.whyReasons.schedule, business),
    },
    preferred_time: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'preferredTime',
      key: QUESTION_KEYS.estimateSchedule,
      text: 'What time would you prefer for the estimate?',
      explanation: renderScript(script.fallbacks.whyReasons.schedule, business),
    },
    additional_notes_offer: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'additionalNotesRequested',
      key: QUESTION_KEYS.additionalNotes,
      text: renderScript(script.additionalNotesQuestion, business),
      explanation: 'Additional notes are optional and help the business understand anything else about the project.',
    },
    additional_notes_details: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'additionalNotes',
      key: QUESTION_KEYS.additionalNotes,
      text: 'What additional notes would you like me to include?',
      explanation: 'Additional notes are optional and will be included with the estimate request.',
    },
    contact_consent: {
      stage: RECEPTIONIST_COMMANDS.stages.CONSENT,
      field: 'contactConsent',
      key: QUESTION_KEYS.contactConsent,
      text: renderScript(script.contactConsentQuestion, business),
      explanation: renderScript(script.fallbacks.whyReasons.consent, business),
    },
    final_confirmation: {
      stage: RECEPTIONIST_COMMANDS.stages.CONFIRMATION,
      field: '',
      key: QUESTION_KEYS.finalConfirmation,
      text: renderScript(script.confirmationQuestion, business),
      explanation: '',
    },
    after_save: {
      stage: RECEPTIONIST_COMMANDS.stages.AFTER_ESTIMATE,
      field: '',
      text: renderScript(script.afterSubmissionQuestion, business),
      explanation: '',
    },
  });
}

function scriptPrompt(business = {}) {
  const script = RECEPTIONIST_SCRIPT_SECTIONS;
  const q = buildQuestionCatalog({ business });
  return [
    'APPROVED CALLER-FACING SCRIPT',
    `Opening: ${renderScript(script.opening, business)}`,
    `Full name: ${q.full_name.text}`,
    `Service: ${q.service_type.text}`,
    `Project address: ${q.project_location.text}`,
    `Estimate schedule: ${q.estimate_schedule.text}`,
    `Schedule notice: ${renderScript(script.estimateScheduleNotice, business)}`,
    `Additional notes: ${q.additional_notes_offer.text}`,
    `Contact consent: ${q.contact_consent.text}`,
    `Confirmation introduction: ${renderScript(script.confirmationIntro, business)}`,
    `Confirmation question: ${q.final_confirmation.text}`,
    `Submission start: ${renderScript(script.submissionStart, business)}`,
    `Submission success: ${renderScript(script.submissionSuccess, business)}`,
    `Submission failure: ${renderScript(script.submissionFailure, business)}`,
    `After submission: ${q.after_save.text}`,
    `General follow-up: ${renderScript(script.generalFollowUp, business)}`,
    `Closing: ${renderScript(script.closing, business)}`,
    '',
    'FALLBACKS',
    `Did not hear: ${renderScript(script.fallbacks.didNotHear, business)} Then repeat the same unanswered question.`,
    `Off topic: ${renderScript(script.fallbacks.offTopic, business)}`,
    `Identity: ${renderScript(script.fallbacks.identity, business)}`,
    `Unknown business information: ${renderScript(script.fallbacks.unknownBusinessInfo, business)}`,
    `Call-time warning: ${renderScript(script.fallbacks.callTimeWarning, business)}`,
  ].join('\n');
}

export function buildReceptionistPrompt({ business, currentDateLabel }) {
  return [
    'MASTER AI RECEPTIONIST SPECIFICATION',
    '',
    commandRulesPrompt(),
    '',
    scriptPrompt(business),
    '',
    'LIVE CONVERSATION RULES',
    '- Ask one question at a time and stop to listen.',
    '- Start every call with the approved opening exactly once.',
    '- Do not collect estimate fields until the caller agrees to submit an estimate request.',
    '- During intake, answer legitimate business questions briefly and then return to the same unanswered question.',
    '- Use the approved fixed wording for required questions. Natural short acknowledgments may come before them.',
    '- The project-address question asks for the full address in one step. Ask a missing component only if the answer is incomplete.',
    '- Never ask for a ZIP code, phone number, or email address.',
    '- After collecting schedule information, speak the approved schedule notice.',
    '- Additional notes are optional. A clear no completes that step.',
    '- Consent must be explicitly asked and answered. Record it before continuing.',
    '- Before submission, read back only the information actually collected and ask the approved confirmation question.',
    '- If the caller corrects information, change only that information and confirm the complete corrected summary again.',
    '- Call submit_estimate_lead only after all required information, consent, and final confirmation are complete.',
    '- Do not announce success until the server confirms success.',
    '- If submission fails, use the approved failure wording and do not restart intake or repeatedly request the address.',
    '- When the caller has no more business questions, call finish_call so the server can speak the approved closing and end the call.',
    '- The server controls five-second silence repeats, thirty-second hold checks, the six-minute limit, validation, duplicate prevention, and hangup.',
    '',
    `CURRENT BUSINESS DATE\n${currentDateLabel} in ${business.timeZone}.`,
    '',
    buildBusinessKnowledge(business),
  ].join('\n');
}

export function createCallMemory() {
  const commandState = createScriptCommandState();
  return {
    stage: RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE,
    lastQuestionId: '',
    lastQuestionText: '',
    currentField: '',
    estimateOfferCount: 0,
    intakeCancelled: false,
    leadSaved: false,
    fieldAnswers: {},
    recentCallerUtterances: [],
    recentAssistantUtterances: [],
    ...commandState,
  };
}

export function resetIntakeMemory(memory) {
  const fresh = createScriptCommandState();
  memory.stage = RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE;
  memory.lastQuestionId = '';
  memory.lastQuestionText = '';
  memory.currentField = '';
  memory.estimateOfferCount = 0;
  memory.intakeCancelled = true;
  memory.leadSaved = false;
  memory.fieldAnswers = {};
  memory.currentCommand = fresh.currentCommand;
  memory.currentQuestionKey = fresh.currentQuestionKey;
  memory.commandHistory = fresh.commandHistory;
  memory.questionMemory = fresh.questionMemory;
  memory.submitConfirmed = false;
  memory.submitSucceeded = false;
  memory.submitFailed = false;
  memory.holdUntil = null;
  return memory;
}

function pushRecent(list, value) {
  const text = String(value || '').trim();
  if (!text) return;
  list.push(text);
  while (list.length > RECEPTIONIST_COMMANDS.recentTurnLimit) list.shift();
}

export function rememberCaller(memory, transcript) {
  pushRecent(memory.recentCallerUtterances, transcript);
}

export function rememberAssistant(memory, transcript) {
  pushRecent(memory.recentAssistantUtterances, transcript);
}

export function callMemorySummary(memory) {
  const fields = Object.entries(memory.fieldAnswers || {})
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n') || '- none recorded';
  const questionState = QUESTION_ORDER.map((key) => {
    const entry = memory.questionMemory?.[key] || {};
    const latest = entry.latestValidAnswer ?? 'none';
    return `- ${key}: status=${entry.status || 'not-started'}, asked=${entry.askCount || 0}, awaiting=${entry.awaitingAnswer ? 'yes' : 'no'}, latest valid answer=${latest}`;
  }).join('\n');
  return [
    'CURRENT CALL MEMORY BOX',
    `Stage: ${memory.stage}`,
    `Last question ID: ${memory.lastQuestionId || 'none'}`,
    `Last question: ${memory.lastQuestionText || 'none'}`,
    `Current field: ${memory.currentField || 'none'}`,
    `Current question key: ${memory.currentQuestionKey || 'none'}`,
    `Estimate offered: ${memory.estimateOfferCount || 0} time(s)`,
    `Intake cancelled: ${memory.intakeCancelled ? 'yes' : 'no'}`,
    `Lead saved: ${memory.leadSaved ? 'yes' : 'no'}`,
    'Recorded field answers:',
    fields,
    'Question memory:',
    questionState,
    'Recent caller utterances:',
    (memory.recentCallerUtterances || []).map((value) => `- ${value}`).join('\n') || '- none',
    'Recent assistant utterances:',
    (memory.recentAssistantUtterances || []).map((value) => `- ${value}`).join('\n') || '- none',
    'Treat this server memory as the source of truth. Return to the exact last unanswered question after interruptions. Never skip consent, invent information, or claim a save succeeded without confirmation.',
  ].join('\n');
}

export {
  ANSWER_VALIDATION,
  MEMORY_BOX_RULES,
  QUESTION_KEYS,
  QUESTION_ORDER,
  RECEPTIONIST_OBJECTIVES,
  RECEPTIONIST_RULES,
  TIMING_RULES,
};
