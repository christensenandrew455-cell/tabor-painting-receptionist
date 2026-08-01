import { changedLeadFields, mergeLead } from './modular-intake-logic.js';

export const INTERPRETER_ACTIONS = Object.freeze([
  'answer',
  'yes',
  'no',
  'why',
  'identity',
  'restart',
  'off_topic',
  'clarify',
  'summary_confirm',
  'summary_correction',
  'more_questions_yes',
  'more_questions_no',
]);

export const INTERPRETER_ACKS = Object.freeze([
  'none',
  'sorry',
  'sounds_good',
  'thanks',
  'thanks_name',
  'got_it',
]);

const ACTION_SET = new Set(INTERPRETER_ACTIONS);
const ACK_SET = new Set(INTERPRETER_ACKS);
const QUESTION_LIKE_PATTERN = /\?\s*$|^(?:what|why|how|when|where|who|hello|huh|sorry)\b/i;
const NO_NOTES_PATTERN = /^(?:no|nope|nah|ne)[.!?\s]*$|\b(?:no additional notes?|no notes?|do not have any notes?|don't have any notes?|nothing else|none)\b/i;
const LEADING_FILLER_PATTERN = /^(?:(?:um+|uh+|erm|hmm+|well|so|like)\b[,.;:\s-]*)+/i;
const SPOKEN_HOURS = Object.freeze({
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

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanName(value) {
  return clean(value)
    .replace(LEADING_FILLER_PATTERN, '')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

function normalizeSpokenTime(value) {
  const text = clean(value);
  if (!text) return '';
  const simplified = text.toLowerCase().replace(/[.!?,]/g, '').trim();
  if (SPOKEN_HOURS[simplified]) return SPOKEN_HOURS[simplified];
  const wordMatch = simplified.match(/(?:at\s+)?(one|two|too|three|four|nine|ten|eleven|twelve)(?:\s*(?:o'clock)?)?$/i);
  return wordMatch ? SPOKEN_HOURS[wordMatch[1].toLowerCase()] : text;
}

function nullableString(value, maxLength = 300) {
  if (value === null || value === undefined) return null;
  const text = clean(value);
  return text && text.length <= maxLength ? text : null;
}

function extractJsonObject(value) {
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Realtime interpreter did not return a JSON object.');
  return JSON.parse(text.slice(start, end + 1));
}

export function parseRealtimeTurnInterpretation(value) {
  const parsed = typeof value === 'string' ? extractJsonObject(value) : value;
  const updates = parsed?.updates && typeof parsed.updates === 'object' ? parsed.updates : {};

  return {
    action: ACTION_SET.has(parsed?.action) ? parsed.action : 'clarify',
    ack: ACK_SET.has(parsed?.ack) ? parsed.ack : 'none',
    updates: {
      name: nullableString(updates.name, 80),
      service: nullableString(updates.service, 80),
      projectLocation: nullableString(updates.projectLocation, 180),
      preferredDate: nullableString(updates.preferredDate, 50),
      preferredTime: nullableString(updates.preferredTime, 30),
      notes: nullableString(updates.notes, 500),
      contactConsent: typeof updates.contactConsent === 'boolean' ? updates.contactConsent : null,
    },
  };
}

export function buildRealtimeTurnPrompt({ core, transcript, currentQuestionId, lead, history = [] }) {
  const services = Object.keys(core?.BUSINESS?.services || {});
  const context = {
    currentQuestionId,
    callerTranscript: clean(transcript),
    currentLead: lead,
    recentConversation: history.slice(-8),
    configuredServices: services,
    estimateSchedule: {
      days: clean(core?.BUSINESS?.estimateDays),
      earliest: clean(core?.BUSINESS?.earliestEstimateStart),
      latest: clean(core?.BUSINESS?.latestEstimateStart),
    },
  };

  return [
    'You are the interpretation layer for a residential painting company receptionist.',
    'Understand the caller naturally, then return exactly one compact JSON object and no other text.',
    'Do not write a caller-facing response. Do not ask questions. Do not give painting advice.',
    'Never suggest hiring or contacting a painter; the caller already called the painting company.',
    'Never ask whether the caller will do the work themselves or hire professionals.',
    'The controller owns the fixed question order and exact question wording.',
    'JSON shape:',
    '{"action":"answer","ack":"none","updates":{"name":null,"service":null,"projectLocation":null,"preferredDate":null,"preferredTime":null,"notes":null,"contactConsent":null}}',
    `Allowed action values: ${INTERPRETER_ACTIONS.join(', ')}.`,
    `Allowed ack values: ${INTERPRETER_ACKS.join(', ')}.`,
    'Choose at most one acknowledgement. It is a key, not free-form wording.',
    'Use sorry for an unpleasant problem, sounds_good for a normal positive transition, thanks after information, thanks_name after a name, got_it after a simple answer, or none.',
    'Only use configured service names exactly.',
    'Map whole inside, interior, rooms, walls, or ceilings to interior painting.',
    'Map outside, exterior, siding, or whole outside to exterior painting.',
    'Map holes, touch-ups, patches, damaged paint, or paint repair to small paint repair when that configured service exists.',
    'Map decks, fences, wood, or staining to wood staining when that configured service exists.',
    'For names, remove fillers such as um, uh, well, like, or so. Return a real first and last name only when supplied.',
    'For addresses, return only the address information. A partial street address is allowed and may be combined later.',
    'For dates and times, normalize spoken numbers. Example: Monday at two means preferredDate Monday and preferredTime 2:00 PM.',
    'Times outside the stated estimate schedule must be null so the controller can ask again.',
    'For notes, a clear no means notes is the string none. Do not save confused questions as notes.',
    'For consent, set contactConsent only for a clear yes or no.',
    'At final confirmation, yes with no correction is summary_confirm. Yes but, actually, except, or any correction is summary_correction and must include corrected fields.',
    'When the caller asks why the current information is needed, use action why.',
    'When asked whether you are AI, use identity. For restarting use restart. For unrelated requests use off_topic.',
    `CONTEXT: ${JSON.stringify(context)}`,
  ].join('\n');
}

export function applyRealtimeInterpretation(core, lead = {}, interpretation = {}) {
  const before = { ...lead };
  const updates = interpretation.updates || {};
  let next = { ...lead };

  const configuredServices = Object.keys(core?.BUSINESS?.services || {});
  const service = clean(updates.service).toLowerCase();
  const matchedService = configuredServices.find((candidate) => candidate.toLowerCase() === service);
  if (matchedService) next.service = matchedService;

  if (updates.name) next = mergeLead(next, { name: cleanName(updates.name) });
  if (updates.projectLocation) next = mergeLead(next, { projectLocation: updates.projectLocation });

  if (updates.preferredDate) next.preferredDate = clean(updates.preferredDate);
  if (updates.preferredTime) {
    const normalizedTime = clean(core.normalizePreferredTime(normalizeSpokenTime(updates.preferredTime)));
    if (normalizedTime) next.preferredTime = normalizedTime;
  }

  if (updates.notes) {
    const notes = clean(updates.notes);
    if (notes.toLowerCase() === 'none' || NO_NOTES_PATTERN.test(notes)) next.notes = 'none';
    else if (!QUESTION_LIKE_PATTERN.test(notes)) next.notes = notes;
  }

  if (typeof updates.contactConsent === 'boolean') next.contactConsent = updates.contactConsent;

  return {
    lead: next,
    changedFields: changedLeadFields(before, next),
  };
}
