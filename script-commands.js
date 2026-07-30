// Deterministic receptionist objectives, command definitions, and memory-box rules.
// This file is intentionally not connected to live calls yet.
// Live behavior will be moved here one reviewed piece at a time.

export const SCRIPT_COMMANDS = Object.freeze({
  offerEstimateRequest: 'offerEstimateRequest',
  collectFullName: 'collectFullName',
  collectService: 'collectService',
  collectProjectAddress: 'collectProjectAddress',
  collectEstimateSchedule: 'collectEstimateSchedule',
  collectAdditionalNotes: 'collectAdditionalNotes',
  collectContactConsent: 'collectContactConsent',
  confirmCollectedInformation: 'confirmCollectedInformation',
  submitEstimateRequest: 'submitEstimateRequest',
  answerBusinessQuestion: 'answerBusinessQuestion',
  returnToMissingQuestion: 'returnToMissingQuestion',
  repeatLastQuestion: 'repeatLastQuestion',
  checkCallerStillThere: 'checkCallerStillThere',
  warnCallEnding: 'warnCallEnding',
  finishCall: 'finishCall',
});

export const SCRIPT_COMMAND_STATUS = Object.freeze({
  notStarted: 'not-started',
  asked: 'asked',
  answered: 'answered',
  invalid: 'invalid',
  skipped: 'skipped',
  completed: 'completed',
  failed: 'failed',
});

export const RECEPTIONIST_OBJECTIVES = Object.freeze({
  primary: 'Guide the caller through a complete estimate request form using the approved blocks in receptionist-script.js.',
  secondary: 'Answer legitimate questions about the business using only information supplied by app-info-config.js.',
});

export const RECEPTIONIST_RULES = Object.freeze([
  'Speak naturally and identify yourself truthfully as an AI receptionist.',
  'Use app-info-config.js as the only source for the business name, AI name, services, hours, and all other business information.',
  'Never invent, assume, or lie about business information, caller answers, submission status, or system results.',
  'Only answer questions related to the business, its services, or the estimate-request process.',
  'Follow the approved intake order and do not skip an unanswered required question.',
  'Do not repeatedly ask a question after a valid answer has been stored.',
  'A question may be repeated when it was not answered, the response was unclear, or the caller asked a side question instead of answering it.',
  'When the caller asks a business question during intake, answer the question first, then return to the same unanswered intake question.',
  'Use the memory box as the source of truth for what was asked, what was answered, and what should happen next.',
  'Only say an estimate request was sent after the send-request command returns a confirmed success result.',
]);

export const QUESTION_KEYS = Object.freeze({
  estimateOffer: 'estimateOffer',
  fullName: 'fullName',
  service: 'service',
  projectAddress: 'projectAddress',
  estimateSchedule: 'estimateSchedule',
  additionalNotes: 'additionalNotes',
  contactConsent: 'contactConsent',
  finalConfirmation: 'finalConfirmation',
});

export const QUESTION_ORDER = Object.freeze([
  QUESTION_KEYS.estimateOffer,
  QUESTION_KEYS.fullName,
  QUESTION_KEYS.service,
  QUESTION_KEYS.projectAddress,
  QUESTION_KEYS.estimateSchedule,
  QUESTION_KEYS.additionalNotes,
  QUESTION_KEYS.contactConsent,
  QUESTION_KEYS.finalConfirmation,
]);

export const ANSWER_VALIDATION = Object.freeze({
  estimateOffer: Object.freeze({
    expected: 'A clear yes or no answer.',
    validExamples: Object.freeze(['yes', 'yeah', 'sure', 'no', 'not right now']),
  }),
  fullName: Object.freeze({
    expected: 'A plausible full name, normally two to four name words.',
    notes: 'Do not rely only on capitalization because speech transcription may not preserve it. Reject long sentences, questions, and unrelated statements as names.',
  }),
  service: Object.freeze({
    expected: 'A service that matches or clearly maps to one of the configured services from app-info-config.js.',
  }),
  projectAddress: Object.freeze({
    expected: 'One full project address. Do not ask for a phone number, email address, or ZIP code.',
  }),
  estimateSchedule: Object.freeze({
    expected: 'A preferred future estimate date and time within the configured estimate schedule.',
  }),
  additionalNotes: Object.freeze({
    expected: 'Optional project notes, or a clear answer that there are no additional notes.',
  }),
  contactConsent: Object.freeze({
    expected: 'A clear yes or no answer about permission for the business to contact the caller.',
  }),
  finalConfirmation: Object.freeze({
    expected: 'A clear confirmation or a correction to the collected information.',
  }),
});

export const MEMORY_BOX_RULES = Object.freeze({
  sourceOfTruth: 'The memory box, not model recollection, determines the current question and completed fields.',
  recordEveryAsk: true,
  recordEveryAnswer: true,
  timestampEvents: true,
  trackAskCount: true,
  preserveAnswerHistory: true,
  useMostRecentValidAnswer: true,
  behavior: Object.freeze([
    'Every time a question is spoken, append an asked event with the question key, exact question text, timestamp, and ask count.',
    'The next caller response must be attached to the question that was last asked and is still awaiting an answer.',
    'Store every caller response, including silence, unclear answers, side questions, invalid answers, and valid answers.',
    'If the caller asks a side question, answer it and then repeat the still-unanswered question.',
    'If a valid answer exists for a question, mark that question completed and move to the next incomplete question in QUESTION_ORDER.',
    'Never move forward merely because a question was asked; move forward only after a valid answer is recorded.',
    'Never move backward to a completed question unless the caller explicitly corrects that answer.',
    'If the estimate offer already has a valid yes, remain in the estimate-request process and never offer it again during that request.',
    'Before submitting, verify that every required question has a valid answer and that final confirmation is complete.',
  ]),
});

export const TIMING_RULES = Object.freeze({
  unansweredQuestionRepeatMs: 5000,
  holdWaitMs: 30000,
  callEndMs: 6 * 60 * 1000,
  callEndingWarningMs: 30 * 1000,
  behavior: Object.freeze([
    'If no caller response is received within five seconds, repeat the last unanswered question once.',
    'If the caller says hold on, wait a second, wait a minute, or similar, pause the unanswered-question timer for thirty seconds.',
    'After the thirty-second hold period, ask whether the caller is still there.',
    'The call-ending command must run at six minutes.',
    'Use the approved thirty-second warning statement before the six-minute call ending.',
  ]),
});

export const COMMAND_RULES = Object.freeze({
  sendRequest: Object.freeze({
    command: SCRIPT_COMMANDS.submitEstimateRequest,
    purpose: 'Send the completed estimate-request information to ARK Websites OCM.',
    requirements: Object.freeze([
      'All required fields have valid stored answers.',
      'Contact consent is granted.',
      'The caller confirmed the final read-back.',
    ]),
    successRule: 'Only use the submission-success script after the app confirms success.',
    failureRule: 'If the app does not confirm success, use the submission-failure script and never claim the request was sent.',
  }),
  finishCall: Object.freeze({
    command: SCRIPT_COMMANDS.finishCall,
    purpose: 'End the Telnyx call after the approved closing statement or when the six-minute limit is reached.',
  }),
});

export function createQuestionMemory(questionKey) {
  return {
    questionKey,
    status: SCRIPT_COMMAND_STATUS.notStarted,
    askCount: 0,
    lastAskedAt: null,
    lastAnsweredAt: null,
    awaitingAnswer: false,
    answers: [],
    latestValidAnswer: null,
  };
}

export function createScriptCommandState() {
  return {
    currentCommand: '',
    currentQuestionKey: QUESTION_KEYS.estimateOffer,
    commandHistory: [],
    questionMemory: Object.fromEntries(
      QUESTION_ORDER.map((questionKey) => [questionKey, createQuestionMemory(questionKey)]),
    ),
    submitConfirmed: false,
    submitSucceeded: false,
    submitFailed: false,
    callStartedAt: null,
    callEndsAt: null,
    holdUntil: null,
  };
}
