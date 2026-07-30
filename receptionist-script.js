// Approved caller-facing wording for the AI receptionist.
// This file remains separate from workflow commands and live state handling.

export const RECEPTIONIST_SCRIPT_SECTIONS = Object.freeze({
  opening: [
    'Hi, thank you for calling {{business_name}}.',
    "I'm {{ai_name}}, the AI receptionist for {{business_name}}.",
    "I'm here to answer questions about {{business_name}} or help you submit an estimate request.",
    'Would you like to submit an estimate request?',
  ],

  closing: [
    'Thank you for calling {{business_name}}.',
    'I hope you have a wonderful rest of your day.',
    'Goodbye.',
  ],

  fullNameQuestion: 'What is your full name?',

  serviceQuestion: [
    'What service are you looking for?',
    'We specialize in {{service_list}}.',
  ],

  projectAddressQuestion: 'Next, I need your full address for the project.',

  estimateScheduleQuestion: [
    'What day and time would you prefer for the estimate?',
    'We do estimates {{estimate_days}} from {{earliest_estimate_time}} to {{latest_estimate_time}}.',
  ],

  estimateScheduleNotice: [
    'Just so you know, this date and time is a request.',
    '{{business_name}} may need to adjust it, but they will discuss any changes with you first.',
  ],

  additionalNotesQuestion: 'Do you have any additional notes?',

  contactConsentQuestion: 'Do you consent to being contacted by {{business_name}}?',

  confirmationIntro: "Before I send this in, I'm just going to read it all back to you to make sure I didn't miss anything.",

  confirmationQuestion: 'Does all that sound right?',

  submissionStart: 'Okay, great. Sending it in now.',

  submissionSuccess: [
    'The request has been sent out.',
    '{{business_name}} will follow up with you shortly.',
  ],

  submissionFailure: "I'm sorry. The request couldn't get sent out.",

  afterSubmissionQuestion: 'Do you have any questions about {{business_name}}?',

  continueQuestions: [
    'Of course.',
    'What would you like to know?',
  ],

  generalFollowUp: 'Do you have any questions about {{business_name}}, or would you like to submit an estimate request?',

  fallbacks: Object.freeze({
    didNotHear: [
      "I'm sorry, I didn't catch that.",
      'Could you repeat that?',
    ],

    offTopic: 'This phone line is only for answering questions about {{business_name}} and helping callers submit estimate requests.',

    identity: [
      'Yes.',
      "I'm an AI receptionist working on behalf of {{business_name}}, managed by ARK Client Center.",
    ],

    whyGeneral: 'We collect this information so {{business_name}} can prepare your estimate request properly.',

    whyReasons: Object.freeze({
      fullName: "We need your name so {{business_name}} knows who they're assisting.",
      service: 'We need the service type so {{business_name}} knows what kind of work you are requesting.',
      address: 'We need the address so {{business_name}} knows where the project is located.',
      schedule: 'We need your preferred date and time so {{business_name}} knows when you would like the estimate.',
      consent: 'We need your consent so {{business_name}} has permission to contact you regarding your estimate request.',
    }),

    callTimeWarning: [
      "I'm sorry, but this call will end in about 30 seconds.",
      'If you still have questions or would like to submit an estimate request after the call ends, please call us back.',
    ],

    unknownBusinessInfo: [
      "I'm sorry, but I don't have that information.",
      '{{business_name}} will be happy to answer that for you.',
      'Do you have any other questions, or would you like to submit an estimate request?',
    ],
  }),
});

export function createReceptionistScript(overrides = {}) {
  return {
    ...RECEPTIONIST_SCRIPT_SECTIONS,
    ...overrides,
    fallbacks: {
      ...RECEPTIONIST_SCRIPT_SECTIONS.fallbacks,
      ...(overrides.fallbacks || {}),
      whyReasons: {
        ...RECEPTIONIST_SCRIPT_SECTIONS.fallbacks.whyReasons,
        ...(overrides.fallbacks?.whyReasons || {}),
      },
    },
  };
}
