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
  PROJECT_ADDRESS: 'QUESTION_PROJECT_ADDRESS',
  PROJECT_ADDRESS_FULL: 'QUESTION_PROJECT_ADDRESS_FULL',
  ESTIMATE_DATE_TIME: 'QUESTION_ESTIMATE_DATE_TIME',
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
  VALIDATION_SERVICE: 'VALIDATION_SERVICE',
  VALIDATION_PROJECT_ADDRESS: 'VALIDATION_PROJECT_ADDRESS',
  VALIDATION_ESTIMATE_DATE_TIME: 'VALIDATION_ESTIMATE_DATE_TIME',
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
  OPENING_01: "Hi, thank you for calling {{business_name}}. I'm {{receptionist_name}}, the automated receptionist. I can help submit an estimate request. Would you like to start?",
  CLOSING_01: 'Okay. Thank you for calling {{business_name}}. Have a good day.',

  QUESTION_ESTIMATE_OFFER: 'Would you like to submit an estimate request?',
  QUESTION_CONTINUE_ESTIMATE: 'Would you like to continue your estimate request?',
  QUESTION_MORE_QUESTIONS: 'Do you have any more questions about {{business_name}}?',
  QUESTION_SERVICE: 'What service do you need?',
  QUESTION_FULL_NAME: 'What is your full name?',
  QUESTION_PROJECT_ADDRESS: 'What is the project address, including the street number and name, city or town, and state? You may also include a unit and ZIP code.',
  QUESTION_PROJECT_ADDRESS_FULL: 'We need the state, city or town, street name, and street number.',
  QUESTION_ESTIMATE_DATE_TIME: 'Next, we need a date and time request for the estimate. We schedule estimates {{estimate_days}} from {{earliest_estimate_time}} to {{latest_estimate_time}}.',
  QUESTION_ADDITIONAL_NOTES: 'Now do you have any notes about the project?',
  QUESTION_CONTACT_CONSENT: 'Do you give {{business_name}} permission to contact you about this request?',
  QUESTION_FINAL_CONFIRMATION: 'Let me read that back. I have {{full_name}} requesting {{service}} at {{project_address}}, with the estimate requested for {{requested_date}} at {{requested_time}}. {{notes_summary}} You have agreed that {{business_name}} may contact you. Is that correct, and should I submit it?',
  QUESTION_CLARIFY: "I'm sorry, I didn't catch that. Could you repeat that?",

  ACK_SORRY: "I'm sorry about that.",
  ACK_GOOD: 'That sounds good.',
  ACK_THANKS: 'Thanks.',
  ACK_THANKS_NAME: 'Thanks, {{first_name}}.',
  ACK_GOT_IT: 'Got it.',

  RESPONSE_STILL_HERE_WITH_QUESTION: "I'm here. {{current_question}}",
  RESPONSE_UNEXPECTED_END_MORE_QUESTIONS: "I'm still here. Do you have any more questions about {{business_name}}?",
  RESPONSE_UNEXPECTED_END_CLARIFY: "I'm still here. Could you repeat that?",
  RESPONSE_RESTART_BLOCKED: 'You can update the estimate request information when I summarize it at the end.',
  RESPONSE_AI_IDENTITY: 'I am the automated receptionist for {{business_name}}, managed by ARK client center.',
  RESPONSE_CONSENT_DECLINED: "Understood. I won't submit the request without permission to contact you.",

  RESPONSE_SUBMISSION_START: 'Okay. Submitting your request now.',
  RESPONSE_SUBMISSION_SUCCESS: 'Your estimate request has been submitted. {{business_name}} will follow up with you shortly.',
  RESPONSE_SUBMISSION_FAILURE: "I'm sorry. I couldn't confirm that the request was saved, so I have not marked it submitted.",

  VALIDATION_NAME: 'I still need both your first and last name.',
  VALIDATION_SERVICE: 'I still need the service you want.',
  VALIDATION_PROJECT_ADDRESS: 'I still need the street address, city or town, and state.',
  VALIDATION_ESTIMATE_DATE_TIME: 'I still need an upcoming date and a time within the estimate schedule.',
  VALIDATION_CONTACT_CONSENT: 'I still need a clear yes or no before {{business_name}} can contact you.',

  CALL_TIME_WARNING: "I'm sorry. But this call will abruptly end in about thirty seconds to prevent spamming.",

  OFF_TOPIC: 'This number is strictly for answering questions and helping to guide you through an estimate request. Please use it only for that.',
  WHY_SERVICE: 'We collect this information so {{business_name}} knows what service you need.',
  WHY_NAME: 'We collect this information so {{business_name}} knows who you are.',
  WHY_PROJECT_ADDRESS: 'We collect this information so {{business_name}} knows where the project is.',
  WHY_ESTIMATE_DATE_TIME: 'We collect this information so {{business_name}} knows when you would like them to arrive.',
  WHY_CONTACT_CONSENT: 'We need your consent so {{business_name}} can contact you.',
  UNKNOWN_INFORMATION: "I'm sorry it seems I don't know that one. You'll have to submit an estimate request and ask it then.",
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
