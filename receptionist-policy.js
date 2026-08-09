import { cleanText } from './business-context.js';

export const INTAKE_FIELD_ORDER = Object.freeze([
  'service',
  'name',
  'address',
  'schedule',
  'notes',
  'consent',
]);

export const SERVICE_QUESTION = 'What kind of work do you need done?';
export const NAME_QUESTION = 'What name should I use for the estimate request?';
export const PROJECT_ADDRESS_QUESTION = "What's the full project address?";
export const SCHEDULE_QUESTION = 'What date and time would work best for the estimate?';
export const NOTES_AND_QUESTIONS_PROMPT = 'Do you have any notes or questions for the business?';
export const MORE_NOTES_AND_QUESTIONS_PROMPT = 'Do you have any other notes or questions for the business?';
export const NOTES_DETAILS_PROMPT = 'What notes or questions do you have for the business?';
export const UNKNOWN_BUSINESS_QUESTION_RESPONSE = "I'm sorry, I don't know that. I'll add that question to the notes.";
export const UNCLEAR_CALLER_RESPONSE = "I'm sorry, I didn't catch that.";
export const SUBMISSION_START_RESPONSE = "Okay, thanks for confirming. I'm sending the estimate request in now.";
export const SUBMISSION_SUCCESS_RESPONSE = "You're all set. Your estimate request has been submitted.";
export const SUBMISSION_FAILURE_RESPONSE = "I'm sorry, I can't send the estimate request.";

const STANDALONE_BACKCHANNELS = new Set([
  'oh',
  'okay',
  'ok',
  'yeah',
  'yep',
  'yup',
  'right',
  'sure',
  'alright',
  'all right',
  'got it',
  'uh huh',
  'mm hmm',
  'mhm',
]);

const NON_SERVICE_ANSWERS = new Set([
  'anything',
  'help',
  'i do not know',
  "i don't know",
  'no idea',
  'not sure',
  'something',
  'whatever',
  'work',
  'a job',
  'the job',
  'a project',
  'the project',
]);

const PROJECT_INTENT_PATTERN = /\b(?:build|clean|damage|estimate|fix|have|help|install|job|need|project|quote|repair|replace|service|want|work)\b/i;
const ACTION_FORM_PATTERN = /\b[\p{L}]{2,}(?:ing|ed)\b/iu;
const NAME_BLOCKERS = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'their', 'this', 'that', 'it', 'not',
  'to', 'for', 'from', 'with', 'without', 'under', 'over', 'inside', 'outside',
]);
const ADDRESS_PATTERN = /\b\d{1,6}\s+[\p{L}\p{N}.'’ -]+\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|court|ct\.?|circle|place|pl\.?|parkway|pkwy\.?|highway|hwy\.?|route)\b/iu;
const SCHEDULE_PATTERN = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow|morning|afternoon|evening|noon|midnight)\b|\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;

export function normalizedCallerText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

export function isStandaloneBackchannel(value) {
  return STANDALONE_BACKCHANNELS.has(normalizedCallerText(value));
}

export function classifyCallerTranscript(value) {
  const text = cleanText(value);
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return 'filler';

  const normalized = normalizedCallerText(text);
  if (!normalized) return 'filler';
  if (/^(?:어|음)$/u.test(normalized)) return 'filler';
  if (/^(?:um+|uh+|erm+|er+|hmm+|hm+|mm+|mmm+|ah+|eh+|well|like|ay|oh)$/.test(normalized)) {
    return 'filler';
  }
  if (/^(?:a|an|the|my|our|i|we|it'?s|that'?s)$/.test(normalized)) return 'filler';
  if (/\b(?:um+|uh+|erm+|er+)\s*$/.test(normalized)) return 'filler';
  if (/\b(?:probably|maybe)\s+like$/.test(normalized)) return 'filler';
  if (/^(?:i would|i'd|we would|we'd) (?:like|prefer|want)(?: to)?$/.test(normalized)) {
    return 'filler';
  }
  if (/^(?:a{2,}|e{2,}|o{2,})$/.test(normalized)) return 'unclear';
  return 'meaningful';
}

export function isClearAffirmative(value) {
  return /^(?:yes|yeah|yep|yup|ja|correct|right|that(?:'s| is) right)\b/i.test(cleanText(value));
}

export function isClearNegative(value) {
  const text = normalizedCallerText(value);
  return /^(?:no|nope|nah|none|nothing|nie)\b/.test(text)
    || /\b(?:do not|don't|dont) have any\b/.test(text)
    || /\bno (?:more )?(?:notes|questions)\b/.test(text)
    || /\bnothing (?:else|to add)\b/.test(text)
    || /^(?:that'?s all|that'?s it|i'?m good|no more)$/i.test(text);
}

export function isConversationRepairRequest(value) {
  const text = normalizedCallerText(value);
  if (!text) return false;
  return /^(?:what|huh|pardon|sorry what)$/.test(text)
    || /^(?:no )?what(?:'s| is) (?:the|your) question\b/.test(text)
    || /\b(?:i )?(?:do not|don't|did not|didn't) (?:even )?(?:understand|follow|ask (?:a|the|that|any) question)\b/.test(text)
    || /\b(?:you never|you did not|you didn't) ask (?:me )?(?:a|the|that) question\b/.test(text)
    || /\bwhat (?:the hell )?(?:(?:are|were) you|you (?:are|were)) (?:even )?(?:talking|asking) about\b/.test(text)
    || /^(?:hello|are you (?:still )?there|can you hear me)\b/.test(text);
}

export function looksLikeBusinessQuestion(value) {
  if (isConversationRepairRequest(value)) return false;
  const text = cleanText(value).replace(
    /(?:[,;—-]\s*|\s+)(?:you know(?: what i(?:'|’)m talking about| what i mean)?|you (?:know|get) what i mean|(?:does|did) (?:that|this) make sense|if (?:that|this) makes sense|right|okay|ok)\s*[?.!]*$/i,
    '',
  ).trim();
  if (!text) return false;
  return /\?$/.test(text)
    || /^(?:what|when|where|why|how|do|does|can|could|is|are|will|would)\b/i.test(text);
}

function nameShapedCandidate(value, { rejectActionForm = false } = {}) {
  const candidate = cleanText(value)
    .replace(/\s+(?:works(?:\s+the\s+best)?|is\s+(?:fine|good)|please)[.!]*$/i, '')
    .replace(/[.!]+$/g, '')
    .trim();
  if (!candidate || (rejectActionForm && ACTION_FORM_PATTERN.test(candidate))) return false;
  const parts = candidate.split(/\s+/).filter(Boolean);
  return parts.length >= 1
    && parts.length <= 5
    && parts.every((part) => /^[\p{L}][\p{L}'’.-]*$/u.test(part))
    && !parts.some((part) => NAME_BLOCKERS.has(normalizedCallerText(part)));
}

function introducedNameCandidate(value) {
  const text = cleanText(value);
  const match = text.match(/\b(my name is|this is|i am|i'm|i’m)\s+([^,;!?]+)/iu);
  if (!match) return '';
  return cleanText(match[2].split(
    /\b(?:and|but|because|calling|doing|getting|having|hoping|looking|needing|planning|trying|wanting|working)\b/iu,
  )[0]);
}

export function callerVolunteeredName(value) {
  const text = cleanText(value);
  const candidate = introducedNameCandidate(text);
  if (!candidate) return false;
  const isExplicitIntroduction = /\b(?:my name is|this is)\b/iu.test(text);
  return nameShapedCandidate(candidate, { rejectActionForm: !isExplicitIntroduction });
}

export function hasUsableServiceAnswer(value, context = {}) {
  const text = cleanText(value);
  const normalized = normalizedCallerText(text);
  if (classifyCallerTranscript(text) !== 'meaningful' || isStandaloneBackchannel(text)) return false;
  if (isConversationRepairRequest(text) || isClearAffirmative(text) || isClearNegative(text)) return false;
  if (looksLikeBusinessQuestion(text) || ADDRESS_PATTERN.test(text) || SCHEDULE_PATTERN.test(text)) return false;
  if (
    callerVolunteeredName(text)
    && !PROJECT_INTENT_PATTERN.test(text)
    && !ACTION_FORM_PATTERN.test(text)
    && !resemblesSuppliedService(text, context)
  ) return false;
  if (NON_SERVICE_ANSWERS.has(normalized)) return false;
  return normalized.split(' ').some((token) => token.length >= 2);
}

function hasExplicitNameCue(value) {
  const text = cleanText(value);
  if (callerVolunteeredName(text)) return true;
  const prefixed = text.match(
    /\b(?:call me|you can use|please use|put (?:it|this|the estimate) under|the name is|it(?:'s| is))\s+([^,;!?]+)/iu,
  );
  if (prefixed) {
    const candidate = prefixed[1].replace(/\s+and\b[\s\S]*$/i, '').trim();
    if (candidate && !PROJECT_INTENT_PATTERN.test(candidate)) return true;
  }
  return /^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,4}\s+is my name[.!]*$/iu.test(text);
}

function resemblesSuppliedService(value, context = {}) {
  if (!Array.isArray(context.services) || !context.services.length) return false;
  const callerTokens = new Set(normalizedCallerText(value).split(' ').filter((token) => token.length >= 3));
  for (const service of context.services) {
    const serviceName = normalizedCallerText(service?.name);
    const serviceText = normalizedCallerText(
      `${cleanText(service?.name)} ${cleanText(service?.description)}`,
    );
    if (!serviceText) continue;
    if (serviceName && normalizedCallerText(value).includes(serviceName)) return true;
    const overlap = serviceText
      .split(' ')
      .filter((token) => token.length >= 3 && callerTokens.has(token));
    if (new Set(overlap).size >= 2) return true;
  }
  return false;
}

export function hasUsableNameAnswer(value, context = {}) {
  const text = cleanText(value);
  if (!text || isStandaloneBackchannel(text)) return false;
  if (isConversationRepairRequest(text) || isClearAffirmative(text) || isClearNegative(text)) return false;
  if (ADDRESS_PATTERN.test(text) || SCHEDULE_PATTERN.test(text)) return false;
  if (hasExplicitNameCue(text)) return true;
  if (
    looksLikeBusinessQuestion(text)
    || PROJECT_INTENT_PATTERN.test(text)
    || resemblesSuppliedService(text, context)
  ) return false;

  const candidate = text
    .replace(/^(?:just\s+|use\s+)/i, '')
    .replace(/\s+(?:works(?:\s+the\s+best)?|is\s+(?:fine|good)|please)[.!]*$/i, '')
    .replace(/[.!]+$/g, '')
    .trim();
  if (/^(?:i|we|you|he|she|they|it)\b/i.test(candidate)) return false;
  if (ACTION_FORM_PATTERN.test(candidate)) return false;
  return nameShapedCandidate(candidate);
}

export function spokenBusinessName(value) {
  return cleanText(value).replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || 'the business';
}

export function contactConsentQuestion(businessName, hasNotes) {
  const business = spokenBusinessName(businessName);
  return hasNotes
    ? `Okay, thanks for the notes. One more question. Do you consent to being contacted by ${business}?`
    : `Okay, thanks. One more question. Do you consent to being contacted by ${business}?`;
}
