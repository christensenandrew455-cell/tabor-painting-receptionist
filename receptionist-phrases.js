function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function render(template, values = {}) {
  return clean(String(template || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const value = values[String(key).toLowerCase()];
    return value === undefined || value === null ? match : String(value);
  }));
}

export const PHRASE_KEYS = Object.freeze({
  OPENING: 'OPENING_01',
  CLOSING: 'CLOSING_01',
  ESTIMATE_OFFER: 'QUESTION_ESTIMATE_OFFER',
  CONTINUE_ESTIMATE: 'QUESTION_CONTINUE_ESTIMATE',
  MORE_QUESTIONS: 'QUESTION_MORE_QUESTIONS',
  SERVICE: 'QUESTION_SERVICE',
  FULL_NAME: 'QUESTION_FULL_NAME',
  CALLBACK_PHONE: 'QUESTION_CALLBACK_PHONE',
  PROJECT_ADDRESS: 'QUESTION_PROJECT_ADDRESS',
  PROJECT_ADDRESS_FULL: 'QUESTION_PROJECT_ADDRESS_FULL',
  ESTIMATE_DATE: 'QUESTION_ESTIMATE_DATE',
  ESTIMATE_TIME: 'QUESTION_ESTIMATE_TIME',
  ADDITIONAL_NOTES: 'QUESTION_ADDITIONAL_NOTES',
  CONTACT_CONSENT: 'QUESTION_CONTACT_CONSENT',
  CONSENT_DECLINED: 'RESPONSE_CONSENT_DECLINED',
  FINAL_CONFIRMATION: 'QUESTION_FINAL_CONFIRMATION',
  CLARIFY: 'QUESTION_CLARIFY',
  ACK_SORRY: 'ACK_SORRY',
  ACK_GOOD: 'ACK_GOOD',
  ACK_THANKS: 'ACK_THANKS',
  ACK_THANKS_NAME: 'ACK_THANKS_NAME',
  ACK_GOT_IT: 'ACK_GOT_IT',
  STILL_HERE_WITH_QUESTION: 'RESPONSE_STILL_HERE_WITH_QUESTION',
  UNEXPECTED_END_MORE_QUESTIONS: 'RESPONSE_UNEXPECTED_END_MORE_QUESTIONS',
  UNEXPECTED_END_CLARIFY: 'RESPONSE_UNEXPECTED_END_CLARIFY',
  RESTART_BLOCKED: 'RESPONSE_RESTART_BLOCKED',
  AI_IDENTITY: 'RESPONSE_AI_IDENTITY',
  SUBMISSION_START: 'RESPONSE_SUBMISSION_START',
  SUBMISSION_SUCCESS: 'RESPONSE_SUBMISSION_SUCCESS',
  SUBMISSION_FAILURE: 'RESPONSE_SUBMISSION_FAILURE',
  VALIDATION_NAME: 'VALIDATION_NAME',
  VALIDATION_CALLBACK_PHONE: 'VALIDATION_CALLBACK_PHONE',
  VALIDATION_SERVICE: 'VALIDATION_SERVICE',
  VALIDATION_PROJECT_ADDRESS: 'VALIDATION_PROJECT_ADDRESS',
  VALIDATION_ESTIMATE_DATE: 'VALIDATION_ESTIMATE_DATE',
  VALIDATION_ESTIMATE_TIME: 'VALIDATION_ESTIMATE_TIME',
  VALIDATION_CONTACT_CONSENT: 'VALIDATION_CONTACT_CONSENT',
  CALL_TIME_WARNING: 'CALL_TIME_WARNING',
  OFF_TOPIC: 'OFF_TOPIC',
  WHY_SERVICE: 'WHY_SERVICE',
  WHY_NAME: 'WHY_NAME',
  WHY_PROJECT_ADDRESS: 'WHY_PROJECT_ADDRESS',
  WHY_ESTIMATE_DATE_TIME: 'WHY_ESTIMATE_DATE_TIME',
  WHY_CONTACT_CONSENT: 'WHY_CONTACT_CONSENT',
  UNKNOWN_INFORMATION: 'UNKNOWN_INFORMATION',
});

export const RECEPTIONIST_PHRASES = Object.freeze({
  OPENING_01: "Hi, thank you for calling {{business_name}}. I'm Arc, the receptionist. Would you like to fill out an estimate request, or do you have a question about the business?",
  CLOSING_01: 'Okay. Thank you for calling {{business_name}}. Goodbye.',

  QUESTION_ESTIMATE_OFFER: 'Would you like to fill out an estimate request?',
  QUESTION_CONTINUE_ESTIMATE: 'Would you like to continue filling out your estimate request, or do you have any more questions?',
  QUESTION_MORE_QUESTIONS: 'Do you have any more questions about {{business_name}}?',
  QUESTION_SERVICE: 'What service do you need?',
  QUESTION_FULL_NAME: 'What is your full name?',
  QUESTION_CALLBACK_PHONE: 'What phone number should the business use to call you back?',
  QUESTION_PROJECT_ADDRESS: 'What is the full project address, including the street number, street name, city or town, and state?',
  QUESTION_PROJECT_ADDRESS_FULL: 'I still need the street number, street name, city or town, and state.',
  QUESTION_ESTIMATE_DATE: 'What specific date would you prefer for the estimate? We schedule estimates {{estimate_days}}.',
  QUESTION_ESTIMATE_TIME: 'What specific time would you prefer? Available estimate times are from {{earliest_estimate_time}} through {{latest_estimate_time}}.',
  QUESTION_ADDITIONAL_NOTES: 'Do you have any additional notes about the project?',
  QUESTION_CONTACT_CONSENT: 'Do you consent to being contacted by {{business_name}}?',
  QUESTION_FINAL_CONFIRMATION: 'Let me read that back. I have {{full_name}}, callback number {{callback_phone}}, requesting {{service}} at {{project_address}}, with the estimate requested for {{requested_date}} at {{requested_time}}. {{notes_summary}} You consent to being contacted by {{business_name}}. Is all of that correct, and should I submit it?',
  QUESTION_CLARIFY: "I'm sorry, I didn't catch that. Could you repeat that?",

  ACK_SORRY: "I'm sorry about that.",
  ACK_GOOD: 'That sounds good.',
  ACK_THANKS: 'Thanks.',
  ACK_THANKS_NAME: 'Thanks, {{first_name}}.',
  ACK_GOT_IT: 'Got it.',

  RESPONSE_STILL_HERE_WITH_QUESTION: "I'm here. {{current_question}}",
  RESPONSE_UNEXPECTED_END_MORE_QUESTIONS: "I'm still here. Do you have any more questions about {{business_name}}?",
  RESPONSE_UNEXPECTED_END_CLARIFY: "I'm still here. Could you repeat that?",
  RESPONSE_RESTART_BLOCKED: 'You can update any information before the request is submitted.',
  RESPONSE_AI_IDENTITY: 'I am an AI receptionist working for {{business_name}}, managed by Arc Client Center.',
  RESPONSE_CONSENT_DECLINED: 'Not consenting to being contacted will result in your estimate request being deleted. Do you consent to being contacted by {{business_name}}?',

  RESPONSE_SUBMISSION_START: 'Okay. Submitting your request now.',
  RESPONSE_SUBMISSION_SUCCESS: 'Thank you. I have submitted your estimate request to {{business_name}} for review.',
  RESPONSE_SUBMISSION_FAILURE: "I'm sorry. I couldn't confirm that the request was saved, so I have not marked it submitted.",

  VALIDATION_NAME: "Sorry, that's not going to work. I still need both your first and last name.",
  VALIDATION_CALLBACK_PHONE: "Sorry, that's not going to work. I still need a valid callback phone number.",
  VALIDATION_SERVICE: "Sorry, that's not going to work. I still need a service offered by {{business_name}}.",
  VALIDATION_PROJECT_ADDRESS: "Sorry, that's not going to work. I still need the street number, street name, city or town, and state.",
  VALIDATION_ESTIMATE_DATE: "Sorry, that's not going to work. I still need a specific upcoming date within the estimate schedule.",
  VALIDATION_ESTIMATE_TIME: "Sorry, that's not going to work. I still need a specific time within the estimate schedule.",
  VALIDATION_CONTACT_CONSENT: "Sorry, that's not going to work. I still need a clear yes or no.",

  CALL_TIME_WARNING: "I'm sorry. But this call will abruptly end in about thirty seconds to prevent spamming.",

  OFF_TOPIC: 'I can help with an estimate request or answer questions about {{business_name}}.',
  WHY_SERVICE: 'We need the service so {{business_name}} can determine whether the project is something it offers.',
  WHY_NAME: 'We need your name to identify your estimate request.',
  WHY_PROJECT_ADDRESS: 'We need the full project address so {{business_name}} knows where the project is located.',
  WHY_ESTIMATE_DATE_TIME: 'We need a specific date and time request so {{business_name}} knows when you would prefer the estimate.',
  WHY_CONTACT_CONSENT: 'We need your consent before {{business_name}} can contact you about the request.',
  UNKNOWN_INFORMATION: "I don't have that information, but {{business_name}} can review your question after an estimate request is submitted.",
});

export function phraseValues(core, lead = {}, extra = {}) {
  const notes = clean(lead.notes);
  return {
    business_name: clean(core?.BUSINESS?.name),
    receptionist_name: clean(core?.BUSINESS?.receptionist),
    estimate_days: clean(core?.BUSINESS?.estimateDays),
    earliest_estimate_time: clean(core?.BUSINESS?.earliestEstimateStart),
    latest_estimate_time: clean(core?.BUSINESS?.latestEstimateStart),
    full_name: clean(lead.name),
    first_name: clean(lead.name).split(/\s+/)[0] || '',
    callback_phone: clean(lead.callbackPhone),
    service: clean(lead.service),
    project_address: clean(lead.projectLocation),
    requested_date: clean(lead.preferredDate),
    requested_time: clean(lead.preferredTime),
    additional_notes: notes,
    notes_summary: notes && notes.toLowerCase() !== 'none'
      ? `The additional notes are: ${notes}.`
      : 'There are no additional notes.',
    ...extra,
  };
}

export function receptionistPhrase(core, key, lead = {}, extra = {}) {
  const template = RECEPTIONIST_PHRASES[key];
  if (!template) throw new Error(`Unknown receptionist phrase key: ${key}`);
  return render(template, phraseValues(core, lead, extra));
}
