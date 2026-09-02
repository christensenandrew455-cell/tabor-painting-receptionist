import { cleanText } from './business-context.js';

export const INTAKE_FIELD_ORDER = Object.freeze([
  'service',
  'name',
  'address',
  'schedule',
  'notes',
  'consent',
]);

export const SERVICE_QUESTION = 'What kind of work are you looking to have done?';
export const NAME_QUESTION = 'What name should I use for the service request?';
export const PROJECT_ADDRESS_QUESTION = "What's the full address where the service is needed?";
export const SCHEDULE_QUESTION = 'What day or date works best, and would you prefer morning or afternoon?';
export const ADDITIONAL_NOTES_PROMPT = 'Do you have any additional notes and/or business questions?';
export const MORE_NOTES_PROMPT = 'Do you have any other notes or business questions?';
export const ADDITIONAL_NOTES_DETAILS_PROMPT = 'What notes or business questions would you like me to add?';
export const UNKNOWN_BUSINESS_QUESTION_RESPONSE = "I'm sorry, I don't know that one. I'll add it to the notes.";
export const DEMO_UNKNOWN_BUSINESS_QUESTION_RESPONSE = "I'm sorry, I don't know that, but you can submit a service request.";
export const UNCLEAR_CALLER_RESPONSE = "I'm sorry, I didn't catch that.";
export const SUBMISSION_START_RESPONSE = "I'm sending it in now.";
export const SUBMISSION_SUCCESS_RESPONSE = "You're all set. Your service request has been submitted. If it's accepted, the business owner will follow up to confirm the exact date and time.";
export const SUBMISSION_FAILURE_RESPONSE = "I'm sorry, I can't send the service request.";

const STANDALONE_BACKCHANNELS = new Set([
  'hello',
  'hey',
  'hey there',
  'hi',
  'hi there',
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
  'hm',
  'hmm',
  'mm',
  'mmm',
  'uh',
  'um',
  'erm',
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
const STREET_SUFFIX_PATTERN_SOURCE = 'street|st\\.?|road|rd\\.?|avenue|ave\\.?|lane|ln\\.?|drive|dr\\.?|boulevard|blvd\\.?|way|court|ct\\.?|circle|place|pl\\.?|parkway|pkwy\\.?|highway|hwy\\.?|route';
const ADDRESS_PATTERN = new RegExp(
  `\\b\\d{1,6}\\s+[\\p{L}\\p{N}.'’ -]+\\b(?:${STREET_SUFFIX_PATTERN_SOURCE})\\b`,
  'iu',
);
const SPOKEN_HOUSE_NUMBER_VALUES = Object.freeze({
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
});
const SPOKEN_HOUSE_NUMBER_TENS = Object.freeze({
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
});
const SPOKEN_HOUSE_NUMBER_TOKEN_SOURCE = [
  ...Object.keys(SPOKEN_HOUSE_NUMBER_VALUES),
  ...Object.keys(SPOKEN_HOUSE_NUMBER_TENS),
  'hundred',
  'thousand',
].join('|');
const SPOKEN_HOUSE_NUMBER_PATTERN = new RegExp(
  `\\b(?:${SPOKEN_HOUSE_NUMBER_TOKEN_SOURCE})(?:[\\s-]+(?:${SPOKEN_HOUSE_NUMBER_TOKEN_SOURCE})){0,7}\\b(?=\\s+([\\p{L}.'’ -]+?)\\s+(?:${STREET_SUFFIX_PATTERN_SOURCE})\\b)`,
  'giu',
);
const SPOKEN_ADDRESS_STREET_NAME_BLOCKERS = /\b(?:at|for|in|of|on|the|to)\b/i;
const US_STATE_NAMES = Object.freeze([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
]);
const US_STATE_ABBREVIATIONS = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
]);
const US_STATE_NAME_PATTERN_SOURCE = US_STATE_NAMES
  .map((state) => state.replace(/ /g, '\\s+'))
  .join('|');
const US_STATE_ABBREVIATION_PATTERN_SOURCE = US_STATE_ABBREVIATIONS.join('|');
const US_STATE_NAME_END_PATTERN = new RegExp(
  `\\b(${US_STATE_NAME_PATTERN_SOURCE})[.!?]*$`,
  'i',
);
const US_STATE_ABBREVIATION_END_PATTERN = new RegExp(
  `\\b(${US_STATE_ABBREVIATION_PATTERN_SOURCE})[.!?]*$`,
);
const LOCALITY_BLOCKERS = /\b(?:college|school|university)\b/i;
const SCHEDULE_PATTERN = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow|morning|afternoon|evening|noon|midnight)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b|\b(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;

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
  const text = normalizedCallerText(value)
    .replace(/^(?:(?:actually|okay|ok|oh|so|uh+|um+|well)\s+)+/, '');
  return /^(?:yes|yeah|yep|yup|ja|si|sí|sim|oui|correct|right|that(?:'s| is) right)\b/i.test(text);
}

export function isClearNegative(value) {
  const text = normalizedCallerText(value)
    .replace(/^(?:(?:actually|okay|ok|oh|so|uh+|um+|well)\s+)+/, '');
  return /^(?:no|nope|nah|none|nothing|nie|não|nao|non|nein)\b/.test(text)
    || /\b(?:do not|don't|dont) have any\b/.test(text)
    || /\bno (?:more )?(?:notes|questions)\b/.test(text)
    || /\bnothing (?:else|to add)\b/.test(text)
    || /\b(?:actually )?no i (?:do not|don't|dont)$/.test(text)
    || /^(?:that'?s all|that'?s it|i'?m good|no more)$/i.test(text);
}

export function isConversationRepairRequest(value) {
  const text = normalizedCallerText(value);
  if (!text) return false;
  return /^(?:what|huh|pardon|sorry what)$/.test(text)
    || /^(?:no )?what(?:'s| is) (?:the|your) question\b/.test(text)
    || /^what (?:was|did you ask as) (?:the )?question\b/.test(text)
    || /^what did you (?:just )?ask(?: me)?\b/.test(text)
    || /\b(?:i )?(?:do not|don't|did not|didn't) (?:even )?(?:understand|follow|ask (?:a|the|that|any) question)\b/.test(text)
    || /\b(?:you never|you did not|you didn't) ask (?:me )?(?:a|the|that) question\b/.test(text)
    || /\bwhat (?:the hell )?(?:(?:are|were) you|you (?:are|were)) (?:even )?(?:talking|asking) about\b/.test(text)
    || /^(?:hello|are you (?:still )?there|can you hear me)\b/.test(text);
}

export function isHoldRequest(value) {
  const text = normalizedCallerText(value);
  if (!text) return false;
  return /^(?:please\s+)?(?:just\s+)?(?:wait|hold on|hang on|hold up)(?:\s+(?:(?:for|like)\s+)?(?:a|one|just one)?\s*(?:second|sec|moment|minute))?(?:\s+(?:wait|hold on|hang on))?(?:\s+please)?$/.test(text)
    || /^(?:can|could|would) you (?:please\s+)?(?:just\s+)?(?:wait|hold on|hang on)(?:\s+(?:(?:for|like)\s+)?(?:a|one|just one)?\s*(?:second|sec|moment|minute))?(?:\s+please)?$/.test(text)
    || /^(?:please\s+)?(?:just\s+)?(?:give me|i need|let me have|let me take)\s+(?:like\s+)?(?:a\s+|one\s+)?(?:second|sec|moment|minute)(?:\s+please)?$/.test(text)
    || /^(?:please\s+)?(?:just\s+)?(?:a|one)\s+(?:second|sec|moment|minute)(?:\s+please)?$/.test(text)
    || /^let me (?:think|check|look|find (?:that|it))(?:\s+for\s+(?:a|one)\s+(?:second|sec|moment|minute))?$/.test(text);
}

export function isHoldResume(value) {
  const text = normalizedCallerText(value);
  if (!text) return false;
  return /^(?:okay\s+|ok\s+|yeah\s+|yes\s+)?(?:i(?:'m| am)\s+)?(?:back|ready|ready now)$/.test(text)
    || /^(?:okay\s+|ok\s+)?(?:go ahead|i(?:'m| am) good now|we can continue|let's continue)$/.test(text);
}

export function isExplicitCorrectionRequest(value) {
  const text = normalizedCallerText(value);
  if (!text) return false;
  return /\b(?:scratch that|change that|correct that|make that|instead|i meant|what i meant was|let me (?:change|correct)|that(?:'s| is) (?:not right|wrong))\b/.test(text)
    || /(?:^|\b(?:no|sorry|actually) )i mean\b/.test(text)
    || /^(?:actually|wait)[, ]+\S/.test(text);
}

export function isAiIdentityQuestion(value) {
  const text = normalizedCallerText(value);
  if (!text) return false;
  return /\b(?:are you|is this)\s+(?:(?:an?|the)\s+)?(?:ai|artificial intelligence|bot|robot|automated (?:assistant|receptionist|system))\b/.test(text)
    || /\b(?:are you|is this)\s+(?:a\s+)?(?:real person|human)\b/.test(text);
}

export function requestedFieldExplanation(value, pendingField = '') {
  const text = normalizedCallerText(value);
  if (!text) return '';
  const asksWhy = /\bwhy\b/.test(text)
    || /\bwhat (?:do|does|did|would|will) (?:you|the business|they) need\b.*\bfor\b/.test(text)
    || /\bwhat is (?:that|it|this) for\b/.test(text);
  if (!asksWhy) return '';

  if (/\b(?:consent|contact permission|permission to contact|call me|contact me)\b/.test(text)) {
    return 'consent';
  }
  if (/\b(?:address|location|where i live|where we live|where the (?:job|project|work) is)\b/.test(text)) {
    return 'address';
  }
  if (/\b(?:date and time|day and time|date|appointment time|estimate time|what time|when)\b/.test(text)) {
    return 'schedule';
  }
  if (/\b(?:name|who i am|who we are)\b/.test(text)) return 'name';
  if (/\b(?:additional notes|notes|other details|project details)\b/.test(text)) return 'notes';
  if (/\b(?:service|kind of work|type of work|work i need|job|project)\b/.test(text)) return 'service';

  if (
    /^(?:why|why not)$/.test(text)
    || /\bwhy (?:do|does|did|would|will) (?:you|the business|they) need (?:that|it|this|the information)\b/.test(text)
    || /\bwhy (?:do|would|should|must) i (?:need|have) to (?:give|provide|share|tell)\b/.test(text)
    || /\bwhy are you asking (?:me )?(?:for )?(?:that|this|it)\b/.test(text)
  ) {
    return ['service', 'name', 'address', 'schedule', 'notes', 'consent'].includes(pendingField)
      ? pendingField
      : '';
  }
  return '';
}

export function isRequiredInformationRefusal(value, pendingField = '') {
  if (!['service', 'name', 'address', 'schedule', 'consent'].includes(pendingField)) return false;
  const text = normalizedCallerText(value);
  if (!text) return false;
  return /\b(?:do not|don't|won't|will not|can't|cannot)\s+(?:want to\s+)?(?:give|provide|share|tell)\b/.test(text)
    || /\b(?:not|never)\s+(?:giving|providing|sharing|telling)\b/.test(text)
    || /\bnot comfortable\s+(?:giving|providing|sharing|telling)\b/.test(text)
    || /\bi\s+(?:refuse|decline)\b/.test(text)
    || /\b(?:i(?:'d| would)\s+)?rather not\b/.test(text)
    || /\bnone of (?:your|the business(?:'s)?) business\b/.test(text)
    || /\byou (?:do not|don't) need (?:that|this|it|my|our|the)\b/.test(text)
    || /\bskip (?:that|this|it)\b/.test(text);
}

export function looksLikeBusinessQuestion(value) {
  if (isConversationRepairRequest(value)) return false;
  const text = cleanText(value).replace(
    /(?:[,;—-]\s*|\s+)(?:you know(?: what i(?:'|’)m talking about| what i mean)?|you (?:know|get) what i mean|(?:does|did) (?:that|this) make sense|if (?:that|this) makes sense|right|okay|ok)\s*[?.!]*$/i,
    '',
  ).trim();
  if (!text) return false;
  return /\?$/.test(text)
    || /^(?:what|when|where|why|how|who|which|do|does|did|can|could|is|are|will|would|should|has|have)\b/i.test(text)
    || /(?:^|[.!?;,]\s*|\band\s+)(?:what|when|where|why|how|who|which|do|does|did|can|could|is|are|will|would|should|has|have)\b/i.test(text)
    || /\b(?:i (?:am|was|'m) (?:just )?wondering|i(?:'d| would) like to know|can you tell me|do you know)\b/i.test(text)
    || /\b(?:i (?:just |already )?asked(?: you)?|my question (?:is|was)|what i (?:just )?asked (?:is|was))[,;:]?\s+(?:what|when|where|why|how|who|which|do|does|did|can|could|is|are|will|would|should|has|have)\b/i.test(text);
}

function nameShapedCandidate(value, { rejectActionForm = false } = {}) {
  const candidate = cleanText(value)
    .replace(/\s+(?:works(?:\s+(?:well|the\s+best))?|is\s+(?:fine|good)|please)[.!]*$/i, '')
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

export function hasUsableServiceAnswer(value, context = {}, { confirmedService = '' } = {}) {
  const text = cleanText(value);
  const normalized = normalizedCallerText(text);
  const requestShapedQuestion = /^(?:can|could|would) (?:you|the business|they)\s+(?!tell|explain|say|give)\S+/i.test(normalized);
  const matchesSuppliedService = resemblesSuppliedService(text, context);
  const modelMappedToSuppliedService = Boolean(confirmedService) && (context.services || []).some(
    (service) => normalizedCallerText(service?.name) === normalizedCallerText(confirmedService),
  );
  const hasServiceSignal = PROJECT_INTENT_PATTERN.test(text)
    || ACTION_FORM_PATTERN.test(text)
    || matchesSuppliedService;
  if (classifyCallerTranscript(text) !== 'meaningful' || isStandaloneBackchannel(text)) return false;
  if (
    isConversationRepairRequest(text)
    || (isClearAffirmative(text) && !hasServiceSignal)
    || isClearNegative(text)
  ) return false;
  if (
    looksLikeBusinessQuestion(text)
    && !requestShapedQuestion
    && !matchesSuppliedService
    && !modelMappedToSuppliedService
  ) return false;
  if ((ADDRESS_PATTERN.test(text) || SCHEDULE_PATTERN.test(text)) && !hasServiceSignal) return false;
  if (
    callerVolunteeredName(text)
    && !PROJECT_INTENT_PATTERN.test(text)
    && !ACTION_FORM_PATTERN.test(text)
    && !resemblesSuppliedService(text, context)
  ) return false;
  if (NON_SERVICE_ANSWERS.has(normalized)) return false;
  return normalized.split(' ').some((token) => token.length >= 2);
}

function terminalStateMatch(value) {
  const text = String(value ?? '');
  return [US_STATE_NAME_END_PATTERN, US_STATE_ABBREVIATION_END_PATTERN]
    .map((pattern) => text.match(pattern))
    .filter((match) => match && match.index !== undefined)
    .sort((left, right) => right.index - left.index)[0] || null;
}

function firstTerminalStateMatch(value) {
  const text = String(value ?? '');
  let searchFrom = 0;
  for (const segment of text.split(/(?<=[.!?])\s+/)) {
    const segmentStart = text.indexOf(segment, searchFrom);
    searchFrom = Math.max(searchFrom, segmentStart + segment.length);
    const state = terminalStateMatch(segment);
    if (!state || state.index === undefined) continue;
    state.index += Math.max(0, segmentStart);
    return state;
  }
  return null;
}

function parsedSpokenHouseNumber(value) {
  const tokens = normalizedCallerText(value).split(' ').filter(Boolean);
  if (!tokens.length) return '';

  if (tokens.includes('hundred') || tokens.includes('thousand')) {
    let total = 0;
    let current = 0;
    for (const token of tokens) {
      if (token === 'hundred') {
        current = (current || 1) * 100;
      } else if (token === 'thousand') {
        total += (current || 1) * 1_000;
        current = 0;
      } else if (SPOKEN_HOUSE_NUMBER_TENS[token] !== undefined) {
        current += SPOKEN_HOUSE_NUMBER_TENS[token];
      } else if (SPOKEN_HOUSE_NUMBER_VALUES[token] !== undefined) {
        current += SPOKEN_HOUSE_NUMBER_VALUES[token];
      } else {
        return '';
      }
    }
    const number = total + current;
    return number >= 1 && number <= 999_999 ? String(number) : '';
  }

  const chunks = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (SPOKEN_HOUSE_NUMBER_TENS[token] !== undefined) {
      let value = SPOKEN_HOUSE_NUMBER_TENS[token];
      const next = tokens[index + 1];
      if (
        next
        && SPOKEN_HOUSE_NUMBER_VALUES[next] >= 1
        && SPOKEN_HOUSE_NUMBER_VALUES[next] <= 9
      ) {
        value += SPOKEN_HOUSE_NUMBER_VALUES[next];
        index += 1;
      }
      chunks.push(String(value));
      continue;
    }
    const value = SPOKEN_HOUSE_NUMBER_VALUES[token];
    if (value === undefined) return '';
    chunks.push(String(value));
  }
  const number = chunks.join('');
  return /^\d{1,6}$/.test(number) && Number(number) >= 1 ? String(Number(number)) : '';
}

export function normalizeSpokenAddressNumber(value) {
  return cleanText(value).replace(
    SPOKEN_HOUSE_NUMBER_PATTERN,
    (spoken, streetName) => (
      SPOKEN_ADDRESS_STREET_NAME_BLOCKERS.test(streetName)
        ? spoken
        : (parsedSpokenHouseNumber(spoken) || spoken)
    ),
  );
}

export function fullAddressFromCallerText(value) {
  const text = normalizeSpokenAddressNumber(value);
  const street = text.match(ADDRESS_PATTERN);
  if (!street || street.index === undefined) return '';

  let candidate = text
    .slice(street.index)
    .replace(/\s+(?:that(?:'s| is) (?:all|it)|thanks?)\s*[.!?]*$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  const afterStreet = candidate.slice(street[0].length);
  const state = firstTerminalStateMatch(afterStreet);
  if (!state || state.index === undefined) return '';
  const localityText = afterStreet
    .slice(0, state.index)
    .replace(/^\s*(?:,|\bin\b)\s*/i, '')
    .replace(/[,;:.!?\s]+$/g, '')
    .trim();
  const localityWords = localityText.match(/[\p{L}][\p{L}.'’-]*/gu) || [];
  if (!localityWords.length || LOCALITY_BLOCKERS.test(localityText)) return '';
  candidate = candidate
    .slice(0, street[0].length + state.index + state[1].length)
    .trim();
  const remainder = candidate.slice(street[0].length)
    .replace(/^\s*(?:,|\bin\b)\s*/i, '')
    .trim();
  const locationWords = remainder.match(/[\p{L}][\p{L}.'’-]*/gu) || [];
  if (locationWords.length < 2) return '';
  return candidate;
}

export function streetAddressFromCallerText(value) {
  const street = normalizeSpokenAddressNumber(value).match(ADDRESS_PATTERN)?.[0];
  return cleanText(street).replace(/[.!?]+$/g, '');
}

function lastSpokenSegment(value) {
  return cleanText(value)
    .split(/(?<=[.!?])\s+/)
    .map((segment) => cleanText(segment))
    .filter(Boolean)
    .at(-1) || '';
}

function localityCandidate(value) {
  const candidate = lastSpokenSegment(value)
    .replace(/^(?:and\s+)?(?:it(?:'s| is| would be|'d be)|that(?:'s| is| would be|'d be)|the\s+(?:city|town)\s+is|in)\s+/i, '')
    .replace(/^[,;:\s]+|[,;:.!?\s]+$/g, '')
    .trim();
  if (!candidate || /\d/.test(candidate) || LOCALITY_BLOCKERS.test(candidate)) return '';
  const words = candidate.match(/[\p{L}][\p{L}.'’-]*/gu) || [];
  if (!words.length || words.length > 5) return '';
  if (cleanText(words.join(' ')).length !== cleanText(candidate).replace(/\s+/g, ' ').length) {
    return '';
  }
  return candidate;
}

export function addressPartsFromCallerText(value) {
  const text = normalizeSpokenAddressNumber(value);
  if (!text) return { street: '', locality: '', state: '' };

  const streetMatch = text.match(ADDRESS_PATTERN);
  const street = cleanText(streetMatch?.[0]).replace(/[.!?]+$/g, '');
  let localitySource = text;
  let state = '';

  if (streetMatch && streetMatch.index !== undefined) {
    const afterStreet = text.slice(streetMatch.index + streetMatch[0].length);
    const stateMatch = firstTerminalStateMatch(afterStreet);
    if (stateMatch && stateMatch.index !== undefined) {
      state = cleanText(stateMatch[1]).replace(/\s+/g, ' ');
      localitySource = afterStreet.slice(0, stateMatch.index);
    } else {
      localitySource = afterStreet;
    }
  } else {
    const segment = lastSpokenSegment(text);
    const stateMatch = terminalStateMatch(segment);
    if (stateMatch && stateMatch.index !== undefined) {
      state = cleanText(stateMatch[1]).replace(/\s+/g, ' ');
      localitySource = segment.slice(0, stateMatch.index);
    } else {
      localitySource = segment;
    }
  }

  const locality = localityCandidate(localitySource);
  return {
    street,
    locality: normalizedCallerText(locality) === normalizedCallerText(state) ? '' : locality,
    state,
  };
}

function localityAndStateFromTurns(value, previousValue = '') {
  const segment = lastSpokenSegment(value);
  const state = terminalStateMatch(segment);
  if (!state || state.index === undefined) return '';

  let beforeState = segment.slice(0, state.index)
    .replace(/[,;:\s]+$/g, '')
    .trim();
  if (beforeState.includes(',')) beforeState = beforeState.split(',').at(-1).trim();
  const city = localityCandidate(beforeState) || localityCandidate(previousValue);
  if (!city) return '';
  return `${city}, ${cleanText(state[1]).replace(/\s+/g, ' ')}`;
}

export function fullAddressFromCallerHistory(values = []) {
  const turns = Array.isArray(values) ? values.map(cleanText).filter(Boolean) : [];
  if (!turns.length) return '';

  let street = '';
  let streetIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    street = streetAddressFromCallerText(turns[index]);
    if (street) {
      streetIndex = index;
      break;
    }
  }
  if (!street) return '';
  const direct = fullAddressFromCallerText(turns[streetIndex]);
  if (direct) return direct;
  if (streetIndex === turns.length - 1) return '';

  for (let index = turns.length - 1; index > streetIndex; index -= 1) {
    const locality = localityAndStateFromTurns(turns[index], turns[index - 1]);
    if (locality) return `${street}, ${locality}`;
  }
  return '';
}

export function looksLikeUnfinishedThought(value) {
  const raw = cleanText(value);
  const text = normalizedCallerText(raw);
  if (!text) return false;
  if (/\.{2,}\s*$/.test(raw)) return true;
  if (/^(?:can|could|would) you$/.test(text)) return true;
  if (/\b(?:and|because|but|can|could|if|or|so|the|to|would)\s*$/.test(text)) return true;
  return /\b(?:i (?:was|am|'m) wondering if|can you|could you|would you)\s+(?:the business|you|you guys|they)?\s*$/.test(text);
}

function hasExplicitNameCue(value) {
  const text = cleanText(value);
  if (callerVolunteeredName(text)) return true;
  const prefixed = text.match(
    /\b(?:call me|you can use|please use|put (?:it|this|the estimate|the service request) under|the name is|it(?:'s| is))\s+([^,;!?]+)/iu,
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
    .replace(/\s+(?:works(?:\s+(?:well|the\s+best))?|is\s+(?:fine|good)|please)[.!]*$/i, '')
    .replace(/[.!]+$/g, '')
    .trim();
  if (/^(?:i|we|you|he|she|they|it)\b/i.test(candidate)) return false;
  if (ACTION_FORM_PATTERN.test(candidate)) return false;
  return nameShapedCandidate(candidate);
}

export function spokenBusinessName(value) {
  return cleanText(value).replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || 'the business';
}

export function contactConsentQuestion(businessName) {
  const business = spokenBusinessName(businessName);
  return `Okay, thanks. One more question. Do you consent to being contacted by ${business}?`;
}
