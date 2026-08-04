import { changedLeadFields, mergeLead } from './modular-intake-logic.js';

export const INTERPRETER_ACTIONS = Object.freeze([
  'answer',
  'yes',
  'no',
  'why',
  'identity',
  'restart',
  'off_topic',
  'business_question',
  'clarify',
  'refusal',
  'correction_proposed',
  'correction_confirmed',
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
    answeredCurrentQuestion: parsed?.answeredCurrentQuestion === true,
    requiresCorrectionConfirmation: parsed?.requiresCorrectionConfirmation === true,
    businessAnswer: nullableString(parsed?.businessAnswer, 500),
    correctionField: nullableString(parsed?.correctionField, 40),
    updates: {
      name: nullableString(updates.name, 100),
      callbackPhone: nullableString(updates.callbackPhone, 30),
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
    recentConversation: history.slice(-12),
    configuredServices: services,
    businessInformation: core?.BUSINESS || {},
    currentDate: new Intl.DateTimeFormat('en-US', {
      timeZone: core?.BUSINESS?.timeZone || 'UTC',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'long',
    }).format(new Date()),
    estimateSchedule: {
      days: clean(core?.BUSINESS?.estimateDays),
      earliest: clean(core?.BUSINESS?.earliestEstimateStart),
      latest: clean(core?.BUSINESS?.latestEstimateStart),
    },
  };

  return [
    'You are Arc, the interpretation and decision layer for a business AI receptionist.',
    'Return exactly one compact JSON object and no other text.',
    'The lead form is the source of truth. Filled fields must not be requested again unless the caller clearly asks to correct them.',
    'A caller message may fill several fields at once. Extract every field that is explicitly and clearly supplied, even when it is not the current question.',
    'Do not invent, guess, or silently replace caller information.',
    'Names, addresses, dates, times, services, phone numbers, and consent may be cleaned or normalized without changing their meaning.',
    'Notes may be shortened into a clear project summary. No other field may be summarized.',
    'When a caller proposes changing an already-filled field, use action correction_proposed, set requiresCorrectionConfirmation true, identify correctionField, and include the proposed value. Do not treat it as final until the caller confirms.',
    'When the caller confirms a pending correction, use action correction_confirmed.',
    'Business answers must use only businessInformation and configuredServices from CONTEXT. If the answer is not there, businessAnswer must say that the information is unavailable. Never use outside knowledge.',
    'A business question during intake does not cancel the estimate. Use action business_question and preserve the current form.',
    'Identity questions such as are you AI or are you a bot use action identity.',
    'For the current intake question, set answeredCurrentQuestion true only when the latest caller message provides a valid answer for it.',
    'If a required answer is refused, use action refusal. A refusal is different from asking why the information is needed.',
    'If the caller asks why a required field is needed, use action why.',
    'For service, match only configuredServices. If related but unclear, do not choose one; use clarify. If not offered, leave service null.',
    'For a full project address require street number, street name, city or town, and state. ZIP code is optional.',
    'For date and time, accept relative dates and convert later. Require a specific date and a specific time within estimateSchedule.',
    'Additional notes are optional. A clear no means notes is the string none.',
    'Consent requires a clear yes or no. Never infer consent.',
    'At final confirmation, a plain yes is summary_confirm. If the caller identifies an error, use summary_correction and include only the proposed corrected field.',
    'JSON shape:',
    '{"action":"answer","ack":"none","answeredCurrentQuestion":false,"requiresCorrectionConfirmation":false,"businessAnswer":null,"correctionField":null,"updates":{"name":null,"callbackPhone":null,"service":null,"projectLocation":null,"preferredDate":null,"preferredTime":null,"notes":null,"contactConsent":null}}',
    `Allowed action values: ${INTERPRETER_ACTIONS.join(', ')}.`,
    `Allowed ack values: ${INTERPRETER_ACKS.join(', ')}.`,
    'Set every field not explicitly stated in the latest caller message to null.',
    'Never copy unchanged values from currentLead into updates.',
    `CONTEXT: ${JSON.stringify(context)}`,
  ].join('\n');
}

export function applyRealtimeInterpretation(core, lead = {}, interpretation = {}, options = {}) {
  const before = { ...lead };
  const updates = interpretation.updates || {};
  let next = { ...lead };

  const matchedService = core.matchService(updates.service);
  if (matchedService) next.service = matchedService;

  if (updates.name) next = mergeLead(next, { name: cleanName(updates.name) });
  if (updates.callbackPhone) {
    const callbackPhone = core.normalizePhone(updates.callbackPhone);
    if (callbackPhone) next.callbackPhone = callbackPhone;
  }
  if (updates.projectLocation) next = mergeLead(next, { projectLocation: updates.projectLocation });

  if (updates.preferredDate) {
    const resolvedDate = core.resolvePreferredDate(updates.preferredDate, options.now || new Date());
    if (resolvedDate) next.preferredDate = resolvedDate;
  }
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
