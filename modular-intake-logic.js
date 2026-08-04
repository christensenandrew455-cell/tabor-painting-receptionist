import {
  assembleIntakeReply,
  availabilityStatement,
  baseQuestionFor,
  repeatQuestionFor,
  summaryStatement,
} from './intake-response-policy.js';
import { isValidFullName } from './intake-schema.js';
export { availabilityStatement, baseQuestionFor, repeatQuestionFor, summaryStatement };

const HESITATION_PATTERN = /^(?:uh|um|erm|hmm|well|so|and|like)[.!?…\s]*$/i;
const CONTINUATION_FILLER_PATTERN = /^(?:uh|um|erm|hmm|well|so|and|like|right|yeah|yep|okay|ok)[.!?…\s]*$/i;
const INCOMPLETE_PATTERN = /^(?:(?:uh|um|erm|hmm|well|so|and)\s*)?(?:(?:that|it|this|the address|my address|the date|the time|my name|can i do)\s*)?(?:(?:would be|is|is at|is on|would be at|would be on)\s*)?$/i;
const CONTROL_SPEECH_PATTERN = /^(?:hello|hello there|hi|hey|are you there|you there|can you hear me|do you hear me|are you listening|still there|i'm here|im here)[?!.\s]*$/i;
const NO_NOTES_PATTERN = /\b(?:no additional notes?|no notes?|there (?:was|were|are|is) no additional notes?|nothing else|none|nope|that's all|that is all)\b/i;
const AFFIRMATIVE_PATTERN = /\b(?:yes|yeah|yep|sure|correct|right|okay|ok|sounds good|that's right|that is right|other than that|otherwise)\b/i;
const NON_NAME_SENTENCE_PATTERN = /\b(?:i|you|we|they|called|calling|think|know|what|why|because|estimate|request|talking|paint|address|phone|number)\b/i;
const NAME_TOKEN_PATTERN = /^[A-Za-z][A-Za-z'’-]*$/;
const LEADING_NAME_FILLER_PATTERN = /^(?:(?:um+|uh+|erm|hmm+|well|so|like|yeah|yes|okay|ok)\b[,.;:\s-]*)+/i;
const SPOKEN_TIME_PATTERN = /\bat\s+(one|two|too|three|four|nine|ten|eleven|twelve)\b/i;
const PROJECT_NOTE_DETAIL_PATTERN = /\b(?:paint|painting|primer|primed|wall|ceiling|room|upstairs|downstairs|spray|surface|color|coat|trim|door|window|siding|deck|fence|repair|prep|project)\b/i;
const SPOKEN_TIMES = Object.freeze({
  one: '1:00 PM',
  two: '2:00 PM',
  too: '2:00 PM',
  three: '3:00 PM',
  four: '4:00 PM',
  nine: '9:00 AM',
  ten: '10:00 AM',
  eleven: '11:00 AM',
  twelve: '12:00 PM',
});

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

function normalizedName(value) {
  return clean(value)
    .replace(LEADING_NAME_FILLER_PATTERN, '')
    .replace(/^(?:like i said[,]?\s*)?(?:my full name is|my name is|i am|i'm)\s+/i, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedAddress(value) {
  return clean(value).replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
}

function addressParts(projectLocation = '') {
  const segments = normalizedAddress(projectLocation).split(',').map((part) => clean(part)).filter(Boolean);
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

function streetAddressCandidate(value) {
  const text = normalizedAddress(value);
  const streetStart = text.search(/\b\d+[A-Za-z-]*\s+[A-Za-z0-9]/);
  if (streetStart < 0) return '';
  return text
    .slice(streetStart)
    .split(',')
    .map((part) => clean(part))
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

function addressAnswerWithoutLeadIn(value) {
  return normalizedAddress(value)
    .replace(/^(?:that would be|it would be|it is|it's|the city is|city is|the state is|state is)\s+/i, '')
    .trim();
}

function isPlausibleStreetAddress(value) {
  const address = normalizedAddress(value);
  if (!address || address.length > 180 || /[?]/.test(address)) return false;
  const parts = addressParts(address);
  return Boolean(parts.streetNumber && parts.streetName.length >= 2);
}

function isPlausibleProjectAddress(core, value) {
  return core.parseProjectAddress(value).valid;
}

function mergeProjectLocationAnswer(currentLocation = '', transcript = '') {
  const fullOrPartialStreet = streetAddressCandidate(transcript);
  if (isPlausibleStreetAddress(fullOrPartialStreet)) return fullOrPartialStreet;

  const current = addressParts(currentLocation);
  if (!current.streetNumber || !current.streetName) return '';

  const answer = addressAnswerWithoutLeadIn(transcript);
  if (!answer || /[?]/.test(answer) || /\d/.test(answer)) return '';
  const segments = answer.split(',').map((part) => clean(part)).filter(Boolean);
  const street = `${current.streetNumber} ${current.streetName}`;

  if (!current.cityOrTown && !current.state && segments.length >= 2) {
    return `${street}, ${segments[0]}, ${segments.slice(1).join(', ')}`;
  }
  if (!current.cityOrTown && current.state && segments.length >= 1) {
    return `${street}, ${segments[0]}, ${current.state}`;
  }
  if (current.cityOrTown && !current.state && segments.length >= 1) {
    return `${street}, ${current.cityOrTown}, ${segments.join(', ')}`;
  }

  return '';
}

function isPlausibleFullName(value) {
  return isValidFullName(normalizedName(value));
}

function inferService(core, transcript = '') {
  return core.matchService(transcript);
}

export function mergeLead(current = {}, updates = {}) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(updates || {})) {
    if (key === 'contactConsent' && typeof value === 'boolean') {
      merged[key] = value;
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    if (key === 'name') {
      if (isPlausibleFullName(value)) merged.name = normalizedName(value);
      continue;
    }
    if (key === 'projectLocation') {
      const projectLocation = mergeProjectLocationAnswer(merged.projectLocation, value);
      if (isPlausibleStreetAddress(projectLocation)) merged.projectLocation = projectLocation;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function validationLeadFromModular(core, lead = {}) {
  const address = core.parseProjectAddress(lead.projectLocation);
  return {
    fullName: normalizedName(lead.name),
    serviceType: clean(lead.service),
    projectLocation: address.formatted || clean(lead.projectLocation),
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
  const spoken = normalized.match(SPOKEN_TIME_PATTERN);
  if (spoken) return SPOKEN_TIMES[spoken[1].toLowerCase()] || '';
  const atTime = normalized.match(/\bat\s*,?\s*(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  const explicitTime = normalized.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  const match = atTime || explicitTime;
  if (!match) return '';
  const hour = match[1];
  const minutes = match[2] ? `:${match[2]}` : '';
  const meridiem = clean(match[3]).replace(/\./g, '').toUpperCase();
  return `${hour}${minutes}${meridiem ? ` ${meridiem}` : ''}`;
}

function isSchedulingAnswerOnly(core, transcript = '') {
  const text = clean(transcript);
  return Boolean(core.resolvePreferredDate(text) && rawTimeFromTranscript(text) && !PROJECT_NOTE_DETAIL_PATTERN.test(text));
}

export function isControlSpeech(value) {
  return CONTROL_SPEECH_PATTERN.test(clean(value));
}

export function controlSpeechReply(core, questionId, lead = {}) {
  const question = repeatQuestionFor(core, questionId, lead) || baseQuestionFor(core, questionId, lead);
  return clean(`I'm here. ${question}`);
}

export function captureDeterministicLead(core, currentQuestionId, transcript, lead = {}) {
  const captured = { ...lead };
  const text = clean(transcript);
  if (!text || isControlSpeech(text)) return captured;

  if (currentQuestionId === 'service') {
    const service = inferService(core, text);
    if (service) captured.service = service;
  }

  if (currentQuestionId === 'name' && isPlausibleFullName(text)) {
    captured.name = normalizedName(text);
  }

  if (currentQuestionId === 'project_location') {
    const projectLocation = mergeProjectLocationAnswer(captured.projectLocation, text);
    if (isPlausibleStreetAddress(projectLocation)) captured.projectLocation = projectLocation;
  }

  if (currentQuestionId === 'preferred_date_time') {
    const preferredDate = core.resolvePreferredDate(text);
    const rawTime = rawTimeFromTranscript(text);
    const preferredTime = rawTime ? clean(core.normalizePreferredTime(rawTime)) : '';
    if (preferredDate) captured.preferredDate = preferredDate;
    if (preferredTime) captured.preferredTime = preferredTime;
  }

  if (currentQuestionId === 'notes') {
    if (NO_NOTES_PATTERN.test(text)) captured.notes = 'none';
    else if (text && !isSchedulingAnswerOnly(core, text)) captured.notes = text;
  }

  if (currentQuestionId === 'contact_consent') {
    if (/\b(?:yes|yeah|yep|ya|yah|sure|i do|that's fine|that is fine)\b/i.test(text)) captured.contactConsent = true;
    if (/\b(?:no|nope|nah|ne|do not|don't)\b/i.test(text)) captured.contactConsent = false;
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

export function markDeterministicCompletions(core, currentQuestionId, lead, completedIds = []) {
  const completed = new Set(completedIds || []);
  if (currentQuestionId === 'service' && clean(lead.service)) completed.add('service');
  if (currentQuestionId === 'name' && isPlausibleFullName(lead.name)) completed.add('name');
  if (currentQuestionId === 'project_location' && isPlausibleProjectAddress(core, lead.projectLocation)) completed.add('project_location');
  if (currentQuestionId === 'preferred_date_time' && clean(lead.preferredDate) && clean(lead.preferredTime)) completed.add('preferred_date_time');
  if (currentQuestionId === 'notes' && clean(lead.notes)) completed.add('notes');
  if (currentQuestionId === 'contact_consent' && lead.contactConsent === true) completed.add('contact_consent');
  return [...completed];
}

export function nextRequiredQuestion(core, memory, lead = {}) {
  const completed = new Set(memory.completedQuestionIds || []);
  if (!completed.has('service') || !clean(lead.service)) return 'service';
  if (!completed.has('name') || !isPlausibleFullName(lead.name)) return 'name';
  if (!completed.has('project_location') || !isPlausibleProjectAddress(core, lead.projectLocation)) return 'project_location';
  if (!completed.has('preferred_date_time') || !clean(lead.preferredDate) || !clean(lead.preferredTime)) return 'preferred_date_time';
  if (!completed.has('notes')) return 'notes';
  if (!completed.has('contact_consent') || lead.contactConsent !== true) return 'contact_consent';
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
  if (/project address|city or town|valid state|street number|street name/.test(text)) return 'project_location';
  if (/estimate date|weekday|estimate time/.test(text)) return 'preferred_date_time';
  if (/consent/.test(text)) return 'contact_consent';
  return 'clarify';
}

export function validationPreface(core, questionId, errors = []) {
  if (questionId === 'name') return 'I still need both your first and last name.';
  if (questionId === 'service') return 'I still need the service you want.';
  if (questionId === 'project_location') return 'I still need the street address, city or town, and state.';
  if (questionId === 'preferred_date_time') return 'I still need an upcoming date and a time within the estimate schedule.';
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
