import {
  assembleIntakeReply,
  availabilityStatement,
  baseQuestionFor,
  repeatQuestionFor,
  summaryStatement,
} from './intake-response-policy.js';

export { availabilityStatement, baseQuestionFor, repeatQuestionFor, summaryStatement };

const WEEKDAY_PATTERN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const MONTH_DAY_PATTERN = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+\d{4})?\b/i;
const ORDINAL_DAY_PATTERN = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i;
const HESITATION_PATTERN = /^(?:uh|um|erm|hmm|well|so|and|like)[.!?…\s]*$/i;
const CONTINUATION_FILLER_PATTERN = /^(?:uh|um|erm|hmm|well|so|and|like|right|yeah|yep|okay|ok)[.!?…\s]*$/i;
const INCOMPLETE_PATTERN = /^(?:(?:uh|um|erm|hmm|well|so|and)\s*)?(?:(?:that|it|this|the address|my address|the date|the time|my name|can i do)\s*)?(?:(?:would be|is|is at|is on|would be at|would be on)\s*)?$/i;
const CONTROL_SPEECH_PATTERN = /^(?:hello|hello there|hi|hey|are you there|you there|can you hear me|do you hear me|are you listening|still there|i'm here|im here)[?!.\s]*$/i;
const NO_NOTES_PATTERN = /\b(?:no additional notes?|no notes?|there (?:was|were|are|is) no additional notes?|nothing else|none|nope|that's all|that is all)\b/i;
const AFFIRMATIVE_PATTERN = /\b(?:yes|yeah|yep|sure|correct|right|okay|ok|sounds good|that's right|that is right|other than that|otherwise)\b/i;

export const ESTIMATE_ORDER = Object.freeze([
  'service',
  'name',
  'project_location',
  'preferred_date_time',
  'notes',
  'contact_consent',
  'confirm_summary',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function serviceNames(core) {
  return Object.keys(core.BUSINESS.services || {});
}

export function mergeLead(current = {}, updates = {}) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(updates || {})) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
    if (key === 'contactConsent' && typeof value === 'boolean') merged[key] = value;
  }
  return merged;
}

function addressParts(projectLocation = '') {
  const segments = clean(projectLocation).split(',').map((part) => clean(part)).filter(Boolean);
  const street = segments.shift() || '';
  const cityOrTown = segments.shift() || '';
  const state = segments.join(', ');
  const streetMatch = street.match(/^(\d+[A-Za-z-]*)\s+(.+)$/);
  return {
    streetNumber: streetMatch?.[1] || '',
    streetName: streetMatch?.[2] || '',
    cityOrTown,
    state,
  };
}

export function validationLeadFromModular(lead = {}) {
  const address = addressParts(lead.projectLocation);
  return {
    fullName: clean(lead.name),
    serviceType: clean(lead.service).toLowerCase(),
    ...address,
    preferredDateOrDay: clean(lead.preferredDate),
    preferredTime: clean(lead.preferredTime),
    additionalNotes: clean(lead.notes),
    contactConsent: lead.contactConsent === true,
  };
}

function rawTimeFromTranscript(transcript = '') {
  const normalized = clean(transcript)
    .replace(/\blike\b/gi, ' ')
    .replace(/\s+/g, ' ');
  const atTime = normalized.match(/\bat\s*,?\s*(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  const explicitTime = normalized.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  const match = atTime || explicitTime;
  if (!match) return '';
  const hour = match[1];
  const minutes = match[2] ? `:${match[2]}` : '';
  const meridiem = clean(match[3]).replace(/\./g, '').toUpperCase();
  return `${hour}${minutes}${meridiem ? ` ${meridiem}` : ''}`;
}

function rawDateFromTranscript(transcript = '') {
  const text = clean(transcript);
  const weekdays = [...text.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)];
  if (weekdays.length) return weekdays.at(-1)[1];
  const monthDay = text.match(MONTH_DAY_PATTERN);
  if (monthDay) return monthDay[0];
  const ordinal = text.match(ORDINAL_DAY_PATTERN);
  if (ordinal) return ordinal[0];
  return '';
}

export function isControlSpeech(value) {
  return CONTROL_SPEECH_PATTERN.test(clean(value));
}

export function controlSpeechReply(core, questionId, lead = {}) {
  const question = repeatQuestionFor(core, questionId) || baseQuestionFor(core, questionId, lead);
  return clean(`I'm here. ${question}`);
}

export function captureDeterministicLead(core, currentQuestionId, transcript, lead = {}) {
  const captured = { ...lead };
  const text = clean(transcript);
  if (!text || isControlSpeech(text)) return captured;

  if (currentQuestionId === 'service') {
    const service = serviceNames(core)
      .find((candidate) => text.toLowerCase().includes(candidate.toLowerCase()));
    if (service) captured.service = service;
  }

  if (currentQuestionId === 'name') captured.name = text;
  if (currentQuestionId === 'project_location') captured.projectLocation = text;

  if (currentQuestionId === 'preferred_date_time') {
    const preferredDate = rawDateFromTranscript(text);
    const rawTime = rawTimeFromTranscript(text);
    const preferredTime = rawTime ? clean(core.normalizePreferredTime(rawTime)) : '';
    if (preferredDate) captured.preferredDate = preferredDate;
    if (preferredTime) captured.preferredTime = preferredTime;
  }

  if (currentQuestionId === 'notes') {
    if (NO_NOTES_PATTERN.test(text)) captured.notes = 'none';
    else if (text) captured.notes = text;
  }

  if (currentQuestionId === 'contact_consent') {
    if (/\b(?:yes|yeah|yep|sure|i do|that's fine|that is fine)\b/i.test(text)) captured.contactConsent = true;
    if (/\b(?:no|nope|do not|don't)\b/i.test(text)) captured.contactConsent = false;
  }

  if (currentQuestionId === 'confirm_summary' && NO_NOTES_PATTERN.test(text)) captured.notes = 'none';
  return captured;
}

export function changedLeadFields(before = {}, after = {}) {
  return ['name', 'service', 'projectLocation', 'preferredDate', 'preferredTime', 'notes', 'contactConsent']
    .filter((key) => before[key] !== after[key]);
}

export function callerAffirmsSummary(transcript = '') {
  return AFFIRMATIVE_PATTERN.test(clean(transcript));
}

export function markDeterministicCompletions(currentQuestionId, lead, completedIds = []) {
  const completed = new Set(completedIds || []);
  if (currentQuestionId === 'service' && clean(lead.service)) completed.add('service');
  if (currentQuestionId === 'name' && clean(lead.name).split(/\s+/).length >= 2) completed.add('name');
  if (currentQuestionId === 'project_location' && clean(lead.projectLocation)) completed.add('project_location');
  if (currentQuestionId === 'preferred_date_time' && clean(lead.preferredDate) && clean(lead.preferredTime)) completed.add('preferred_date_time');
  if (currentQuestionId === 'notes' && clean(lead.notes)) completed.add('notes');
  if (currentQuestionId === 'contact_consent' && typeof lead.contactConsent === 'boolean') completed.add('contact_consent');
  return [...completed];
}

export function nextRequiredQuestion(memory, lead = {}) {
  const completed = new Set(memory.completedQuestionIds || []);
  if (!completed.has('service') || !clean(lead.service)) return 'service';
  if (!completed.has('name') || !clean(lead.name)) return 'name';
  if (!completed.has('project_location') || !clean(lead.projectLocation)) return 'project_location';
  if (!completed.has('preferred_date_time') || !clean(lead.preferredDate) || !clean(lead.preferredTime)) return 'preferred_date_time';
  if (!completed.has('notes')) return 'notes';
  if (!completed.has('contact_consent') || typeof lead.contactConsent !== 'boolean') return 'contact_consent';
  if (!completed.has('confirm_summary')) return 'confirm_summary';
  return 'none';
}

export function enforceQuestionBlock(core, spokenReply, questionId, lead = {}) {
  return assembleIntakeReply(core, spokenReply, questionId, lead);
}

export function validationQuestion(errors = []) {
  const text = errors.join(' ').toLowerCase();
  if (/first and last name/.test(text)) return 'name';
  if (/configured service/.test(text)) return 'service';
  if (/city or town|project state|street number|street name/.test(text)) return 'project_location';
  if (/estimate date|weekday|estimate time/.test(text)) return 'preferred_date_time';
  if (/consent/.test(text)) return 'contact_consent';
  return 'clarify';
}

export function validationPreface(core, questionId, errors = []) {
  if (questionId === 'name') return 'I still need both your first and last name.';
  if (questionId === 'service') return 'I still need the service you want.';
  if (questionId === 'project_location') return 'I still need the street number, street name, city or town, and state.';
  if (questionId === 'preferred_date_time') return `I still need an upcoming estimate date and a time within our availability. ${availabilityStatement(core)}`;
  if (questionId === 'contact_consent') return `I still need a clear yes or no before ${core.BUSINESS.name} can contact you.`;
  return errors.length ? 'I still need some information before I can submit the request.' : '';
}

export function removeCompletion(memory, questionId) {
  memory.completedQuestionIds = (memory.completedQuestionIds || []).filter((id) => id !== questionId && id !== 'confirm_summary');
}

export function reopenConfirmation(memory) {
  memory.completedQuestionIds = (memory.completedQuestionIds || []).filter((id) => id !== 'confirm_summary');
}

export function isObviouslyIncompleteTranscript(value) {
  const text = clean(value);
  if (!text) return true;
  if (HESITATION_PATTERN.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (/(?:\.\.\.|…)\s*$/.test(text) && words.length <= 10) return true;
  const normalized = text.toLowerCase().replace(/(?:\.\.\.|…)+$/g, '').replace(/[,.!?;:]+$/g, '').replace(/\s+/g, ' ').trim();
  return INCOMPLETE_PATTERN.test(normalized);
}

export function mergeCallerFragment(fragment, transcript) {
  return clean(`${clean(fragment).replace(/(?:\.\.\.|…)+$/g, '')} ${clean(transcript)}`);
}

export function shouldKeepHoldingFragment(fragment, transcript) {
  const next = clean(transcript);
  if (fragment && CONTINUATION_FILLER_PATTERN.test(next)) return true;
  return isObviouslyIncompleteTranscript(mergeCallerFragment(fragment, next));
}
