import { PHRASE_KEYS, receptionistPhrase } from './receptionist-phrases.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function availabilityStatement(core) {
  return receptionistPhrase(core, PHRASE_KEYS.ESTIMATE_DATE_TIME);
}

export function summaryStatement(lead = {}, core = null) {
  if (!core) {
    const notes = clean(lead.notes);
    const notesSummary = notes && notes.toLowerCase() !== 'none'
      ? `The additional notes are: ${notes}.`
      : 'There are no additional notes.';
    return clean(`Let me read that back. I have ${lead.name} requesting ${lead.service} at ${lead.projectLocation}, with the estimate date and time requested for ${lead.preferredDate} at ${lead.preferredTime}. ${notesSummary}`);
  }
  return receptionistPhrase(core, PHRASE_KEYS.FINAL_CONFIRMATION, lead)
    .replace(/\s*Does all of that sound right\?$/i, '')
    .trim();
}

export function baseQuestionFor(core, questionId, lead = {}) {
  const keyByQuestion = {
    ask_estimate: PHRASE_KEYS.ESTIMATE_OFFER,
    continue_estimate: PHRASE_KEYS.CONTINUE_ESTIMATE,
    more_questions: PHRASE_KEYS.MORE_QUESTIONS,
    service: PHRASE_KEYS.SERVICE,
    name: PHRASE_KEYS.FULL_NAME,
    callback_phone: PHRASE_KEYS.CALLBACK_PHONE,
    project_location: PHRASE_KEYS.PROJECT_ADDRESS,
    preferred_date_time: PHRASE_KEYS.ESTIMATE_DATE_TIME,
    notes: PHRASE_KEYS.ADDITIONAL_NOTES,
    contact_consent: PHRASE_KEYS.CONTACT_CONSENT,
    confirm_summary: PHRASE_KEYS.FINAL_CONFIRMATION,
    clarify: PHRASE_KEYS.CLARIFY,
  };
  const key = keyByQuestion[questionId];
  return key ? receptionistPhrase(core, key, lead) : '';
}

export function repeatQuestionFor(core, questionId, lead = {}) {
  return baseQuestionFor(core, questionId, lead);
}

export function sanitizeIntakePreface() {
  return '';
}

export function assembleIntakeReply(core, _modelReply, questionId, lead = {}) {
  return baseQuestionFor(core, questionId, lead);
}
