const WEEKDAY_PATTERN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const MONTH_DAY_PATTERN = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+\d{4})?\b/i;
const ORDINAL_DAY_PATTERN = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i;
const HESITATION_PATTERN = /^(?:uh|um|erm|hmm|well|so|and|like)[.!?…\s]*$/i;
const CONTINUATION_FILLER_PATTERN = /^(?:uh|um|erm|hmm|well|so|and|like|right|yeah|yep|okay|ok)[.!?…\s]*$/i;
const INCOMPLETE_PATTERN = /^(?:(?:uh|um|erm|hmm|well|so|and)\s*)?(?:(?:that|it|this|the address|my address|the date|the time|my name|can i do)\s*)?(?:(?:would be|is|is at|is on|would be at|would be on)\s*)?$/i;
const CONTROL_SPEECH_PATTERN = /^(?:hello|hello there|hi|hey|are you there|you there|can you hear me|do you hear me|are you listening|still there|i'm here|im here)[?!.\s]*$/i;
const TRANSCRIPTION_ARTIFACT_PATTERN = /^(?:a|the) (?:caller|person|man|woman) (?:is )?(?:speaking|talking)(?: with| to).*?(?:receptionist|company|business|phone call)[.!\s]*$/i;
const NO_NOTES_PATTERN = /\b(?:no additional notes?|no notes?|there (?:was|were|are|is) no additional notes?|nothing else|none|nope|nah|n[aã]o|that's all|that is all)\b/i;
const AFFIRMATIVE_PATTERN = /\b(?:yes|yeah|yep|sure|correct|right|okay|ok|sounds good|that's right|that is right|other than that|otherwise)\b/i;
const SIMPLE_NEGATIVE_PATTERN = /^(?:no|nope|nah|n[aã]o)[.!\s]*$/i;
const ADDRESS_TRAILING_FILLER_PATTERN = /(?:[,;]\s*|\s+)(?:i told you|like i said|as i said|that's the address|that is the address|that's it|that is it)[.!\s]*$/i;
const FULL_NAME_PATTERN = /^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){1,4}[.!\s]*$/u;
const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
  'ma', 'il', 'ct', 'ri', 'nh', 'me', 'vt', 'ny', 'nj', 'pa',
]);

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

function cleanAddressText(value = '') {
  return clean(value)
    .replace(ADDRESS_TRAILING_FILLER_PATTERN, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeStreet(value = '') {
  return /^\d+[A-Za-z-]*\s+\S.+/.test(clean(value));
}

function looksLikeState(value = '') {
  return US_STATES.has(clean(value).toLowerCase().replace(/\./g, ''));
}

function addressParts(projectLocation = '') {
  const raw = clean(projectLocation);
  if (!raw) return { streetNumber: '', streetName: '', cityOrTown: '', state: '' };
  const segments = raw.split(',').map((part) => clean(part));
  const street = segments[0] || '';
  const cityOrTown = segments[1] || '';
  const state = segments.slice(2).join(', ').trim();
  const streetMatch = street.match(/^(\d+[A-Za-z-]*)\s+(.+)$/);
  return {
    streetNumber: streetMatch?.[1] || '',
    streetName: streetMatch?.[2] || '',
    cityOrTown,
    state,
  };
}

function serializeAddress(parts = {}) {
  const street = clean(`${clean(parts.streetNumber)} ${clean(parts.streetName)}`);
  return `${street}, ${clean(parts.cityOrTown)}, ${clean(parts.state)}`;
}

function incomingAddressParts(transcript = '') {
  const text = cleanAddressText(transcript);
  if (!text || SIMPLE_NEGATIVE_PATTERN.test(text) || isLikelyTranscriptionArtifact(text)) return {};
  const segments = text.split(',').map((part) => clean(part)).filter(Boolean);
  if (!segments.length) return {};

  if (segments.length >= 3 && looksLikeStreet(segments[0])) {
    const streetMatch = segments[0].match(/^(\d+[A-Za-z-]*)\s+(.+)$/);
    return {
      streetNumber: streetMatch?.[1] || '',
      streetName: streetMatch?.[2] || '',
      cityOrTown: segments[1],
      state: segments.slice(2).join(', '),
    };
  }

  if (segments.length === 2) {
    if (looksLikeStreet(segments[0])) {
      const streetMatch = segments[0].match(/^(\d+[A-Za-z-]*)\s+(.+)$/);
      return {
        streetNumber: streetMatch?.[1] || '',
        streetName: streetMatch?.[2] || '',
        ...(looksLikeState(segments[1]) ? { state: segments[1] } : { cityOrTown: segments[1] }),
      };
    }
    return { cityOrTown: segments[0], state: segments[1] };
  }

  if (looksLikeStreet(segments[0])) {
    const streetMatch = segments[0].match(/^(\d+[A-Za-z-]*)\s+(.+)$/);
    return { streetNumber: streetMatch?.[1] || '', streetName: streetMatch?.[2] || '' };
  }
  if (looksLikeState(segments[0])) return { state: segments[0] };
  if (/^[\p{L} .'-]{2,}$/u.test(segments[0])) return { cityOrTown: segments[0] };
  return {};
}

function mergeAddressFragment(existing = '', transcript = '') {
  const current = addressParts(existing);
  const incoming = incomingAddressParts(transcript);
  if (!Object.keys(incoming).length) return existing;
  return serializeAddress({ ...current, ...incoming });
}

function completeAddress(projectLocation = '') {
  const parts = addressParts(projectLocation);
  return Boolean(parts.streetNumber && parts.streetName && parts.cityOrTown && parts.state);
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

function normalizeRequestedDate(core, value = '') {
  const raw = clean(value);
  if (!raw) return '';
  if (typeof core.resolvePreferredDate !== 'function') return raw;
  return clean(core.resolvePreferredDate(raw));
}

function inferService(core, transcript = '') {
  const text = clean(transcript).toLowerCase();
  const direct = serviceNames(core).find((candidate) => text.includes(candidate.toLowerCase()));
  if (direct) return direct;

  const candidates = serviceNames(core);
  const find = (pattern, preferredName) => pattern.test(text)
    ? candidates.find((candidate) => candidate.toLowerCase() === preferredName)
    : '';
  return find(/\b(?:stain|staining)\b/, 'wood staining')
    || find(/\b(?:outside|exterior|siding|shed|garage exterior|paint the house outside)\b/, 'exterior painting')
    || find(/\b(?:inside|interior|room|rooms|walls?|ceilings?)\b/, 'interior painting')
    || find(/\b(?:touch[- ]?up|small repair|paint repair|chip|chips|patch)\b/, 'small paint repair')
    || '';
}

function deterministicFullName(transcript = '') {
  const text = clean(transcript);
  if (!FULL_NAME_PATTERN.test(text)) return '';
  if (/\b(?:yes|yeah|no|address|road|street|avenue|painting|staining)\b/i.test(text)) return '';
  return text.replace(/[.!]+$/g, '').trim();
}

export function isControlSpeech(value) {
  return CONTROL_SPEECH_PATTERN.test(clean(value));
}

export function isLikelyTranscriptionArtifact(value) {
  return TRANSCRIPTION_ARTIFACT_PATTERN.test(clean(value));
}

export function controlSpeechReply(core, questionId, lead = {}) {
  const question = repeatQuestionFor(core, questionId, lead) || baseQuestionFor(core, questionId, lead);
  return clean(`I'm here. ${question}`);
}

export function captureDeterministicLead(core, currentQuestionId, transcript, lead = {}) {
  const captured = { ...lead };
  const text = clean(transcript);
  if (!text || isControlSpeech(text) || isLikelyTranscriptionArtifact(text)) return captured;

  if (currentQuestionId === 'service') {
    const service = inferService(core, text);
    if (service) captured.service = service;
  }

  if (currentQuestionId === 'name') {
    const name = deterministicFullName(text);
    if (name) captured.name = name;
  }

  if (currentQuestionId === 'project_location') {
    const mergedAddress = mergeAddressFragment(captured.projectLocation, text);
    if (mergedAddress && mergedAddress !== captured.projectLocation) captured.projectLocation = mergedAddress;
  }

  if (currentQuestionId === 'preferred_date_time') {
    const rawDate = rawDateFromTranscript(text);
    const preferredDate = normalizeRequestedDate(core, rawDate);
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
    if (/\b(?:no|nope|nah|n[aã]o|do not|don't)\b/i.test(text)) captured.contactConsent = false;
  }

  if (currentQuestionId === 'confirm_summary') {
    if (NO_NOTES_PATTERN.test(text)) captured.notes = 'none';
  }

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
  if (currentQuestionId === 'name' && deterministicFullName(lead.name)) completed.add('name');
  if (currentQuestionId === 'project_location' && completeAddress(lead.projectLocation)) completed.add('project_location');
  if (currentQuestionId === 'preferred_date_time' && clean(lead.preferredDate) && clean(lead.preferredTime)) {
    completed.add('preferred_date_time');
  }
  if (currentQuestionId === 'notes' && clean(lead.notes)) completed.add('notes');
  if (currentQuestionId === 'contact_consent' && typeof lead.contactConsent === 'boolean') {
    completed.add('contact_consent');
  }
  return [...completed];
}

export function nextRequiredQuestion(memory, lead = {}) {
  const completed = new Set(memory.completedQuestionIds || []);
  if (!completed.has('service') || !clean(lead.service)) return 'service';
  if (!completed.has('name') || !clean(lead.name)) return 'name';
  if (!completed.has('project_location') || !completeAddress(lead.projectLocation)) return 'project_location';
  if (!completed.has('preferred_date_time') || !clean(lead.preferredDate) || !clean(lead.preferredTime)) {
    return 'preferred_date_time';
  }
  if (!completed.has('notes')) return 'notes';
  if (!completed.has('contact_consent') || typeof lead.contactConsent !== 'boolean') return 'contact_consent';
  if (!completed.has('confirm_summary')) return 'confirm_summary';
  return 'none';
}

export function availabilityStatement(core) {
  return `Estimate appointments are available ${core.BUSINESS.estimateDays} from ${core.BUSINESS.earliestEstimateStart} through ${core.BUSINESS.latestEstimateStart}.`;
}

function ordinal(number) {
  const value = Number(number);
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

export function spokenPreferredDate(value = '') {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return text;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(date);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${weekday}, ${month} ${ordinal(date.getUTCDate())}`;
}

function requestedTimeNotice(core, lead = {}) {
  if (!clean(lead.preferredDate) || !clean(lead.preferredTime)) return '';
  return `Just so you know, ${spokenPreferredDate(lead.preferredDate)} at ${clean(lead.preferredTime)} is your requested estimate time. ${core.BUSINESS.name} may need to adjust it depending on availability, but they will contact you before making any changes.`;
}

export function summaryStatement(core, lead = {}) {
  const notes = clean(lead.notes);
  const notesClause = notes && notes.toLowerCase() !== 'none'
    ? ` Your additional notes are: ${notes}.`
    : ' You did not have any additional notes.';
  const consentClause = lead.contactConsent === true
    ? ` You consented to being contacted by ${core.BUSINESS.name}.`
    : ` You did not consent to being contacted by ${core.BUSINESS.name}.`;
  return `Before I send this in, I'm going to read everything back to make sure I didn't miss anything. You requested ${clean(lead.service)}. Your name is ${clean(lead.name)}. The project address is ${clean(lead.projectLocation)}. Your requested estimate time is ${spokenPreferredDate(lead.preferredDate)} at ${clean(lead.preferredTime)}.${notesClause}${consentClause}`;
}

function projectLocationQuestion(lead = {}) {
  const parts = addressParts(lead.projectLocation);
  if (!parts.streetNumber || !parts.streetName) return 'What is the street address for the project?';
  if (!parts.cityOrTown) return 'What city or town is the project in?';
  if (!parts.state) return 'What state is the project in?';
  return 'What is the full address for the project?';
}

export function baseQuestionFor(core, questionId, lead = {}) {
  const questions = {
    ask_estimate: 'Would you like to submit an estimate request?',
    continue_estimate: 'Would you like to continue filling out your estimate request?',
    more_questions: `Do you have any more questions about ${core.BUSINESS.name}?`,
    service: 'What service do you need?',
    name: 'What is your full name?',
    project_location: projectLocationQuestion(lead),
    preferred_date_time: `${availabilityStatement(core)} What is your preferred estimate date and time?`,
    notes: `${requestedTimeNotice(core, lead)} Do you have any additional notes about this project?`,
    contact_consent: core.contactConsentQuestion,
    confirm_summary: `${summaryStatement(core, lead)} Does all of that sound right?`,
    clarify: "I'm sorry, I didn't catch that. Could you repeat that?",
  };
  return clean(questions[questionId]);
}

export function repeatQuestionFor(core, questionId, lead = {}) {
  const questions = {
    ask_estimate: 'Would you like to submit an estimate request?',
    continue_estimate: 'Would you like to continue filling out your estimate request?',
    more_questions: `Do you have any more questions about ${core.BUSINESS.name}?`,
    service: 'What service do you need?',
    name: 'What is your full name?',
    project_location: projectLocationQuestion(lead),
    preferred_date_time: 'What is your preferred estimate date and time?',
    notes: 'Do you have any additional notes about this project?',
    contact_consent: core.contactConsentQuestion,
    confirm_summary: 'Does all of that sound right?',
    clarify: "I'm sorry, I didn't catch that. Could you repeat that?",
  };
  return clean(questions[questionId]);
}

function declarativePreface(spokenReply, questionId) {
  if (questionId === 'confirm_summary' || questionId === 'service' || questionId === 'notes') return '';
  const sentences = clean(spokenReply).match(/[^.!?]+[.!?]?/g) || [];
  const kept = sentences
    .map((sentence) => clean(sentence))
    .filter((sentence) => sentence && !sentence.includes('?'))
    .filter((sentence) => {
      if (questionId !== 'preferred_date_time') return true;
      return !/estimate availability|estimate appointments are available|monday through friday|from .* through/i.test(sentence);
    });
  let result = clean(kept.join(' '));
  if (result.length > 180) result = clean(result.slice(0, 180).replace(/\s+\S*$/, ''));
  return result;
}

export function enforceQuestionBlock(core, spokenReply, questionId, lead = {}) {
  const base = baseQuestionFor(core, questionId, lead);
  if (!base || questionId === 'none') return clean(spokenReply);
  if (questionId === 'clarify' || questionId === 'confirm_summary' || questionId === 'service' || questionId === 'notes') return base;
  const preface = declarativePreface(spokenReply, questionId);
  return clean(preface ? `${preface} ${base}` : base);
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
  if (questionId === 'service') return 'I still need to know what kind of work you need.';
  if (questionId === 'project_location') return 'I still need the remaining part of the project address.';
  if (questionId === 'preferred_date_time') return `I still need an upcoming estimate date and a time within our availability. ${availabilityStatement(core)}`;
  if (questionId === 'contact_consent') return `I still need a clear yes or no before ${core.BUSINESS.name} can contact you.`;
  return errors.length ? 'I still need some information before I can submit the request.' : '';
}

export function removeCompletion(memory, questionId) {
  memory.completedQuestionIds = (memory.completedQuestionIds || [])
    .filter((id) => id !== questionId && id !== 'confirm_summary');
}

export function reopenConfirmation(memory) {
  memory.completedQuestionIds = (memory.completedQuestionIds || [])
    .filter((id) => id !== 'confirm_summary');
}

export function isObviouslyIncompleteTranscript(value) {
  const text = clean(value);
  if (!text) return true;
  if (HESITATION_PATTERN.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (/(?:\.\.\.|…)\s*$/.test(text) && words.length <= 10) return true;
  const normalized = text
    .toLowerCase()
    .replace(/(?:\.\.\.|…)+$/g, '')
    .replace(/[,.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
