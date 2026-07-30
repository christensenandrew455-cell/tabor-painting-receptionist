// Home for the caller-facing AI receptionist script.
// This file is intentionally not connected to live calls yet.
// The script will be built here step by step from the user's approved wording.

export const RECEPTIONIST_SCRIPT_SECTIONS = Object.freeze({
  opening: '',
  estimateOffer: '',
  fullNameQuestion: '',
  serviceQuestion: '',
  projectAddressQuestion: '',
  estimateScheduleQuestion: '',
  additionalNotesQuestion: '',
  contactConsentQuestion: '',
  confirmationSummary: '',
  submissionSuccess: '',
  submissionFailure: '',
  afterSubmissionQuestion: '',
  closing: '',
  fallbacks: {},
});

export function createReceptionistScript(overrides = {}) {
  return {
    ...RECEPTIONIST_SCRIPT_SECTIONS,
    ...overrides,
    fallbacks: {
      ...RECEPTIONIST_SCRIPT_SECTIONS.fallbacks,
      ...(overrides.fallbacks || {}),
    },
  };
}
