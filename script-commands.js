// Home for deterministic receptionist commands and state transitions.
// Live command logic will be moved here one piece at a time after review.

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

export function createScriptCommandState() {
  return {
    currentCommand: '',
    commandHistory: [],
    answers: {},
    submitConfirmed: false,
    submitSucceeded: false,
    submitFailed: false,
  };
}
