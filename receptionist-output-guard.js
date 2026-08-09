import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { cleanText } from './business-context.js';
import { normalizeRequestedTime } from './intake.js';
import { createOpenAiReceptionist } from './openai-receptionist.js';

const OLD_SERVICE_QUESTION = 'What service were you looking for?';
const SERVICE_QUESTION = 'What kind of work do you need done?';
const OLD_SUBMISSION_START_RESPONSE = "I'm submitting your estimate request now.";
const SUBMISSION_START_RESPONSE = "Okay, thanks for confirming. I'm sending the estimate request in now.";
const SUBMISSION_FAILURE_RESPONSE = "I'm sorry, I can't send the estimate request.";
const OLD_GOODBYE_PREFIX = 'Thanks for calling';
const GOODBYE_PREFIX = 'Thank you for calling';
const OLD_NOTES_AND_QUESTIONS_PROMPT = "Do you have any notes for the project or any questions about the business? I may be able to answer some, and if not, I'll add them to the notes.";
const PREVIOUS_NOTES_AND_QUESTIONS_PROMPT = "Do you have any notes for the project or any questions about the business you'd like me to help with or pass along?";
const NOTES_AND_QUESTIONS_PROMPT = 'Do you have any notes or questions for the business?';
const MORE_NOTES_AND_QUESTIONS_PROMPT = 'Do you have any other notes or questions for the business?';
const NOTES_DETAILS_PROMPT = 'What notes or questions do you have for the business?';
const OLD_UNKNOWN_BUSINESS_QUESTION_RESPONSE = "I'm sorry, I don't really know that. I'll add it to the notes.";
const PREVIOUS_UNKNOWN_BUSINESS_QUESTION_RESPONSE = "Okay, I'll add it to the notes.";
const UNKNOWN_BUSINESS_QUESTION_RESPONSE = "I'm sorry, I don't know that. I'll add that question to the notes.";
const OLD_PRICE_QUESTION_RESPONSE = 'The price depends on the estimate.';
const OLD_RESPONSE_TIME_QUESTION_RESPONSE = "I don't know exactly when, but the longest it will take is a week to accept or decline your estimate request.";
const UNCLEAR_CALLER_RESPONSE = "I'm sorry, I didn't catch that.";
const MAX_REPAIR_ATTEMPTS = 3;
const COMPLETABLE_INTAKE_FIELDS = new Set([
  'service',
  'name',
  'address',
  'schedule',
  'notes',
  'consent',
]);

const CONDITIONAL_TRANSITION_PATTERNS = Object.freeze([
  /\b(?:one sec(?:ond)?|just a sec(?:ond)?|one moment|just a moment)\b/i,
  /\b(?:hold on|give me (?:a )?(?:sec(?:ond)?|moment))\b/i,
  /\blet(?:(?:'|’)s| us) (?:move on|keep (?:this|it) moving|keep going|continue)\b/i,
  /\bmove on to\b/i,
  /\b(?:let me|i(?:'|’)ll|we(?:'|’)ll) (?:just )?(?:ask|get|grab|gather|collect|pull|bring|look|check|review|find|fetch|figure out|work out)\b/i,
  /\b(?:get|ask|move to) (?:the )?(?:next|one quick) (?:question|detail)\b/i,
  /\b(?:question|detail)\b[\s\S]{0,40}\bmove (?:things|this|it) along\b/i,
]);

const PROCESS_NARRATION_PATTERNS = Object.freeze([
  /\blet me think\b/i,
  /\bbest way to help\b/i,
  /\bnext (?:step|detail)\b/i,
  /\blet me (?:pull|update|refresh|clarify|check|double[- ]check|make sure|prepare|put together)\b/i,
  /\bi(?:'|’)ll (?:update|refresh|check|double[- ]check|pull|prepare|put together)\b/i,
  /\bquick recap\b/i,
  /\bget (?:the )?estimate summary ready\b/i,
  /\bi(?:'|’)m (?:still )?(?:getting|a bit )?confused\b/i,
  /\bpackage the estimate request\b/i,
  /\bi(?:'|’)ve got your name\b/i,
  /\btake your time\b/i,
  /\bwhenever you(?:'re| are) ready\b/i,
  /\bno problem\b/i,
  /\byou(?:'re| are) fine\b/i,
  /\ball good\b/i,
]);

const STANDALONE_ACKNOWLEDGMENT = /^(?:okay|ok|great|got it|okay great|okay got it|sounds good|thanks|thank you)[.!]*$/i;
const STREET_ADDRESS_PATTERN = /\b\d{1,6}\s+[a-z0-9.' -]+\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|court|ct\.?|circle|place|pl\.?|parkway|pkwy\.?|highway|hwy\.?|route)\b/i;
const US_STATE_PATTERN = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|a[klrz]|c[aot]|d[ec]|fl|ga|hi|i[adln]|k[sy]|la|m[adeinost]|n[cdehjmvty]|o[hkr]|pa|ri|s[cd]|t[nx]|ut|v[at]|w[aivy])\b/i;
const SCHEDULE_PATTERN = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow|morning|afternoon|evening|noon|midnight)\b|\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const STARTS_SCHEDULE_PATTERN = /^\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow|morning|afternoon|evening|noon|midnight)\b|^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const QUESTION_TOPIC_STOP_WORDS = new Set([
  'about', 'also', 'been', 'business', 'could', 'does', 'doing', 'guys', 'have', 'like',
  'long', 'normally', 'paint', 'painting', 'please', 'project', 'really', 'service', 'shed',
  'should', 'take', 'that', 'their', 'there', 'they', 'this', 'what', 'when', 'where', 'which',
  'would', 'work', 'your', 'you', 'with', 'from', 'just', 'know', 'much', 'thing', 'things',
]);

const CALLER_VALUE_EXAMPLE_REPLACEMENTS = Object.freeze([
  [
    'Infer obvious matches silently from the requested work and location; for example, painting a shed out back maps to Exterior Painting when that service exists.',
    'Infer obvious matches silently from the requested work and location without inventing or suggesting caller-specific details.',
  ],
  [
    "The caller's preferred date words, such as Tuesday, tomorrow, August 12, or 2026-08-12. The server converts this to an exact date.",
    "The caller's preferred date words exactly as stated. The server converts relative or calendar wording to an exact date.",
  ],
  [
    'The preferred time including AM or PM, such as 3:30 PM.',
    "The caller's preferred time including AM or PM when needed.",
  ],
  [
    'For example, after "I just need a couple of rooms painted in my house," ask only, "What name should I use for the estimate request?" Likewise, "I need the shed painted out back" should map silently to Exterior Painting when that service is supplied. ',
    '',
  ],
  [
    'For example, if they say the house needs a repaint, ask whether the repaint is inside or outside. ',
    '',
  ],
  [
    'For example, "2 in the afternoon" means 2:00 PM, and if the same turn later says "Thursday at 2," keep the already-stated PM context and record Thursday at 2:00 PM. ',
    '',
  ],
  [
    'For example, with a 9:00 AM through 4:00 PM window, "Monday at 3" means 3:00 PM. ',
    '',
  ],
  [
    'For example, if the notes-and-questions step receives "nun" in a context where the caller clearly means "none," treat it as no notes or questions instead of asking the same question again. ',
    '',
  ],
  [
    'When the caller says a relative date such as "Tuesday," keep those original date words in preferred_date.',
    "When the caller gives a relative date, keep the caller's original date words in preferred_date.",
  ],
]);

function normalized(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

function sameSpokenText(left, right) {
  return normalized(left) === normalized(right);
}

function endsWithSpokenText(value, suffix) {
  return normalized(value).endsWith(normalized(suffix));
}

function spokenBusinessName(value) {
  return cleanText(value).replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || 'the business';
}

function trimSpeechPunctuation(value) {
  return cleanText(value).replace(/[.?!]+$/g, '').trim();
}

function hasConditionalTransition(value) {
  return CONDITIONAL_TRANSITION_PATTERNS.some((pattern) => pattern.test(value));
}

function transitionRemainder(value) {
  let remainder = cleanText(value);
  for (const pattern of CONDITIONAL_TRANSITION_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    remainder = remainder.replace(new RegExp(pattern.source, flags), ' ');
  }
  return cleanText(remainder.replace(/^[\s,.;:!—-]+|[\s,.;:!—-]+$/g, ' '));
}

function hasActualQuestion(value) {
  return /\?\s*$/.test(cleanText(value));
}

function asksForZipCode(value) {
  const text = cleanText(value);
  if (!/\bzip(?:\s+code)?\b/i.test(text)) return false;
  return /\b(?:what(?:'s| is)|need|provide|give|tell|share|confirm|enter|supply)\b[\s\S]{0,80}\bzip(?:\s+code)?\b/i.test(text)
    || /\bzip(?:\s+code)?\b[\s\S]{0,80}\?/i.test(text);
}

function isDisallowedAddressClarification(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (asksForZipCode(text)) return true;
  if (/\b(?:apartment|apt\.?|suite|unit)\b/i.test(text)) {
    return /\b(?:address|project address)\b/i.test(text)
      || /\b(?:need|provide|give|tell|share|confirm|what(?:'s| is)|is there|do you have|any)\b[\s\S]{0,80}\b(?:apartment|apt\.?|suite|unit)\b/i.test(text)
      || /\b(?:apartment|apt\.?|suite|unit)\b[\s\S]{0,80}\b(?:number|for (?:the|your) address)\b/i.test(text);
  }
  return /\b(?:address|city|town|state)\b/i.test(text)
    && /\b(?:spell|spelled|spelling|did you mean|is that|is this|is it|confirm|correct|exactly)\b/i.test(text);
}

export function shouldBlockReceptionistOutput(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (sameSpokenText(text, SUBMISSION_START_RESPONSE)) return false;
  if (!/[A-Za-z0-9]/.test(text)) return true;
  if (STANDALONE_ACKNOWLEDGMENT.test(text)) return true;
  if (hasConditionalTransition(text)) {
    const remainder = transitionRemainder(text);
    if (!remainder || !hasActualQuestion(remainder)) return true;
    if (!PROCESS_NARRATION_PATTERNS.some((pattern) => pattern.test(remainder))) return false;
  }
  if (PROCESS_NARRATION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (isDisallowedAddressClarification(text)) return true;

  if (
    /complete project address/i.test(text)
    && /including\s+(?:street|address|city|state)/i.test(text)
  ) return true;

  return false;
}

export function callerTranscriptDisposition(value) {
  const text = cleanText(value);
  if (!text) return 'filler';
  if (!/[A-Za-z0-9]/.test(text)) return 'filler';

  const valueNormalized = normalized(text);
  if (!valueNormalized) return 'filler';
  if (/^(?:um+|uh+|erm+|er+|hmm+|hm+|mm+|mmm+|ah+|eh+|well|like|ay)$/.test(valueNormalized)) {
    return 'filler';
  }
  if (/\b(?:um+|uh+|erm+|er+)\s*$/.test(valueNormalized)) return 'filler';
  if (/\b(?:probably|maybe)\s+like$/.test(valueNormalized)) return 'filler';
  if (/^(?:a{2,}|e{2,}|o{2,})$/.test(valueNormalized)) return 'unclear';
  return 'meaningful';
}

function classifyPendingField(value) {
  const raw = cleanText(value);
  const text = normalized(value);
  if (/\bwhat service were you looking for\b/.test(text)) return 'service';
  if (/\bwhat kind of work do you need done\b/.test(text)) return 'service';
  if (/\bwhat name should i (?:use|put) (?:for|on) the estimate request\b/.test(text)) return 'name';
  if (/\bwhat'?s the complete project address\b/.test(text)) return 'address';
  if (/\bi was asking for (?:the )?(?:project )?address\b/.test(text)) return 'address';
  if (/\bwhat date and time would work best for the estimate\b/.test(text)) return 'schedule';
  if (/\bi was asking for (?:the )?estimate date and time\b/.test(text)) return 'schedule';
  if (/\bdo you have any (?:other )?notes or questions for the business\b/.test(text)) return 'notes';
  if (/\bwhat notes or questions do you have for the business\b/.test(text)) return 'notes';
  if (/\bdo you have any notes for the project or any questions about the business\b/.test(text)) return 'notes';
  if (/\bdo you consent to being contacted by\b/.test(text)) return 'consent';
  if (/\bdoes that all sound right\b/.test(text)) return 'summary';

  const questionLike = /\?\s*$/.test(raw)
    || /^(?:what|which|when|who|can|could|may|do|would)\b/.test(text);
  if (!questionLike) return '';
  if (/\b(?:what|which) (?:kind of )?(?:work|service)\b/.test(text)) return 'service';
  if (/\b(?:your name|caller'?s name)\b/.test(text) || /\bwho should .* estimate\b/.test(text)) {
    return 'name';
  }
  if (/\b(?:project )?address\b/.test(text)) return 'address';
  if (/\b(?:city|town|state)\b/.test(text)) return 'address';
  if (/\b(?:date and time|estimate (?:date|time)|what (?:date|time)|when .* estimate)\b/.test(text)) {
    return 'schedule';
  }
  if (/\b(?:what|which) (?:day|date|time)\b/.test(text) || /\b(?:am|pm)\b.*\?$/.test(text)) {
    return 'schedule';
  }
  if (/\b(?:notes? or questions?|additional notes?|anything else to add)\b/.test(text)) {
    return 'notes';
  }
  if (/\b(?:permission|consent)\b.*\bcontact/.test(text)) return 'consent';
  return '';
}

function isClearNegative(value) {
  const text = normalized(value);
  return /^(?:no|nope|nah|none|nothing|nie)\b/.test(text)
    || /\b(?:do not|don't|dont) have any\b/.test(text)
    || /\bno (?:more )?(?:notes|questions)\b/.test(text)
    || /\bnothing (?:else|to add)\b/.test(text)
    || /^(?:that'?s all|that'?s it|i'?m good|no more)$/i.test(text);
}

function isClearAffirmative(value) {
  return /^(?:yes|yeah|yep|yup|ja|correct|right|that(?:'s| is) right)\b/i.test(cleanText(value));
}

function isConversationRepairRequest(value) {
  const text = normalized(value);
  if (!text) return false;
  return /^(?:what|huh|pardon|sorry what)$/.test(text)
    || /^(?:no )?what(?:'s| is) (?:the|your) question\b/.test(text)
    || /\b(?:i )?(?:do not|don't|did not|didn't) (?:even )?(?:understand|follow|ask (?:a|the|that|any) question)\b/.test(text)
    || /\b(?:you never|you did not|you didn't) ask (?:me )?(?:a|the|that) question\b/.test(text)
    || /\bwhat (?:the hell )?(?:(?:are|were) you|you (?:are|were)) (?:even )?(?:talking|asking) about\b/.test(text)
    || /^(?:hello|are you (?:still )?there|can you hear me)\b/.test(text);
}

function notesStepCompleted(value) {
  return isClearNegative(value) && !isConversationRepairRequest(value);
}

function looksLikeBusinessQuestion(value) {
  if (isConversationRepairRequest(value)) return false;
  const text = cleanText(value).replace(
    /(?:[,;—-]\s*|\s+)(?:you know(?: what i(?:'|’)m talking about| what i mean)?|you (?:know|get) what i mean|(?:does|did) (?:that|this) make sense|if (?:that|this) makes sense|right|okay|ok)\s*[?.!]*$/i,
    '',
  ).trim();
  if (!text) return false;
  return /\?$/.test(text)
    || /^(?:what|when|where|why|how|do|does|can|could|is|are|will|would)\b/i.test(text);
}

function callerVolunteeredName(value) {
  const text = cleanText(value);
  return /\b(?:my name is|this is)\s+[\p{L}][\p{L}'’.-]*/iu.test(text)
    || /\bi(?: am|'m|’m)\s+(?!looking|calling|trying|interested|hoping|wanting|needing|getting|having|probably\b)[\p{L}][\p{L}'’.-]*/iu.test(text);
}

function normalizedTimeMinutes(value) {
  const match = cleanText(value).match(/^(1[0-2]|[1-9]):([0-5]\d)\s+(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(match[2]);
}

function configuredEstimateMinutes(value) {
  const text = cleanText(value);
  const twentyFourHour = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFourHour) return Number(twentyFourHour[1]) * 60 + Number(twentyFourHour[2]);
  try {
    return normalizedTimeMinutes(normalizeRequestedTime(text));
  } catch {
    return null;
  }
}

function scheduleTimeFromCaller(value) {
  const text = cleanText(value);
  if (/\bnoon\b/i.test(text)) return '12 PM';
  if (/\bmidnight\b/i.test(text)) return '12 AM';
  const afterAt = text.match(
    /\b(?:at|around|about)\s+(\d{1,2}(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)?)\b/i,
  );
  if (afterAt) return afterAt[1];
  const explicit = text.match(/\b(\d{1,2}(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?))\b/i);
  if (explicit) return explicit[1];
  const cuedBareTime = text.match(
    /\b(?:do|for|prefer|want|make it|say)\s+(\d{1,2}(?::[0-5]\d)?)\b/i,
  );
  if (cuedBareTime) return cuedBareTime[1];
  const beforeWeekday = text.match(
    /\b(\d{1,2}(?::[0-5]\d)?)\s+(?:on\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  );
  return beforeWeekday ? beforeWeekday[1] : '';
}

function hasCompleteAvailableSchedule(value, context = {}) {
  const text = cleanText(value);
  const hasDate = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{1,2}[/-]\d{1,2}\b/i.test(text);
  const callerTime = scheduleTimeFromCaller(text);
  if (!hasDate || !callerTime) return false;

  let requestedMinutes;
  try {
    requestedMinutes = normalizedTimeMinutes(normalizeRequestedTime(callerTime, context));
  } catch {
    return false;
  }
  if (requestedMinutes === null) return false;

  const earliest = configuredEstimateMinutes(context.earliestEstimateStart);
  const latest = configuredEstimateMinutes(context.latestEstimateStart);
  return (!Number.isFinite(earliest) || requestedMinutes >= earliest)
    && (!Number.isFinite(latest) || requestedMinutes <= latest);
}

function gatheredBusinessDataText(context = {}) {
  const services = Array.isArray(context.services)
    ? context.services.map((service) => `${cleanText(service?.name)} ${cleanText(service?.description)}`).join(' ')
    : '';
  const weekdays = Array.isArray(context.estimateWeekdays) ? context.estimateWeekdays.join(' ') : '';
  return normalized([
    context.knowledgeJson,
    services,
    weekdays,
    context.earliestEstimateStart,
    context.latestEstimateStart,
  ].filter(Boolean).join(' '));
}

function businessDataSupportsQuestion(value, context = {}) {
  const question = normalized(value);
  if (!question) return false;
  const businessData = gatheredBusinessDataText(context);

  if (/\b(?:what|which) services?\b/.test(question) || /\bservices? (?:do|does) .* offer\b/.test(question)) {
    return Array.isArray(context.services) && context.services.length > 0;
  }
  if (/\bservice areas?\b/.test(question) || /\b(?:do|does) .* serve\b/.test(question) || /\bwhere .* (?:work|serve)\b/.test(question)) {
    return /\b(?:serviceareas?|service area|areas served|locations?|serve)\b/.test(businessData);
  }
  if (/\b(?:business )?hours?\b/.test(question) || /\b(?:when|what time) .* (?:open|close)\b/.test(question)) {
    return /\b(?:businesshours?|hours|open|close)\b/.test(businessData);
  }
  if (/\bestimate (?:days?|hours?|times?|availability)\b/.test(question) || /\bwhen .* estimate\b/.test(question)) {
    return Boolean(
      (Array.isArray(context.estimateWeekdays) && context.estimateWeekdays.length)
      || cleanText(context.earliestEstimateStart)
      || cleanText(context.latestEstimateStart)
      || /\bestimate\b/.test(businessData)
    );
  }
  if (/\b(?:price|pricing|cost|how much|price range|rate|fee)\b/.test(question)) {
    return /\b(?:price|pricing|cost|rate|rates|fee|fees|dollar|usd)\b/.test(businessData);
  }
  if (/\bhow long\b/.test(question) || /\b(?:take|takes)\b.*\b(?:job|project|work|paint|painting)\b/.test(question)) {
    return /\b(?:duration|timeline|turnaround|timeframe|jobduration|projectduration|takes)\b/.test(businessData)
      || /\b(?:day|days|hour|hours|week|weeks)\s+(?:to|for)\b/.test(businessData);
  }
  if (/\b(?:get back|hear back|response time|respond|accept|decline)\b/.test(question)) {
    return /\b(?:get back|hear back|response time|responsetime|respond|accept|decline|turnaround)\b/.test(businessData);
  }
  if (/\b(?:warranty|guarantee)\b/.test(question)) {
    return /\b(?:warranty|guarantee)\b/.test(businessData);
  }

  const businessTokens = new Set(businessData.split(' ').filter(Boolean));
  const topicTokens = question.split(' ').filter(
    (token) => token.length >= 4 && !QUESTION_TOPIC_STOP_WORDS.has(token),
  );
  return topicTokens.some((token) => businessTokens.has(token));
}

function looksLikeStreetAddress(value) {
  return STREET_ADDRESS_PATTERN.test(cleanText(value));
}

function hasCompleteProjectAddress(value) {
  const text = cleanText(value);
  const street = text.match(STREET_ADDRESS_PATTERN);
  if (!street) return false;
  const location = text.slice((street.index || 0) + street[0].length);
  const state = location.match(US_STATE_PATTERN);
  if (!state) return false;
  const locality = location
    .slice(0, state.index)
    .replace(/\b(?:in|at)\b/gi, ' ')
    .replace(/[^a-z]+/gi, ' ')
    .trim();
  return Boolean(locality);
}

function looksLikeScheduleAnswer(value) {
  return SCHEDULE_PATTERN.test(cleanText(value));
}

function startsLikeStreetAddress(value) {
  const text = cleanText(value);
  const match = text.match(STREET_ADDRESS_PATTERN);
  return Boolean(match && match.index === 0);
}

function startsLikeScheduleAnswer(value) {
  return STARTS_SCHEDULE_PATTERN.test(cleanText(value));
}

function callerAnsweredDifferentField(field, value) {
  if (!field) return false;
  const address = looksLikeStreetAddress(value);
  const schedule = looksLikeScheduleAnswer(value);
  if (field === 'name') return startsLikeStreetAddress(value) || startsLikeScheduleAnswer(value);
  if (field === 'address') return schedule && !address;
  if (field === 'schedule') return address && !schedule;
  if (field === 'service') return startsLikeStreetAddress(value) || startsLikeScheduleAnswer(value);
  return false;
}

function recoveryQuestionForField(field) {
  switch (field) {
    case 'service':
      return `I'm sorry, I was asking what kind of work you need done. ${SERVICE_QUESTION}`;
    case 'name':
      return "I'm sorry, I was asking for your name. What name should I use for the estimate request?";
    case 'address':
      return "I'm sorry, I was asking for the project address. What's the complete project address?";
    case 'schedule':
      return "I'm sorry, I was asking for the estimate date and time. What date and time would work best for the estimate?";
    default:
      return '';
  }
}

function contactConsentQuestionForBusiness(businessName, hasNotes) {
  const business = spokenBusinessName(businessName);
  return hasNotes
    ? `Okay, thanks for the notes. One more question. Do you consent to being contacted by ${business}?`
    : `Okay, thanks. One more question. Do you consent to being contacted by ${business}?`;
}

function exactSpeechInstruction(text, extra = '') {
  return `Say exactly: ${JSON.stringify(text)} Do not add anything before or after it.${extra ? ` ${extra}` : ''}`;
}

export function buildPreparedSummarySpeech(summary = {}) {
  const name = trimSpeechPunctuation(summary.name);
  const service = trimSpeechPunctuation(summary.service);
  const address = trimSpeechPunctuation(summary.address);
  const preferredDateAndTime = trimSpeechPunctuation(summary.preferredDateAndTime);
  const notes = trimSpeechPunctuation(summary.notes);
  const notesSentence = !notes || /^none$/i.test(notes)
    ? 'There are no additional notes.'
    : `The notes are: ${notes}.`;

  return `Okay, here's the summary. ${name} is requesting ${service} at ${address}. The preferred date and time is ${preferredDateAndTime}. ${notesSentence} Does that all sound right?`;
}

function repairPlanForBlockedOutput({
  answeredField = '',
  callerTranscript = '',
  callerDisposition = 'meaningful',
  businessName = 'the business',
  businessContext = {},
  notesResolvedNegative = false,
  notesHadContent = false,
} = {}) {
  if (callerDisposition === 'filler') return { instructions: '', expectedTranscript: '' };
  if (callerDisposition === 'unclear') {
    return {
      instructions: exactSpeechInstruction(UNCLEAR_CALLER_RESPONSE),
      expectedTranscript: UNCLEAR_CALLER_RESPONSE,
    };
  }

  const recovery = callerAnsweredDifferentField(answeredField, callerTranscript)
    ? recoveryQuestionForField(answeredField)
    : '';
  if (recovery) {
    return {
      instructions: exactSpeechInstruction(recovery),
      expectedTranscript: recovery,
    };
  }

  switch (answeredField) {
    case 'service': {
      const text = 'What name should I use for the estimate request?';
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'name': {
      const text = "What's the complete project address?";
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'address': {
      const text = 'What date and time would work best for the estimate?';
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'schedule': {
      const text = !cleanText(callerTranscript)
        || hasCompleteAvailableSchedule(callerTranscript, businessContext)
        ? NOTES_AND_QUESTIONS_PROMPT
        : 'What date and time would work best for the estimate?';
      return {
        instructions: exactSpeechInstruction(text),
        expectedTranscript: text,
      };
    }
    case 'notes': {
      if (isConversationRepairRequest(callerTranscript)) {
        const text = notesHadContent
          ? MORE_NOTES_AND_QUESTIONS_PROMPT
          : NOTES_AND_QUESTIONS_PROMPT;
        return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
      }
      if (notesResolvedNegative || notesStepCompleted(callerTranscript)) {
        const text = contactConsentQuestionForBusiness(businessName, notesHadContent);
        return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
      }
      if (isClearAffirmative(callerTranscript) && !looksLikeBusinessQuestion(callerTranscript)) {
        return {
          instructions: exactSpeechInstruction(NOTES_DETAILS_PROMPT),
          expectedTranscript: NOTES_DETAILS_PROMPT,
        };
      }
      if (looksLikeBusinessQuestion(callerTranscript)) {
        if (!businessDataSupportsQuestion(callerTranscript, businessContext)) {
          const text = `${UNKNOWN_BUSINESS_QUESTION_RESPONSE} ${MORE_NOTES_AND_QUESTIONS_PROMPT}`;
          return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
        }
        return {
          instructions: `Answer only the caller's business question using only the supplied business data for this call. Do not add an answered question to the notes. Never answer from general knowledge, common industry knowledge, hardcoded fallback claims, or assumptions about painting. Then ask exactly: ${JSON.stringify(MORE_NOTES_AND_QUESTIONS_PROMPT)} Do not ask another intake question and do not discuss how the caller's own project maps to a service.`,
          expectedTranscript: '',
        };
      }
      return {
        instructions: exactSpeechInstruction(MORE_NOTES_AND_QUESTIONS_PROMPT),
        expectedTranscript: MORE_NOTES_AND_QUESTIONS_PROMPT,
      };
    }
    case 'consent':
      if (isClearAffirmative(callerTranscript)) {
        return {
          instructions: 'Call prepare_estimate_summary now using only details the caller already provided. Do not speak any preamble, acknowledgement, process narration, transition, address confirmation, ZIP question, apartment question, suite question, or unit question before the tool call.',
          expectedTranscript: '',
        };
      }
      return {
        instructions: 'Respond only to the caller\'s contact-consent answer. Do not narrate your process or announce a next step.',
        expectedTranscript: '',
      };
    case 'summary':
      if (isClearAffirmative(callerTranscript)) {
        return {
          instructions: exactSpeechInstruction(
            SUBMISSION_START_RESPONSE,
            'Then immediately call submit_estimate_request with caller_confirmed true.',
          ),
          expectedTranscript: SUBMISSION_START_RESPONSE,
        };
      }
      return {
        instructions: 'Ask only for the specific detail the caller corrected or said was wrong. Do not recap, narrate your process, or announce that you are updating anything.',
        expectedTranscript: '',
      };
    default:
      return {
        instructions: 'Respond with only the single next required question or answer. Do not use a standalone acknowledgement, process narration, reassurance, recap, or transition sentence.',
        expectedTranscript: '',
      };
  }
}

export function repairInstructionForBlockedOutput(options = {}) {
  return repairPlanForBlockedOutput(options).instructions;
}

function extractResponseTranscript(response = {}) {
  const parts = [];
  for (const item of response.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.transcript) parts.push(String(content.transcript));
    }
  }
  return cleanText(parts.join(' '));
}

function outputItemIds(response = {}) {
  return (response.output || [])
    .map((item) => cleanText(item?.id))
    .filter(Boolean);
}

function hasFunctionCall(response = {}, name = '') {
  return (response.output || []).some(
    (item) => item?.type === 'function_call' && cleanText(item.name) === name,
  );
}

function replaceStringEverywhere(value, replacements) {
  if (typeof value === 'string') {
    return replacements.reduce(
      (current, [from, to]) => current.split(from).join(to),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => replaceStringEverywhere(item, replacements));
  if (!value || typeof value !== 'object') return value;
  for (const [key, child] of Object.entries(value)) {
    value[key] = replaceStringEverywhere(child, replacements);
  }
  return value;
}

function hardenSessionUpdate(event) {
  replaceStringEverywhere(event.session, [
    [OLD_SERVICE_QUESTION, SERVICE_QUESTION],
    [OLD_SUBMISSION_START_RESPONSE, SUBMISSION_START_RESPONSE],
    [OLD_NOTES_AND_QUESTIONS_PROMPT, NOTES_AND_QUESTIONS_PROMPT],
    [PREVIOUS_NOTES_AND_QUESTIONS_PROMPT, NOTES_AND_QUESTIONS_PROMPT],
    [OLD_UNKNOWN_BUSINESS_QUESTION_RESPONSE, UNKNOWN_BUSINESS_QUESTION_RESPONSE],
    [PREVIOUS_UNKNOWN_BUSINESS_QUESTION_RESPONSE, UNKNOWN_BUSINESS_QUESTION_RESPONSE],
    ...CALLER_VALUE_EXAMPLE_REPLACEMENTS,
  ]);

  if (typeof event.session?.instructions === 'string') {
    const oldAcknowledgmentRule = 'Light acknowledgments such as "Okay," "Great," "Got it," "Okay, great," or "Sounds good" are encouraged and may naturally begin many questions or answers. Do not force one onto every turn, and vary them so the conversation does not sound repetitive.';
    const hardAcknowledgmentRule = 'Natural acknowledgements are fine only when they are attached to a useful answer or question. Never send a standalone filler acknowledgement during intake.';
    const oldSingleActionRule = 'Produce at most one assistant message in each turn, written as one short paragraph. Choose exactly one next action before speaking. Never emit two assistant messages or two separate spoken items in the same response, and never speak a transition sentence and then switch to a different action. Never repeat the same sentence or question within one response. Ask at most one question, then stop and wait for the caller.';
    const coherentResponseRule = 'Produce at most one assistant message in each turn, written as one short paragraph. Keep that response focused on the caller\'s current step. When the caller asks a business question, the same response may contain the brief grounded answer followed by the one appropriate follow-up question. Never emit two assistant messages or two separate spoken items in the same response, and never speak a transition sentence and then switch to a different action. Never repeat the same sentence or question within one response. Ask at most one question, then stop and wait for the caller.';
    const oldBusinessScopeRule = '- Answer only from the structured business information supplied below: services, service areas, normal business hours, estimate days, and estimate hours.';
    const businessScopeRule = '- Answer business questions only from the business information supplied for this call, including the supplied services and relevant facts present in BUSINESS WEBSITE DATA. If the answer is not present there, do not infer it from general knowledge.';
    const oldPriceRule = `- If the caller asks about price, cost, a price range, or how much the job will be, answer exactly: "${OLD_PRICE_QUESTION_RESPONSE}"`;
    const oldResponseTimeRule = `- If the caller asks how long it will take the business to get back to them, respond to their request, accept it, decline it, or otherwise decide the estimate request, answer exactly: "${OLD_RESPONSE_TIME_QUESTION_RESPONSE}"`;
    const transformedUnsupportedRule = `- If the caller asks a business question that cannot be answered from the structured information and is not one of the two fallbacks above, say exactly: "${UNKNOWN_BUSINESS_QUESTION_RESPONSE}" Preserve that unanswered question in additional_notes so the business receives it.`;
    const unsupportedRule = `- If the supplied business information does not contain the answer, do not answer from general knowledge. During the notes-and-questions step, say "${UNKNOWN_BUSINESS_QUESTION_RESPONSE}" and then ask "${MORE_NOTES_AND_QUESTIONS_PROMPT}" Preserve that unanswered question in additional_notes. Before the notes-and-questions step, say "${UNKNOWN_BUSINESS_QUESTION_RESPONSE}" and then return to the one intake field that was still pending.`;
    const oldAnsweredRule = '- If a question is answered from structured information or one of the safe fallbacks, do not add the answered question to notes unless the caller asks you to.';
    const answeredRule = '- If a question is answered from the supplied business information, do not add that answered question to notes unless the caller explicitly asks you to.';
    const oldNotesQuestionHandlingRule = 'If the caller gives project notes, preserve them. If they ask one or more business questions, answer each briefly when the structured data or safe fallbacks allow it; add each unanswered question to additional_notes.';
    const notesQuestionHandlingRule = 'If the caller gives project notes, preserve them. If they ask one or more business questions, answer each briefly only when the supplied business information contains the answer; add each unanswered question to additional_notes.';
    const oldNotesCompletionRule = 'If the caller clearly has another question or more notes, remain in this step. Otherwise, once this step is complete, continue directly to contact permission.';
    const explicitNotesCompletionRule = 'After every project note or business question, remain in this step. Continue to contact permission only after the caller explicitly says they have no more notes or questions.';

    event.session.instructions = event.session.instructions
      .replace(oldAcknowledgmentRule, hardAcknowledgmentRule)
      .replace(oldSingleActionRule, coherentResponseRule)
      .replace(oldBusinessScopeRule, businessScopeRule)
      .replace(oldPriceRule, '')
      .replace(oldResponseTimeRule, '')
      .replace(transformedUnsupportedRule, unsupportedRule)
      .replace(oldAnsweredRule, answeredRule)
      .replace(oldNotesQuestionHandlingRule, notesQuestionHandlingRule)
      .replace(oldNotesCompletionRule, explicitNotesCompletionRule)
      + `\nSERVICE QUESTION RULE: Ask exactly: "${SERVICE_QUESTION}" The caller is expected to describe the work in ordinary words rather than know the website service category. Silently match their description to the supplied service when it is clear. Do not repeat the category back during intake.`
      + `\nFIELD FOCUS RULE: Keep the intake on the single field you just asked for. If the caller clearly answers a different field without also answering the pending field, do not consume that answer as a substitute and do not advance. Briefly apologize that you were asking for the pending field and ask that same field again. If the caller deliberately gives several fields in one turn and includes the pending field, keep all usable details and continue to the next genuinely missing field.`
      + `\nINTAKE ORDER RULE: After a clear service answer, ask for the caller's name immediately. Then ask for the project address, then the preferred date and time, then notes or questions, then contact permission. Never skip the name and never reopen a field that the caller already answered.`
      + `\nFIELD COMPLETION RULE: Once a required field has a usable answer and the intake advances, that field is locked and must never be asked again. Reopen a locked field only when the caller explicitly corrects it or its original answer is genuinely incomplete. The notes step may stay open while the caller is adding notes, but an explicit no, none, nothing else, that's all, or that's it closes notes permanently.`
      + `\nIMMEDIATE NEXT QUESTION RULE: After accepting an intake answer, the same spoken response must contain the one actual next required question. A short natural acknowledgement may come first, but never stop after the acknowledgement, announce that a question is coming, or describe moving things along. Never say you have a quick question without immediately asking that question in the same response.`
      + `\nCALLER VALUE RULE: Outside the required final summary and server-normalized prepared summary, caller-specific values come only from the caller. Never invent, autocomplete, nickname, alter, or suggest a caller-specific name, address, city, town, state, date, time, or note from business data, examples, prior calls, or general knowledge. If you casually use the caller's first name, use exactly the first-name wording the caller supplied; never substitute a nickname. In the required final summary, read back only the prepared values and ask the single overall confirmation question.`
      + `\nADDRESS RULE: Ask exactly "What's the complete project address?" Never ask for ZIP code, apartment, suite, or unit information. Never ask whether the original address is correct or spelled exactly a certain way. If city or town or state is genuinely missing, ask only for the missing city or town and/or state without suggesting a candidate value.`
      + `\nTIME INFERENCE RULE: When the caller gives a day and a bare hour, infer AM or PM silently if only one interpretation falls inside the supplied estimate hours. A bare hour such as 1 during a 9:00 AM through 4:00 PM estimate window is 1:00 PM. Do not ask the caller to distinguish an impossible overnight interpretation.`
      + `\nBUSINESS KNOWLEDGE RULE: Business facts may come only from the business data supplied for this call. If that data contains the answer, answer briefly and do not add the answered question to notes. If that data does not contain the answer, do not use general knowledge, common painting knowledge, hardcoded fallback claims, assumptions, or typical industry practice. In particular, never invent job duration, drying time, prep time, pricing details, response-time promises, guarantees, policies, or availability.`
      + `\nNOTES LOOP RULE: The notes-and-questions step stays open until the caller explicitly says they have no more notes or questions, such as no, none, nothing else, that's all, or that's it. A project statement does not become a business question merely because it ends with a conversational tag such as "you know what I mean?", "you know what I'm talking about?", "right?", or "does that make sense?" Treat that whole turn as a note. After a project note, ask exactly "${MORE_NOTES_AND_QUESTIONS_PROMPT}" After a business question that the supplied business data can answer, answer it briefly, do not add it to notes, and then ask exactly "${MORE_NOTES_AND_QUESTIONS_PROMPT}" After a business question the supplied data cannot answer, say the sentence exactly as "${UNKNOWN_BUSINESS_QUESTION_RESPONSE}" preserve that question in the notes, and then ask exactly "${MORE_NOTES_AND_QUESTIONS_PROMPT}" Never move to contact consent merely because you answered or recorded one note or question.`
      + `\nCALL RECOVERY RULE: If the caller asks "What's the question?", says they do not follow, asks what you are talking about, says hello to check whether you are there, or otherwise reacts to a stalled or unclear receptionist response, that is conversation repair. It is never a business question and never a project note. Ask the still-pending intake question directly, without an apology paragraph or process explanation.`
      + `\nCONSENT BOUNDARY RULE: After the caller says yes to contact permission, do not speak, repeat their notes, thank them again, or ask for any intake field. Call prepare_estimate_summary immediately with every detail already collected. The next spoken response must be the server-prepared final summary.`
      + `\nHARD OUTPUT RULE: Do not generate standalone process or transition narration. Before speaking, remove phrases such as "one sec", "let me get the details", "let me grab the details", "let me check", "let's keep moving", "let me ask one quick question to move things along", or any natural variation unless the same spoken response immediately continues into the actual next question or action. Prefer skipping the transition entirely and asking the next question directly. Never end a turn on process narration. Never say "let me think", "best way to help", "next step", "let me update", "let me clarify", or "quick recap".`
      + `\nUNCLEAR AUDIO RULE: A hesitation such as "uh" or "um" gets silence. If the caller starts an unfinished thought, wait for them to finish instead of advancing the intake. If the transcription is clearly unintelligible rather than a hesitation, say exactly: "${UNCLEAR_CALLER_RESPONSE}"`
      + `\nDELIVERY RULE: Speak with smooth, natural conversational pacing and intonation. Keep sentences short and easy to follow. Do not sound clipped, staccato, overly formal, or like you are reading field labels.`
      + `\nFINAL SUMMARY RULE: Begin with "Okay, here's the summary." State the name, service, address, preferred date and time, and actual project notes exactly once. If there are no notes, say "There are no additional notes." Never include contact consent, remarks about the receptionist, requests to repeat a question, or statements that no notes were provided as notes. Never say "Note: None" and never repeat the summary.`
      + `\nPRE-SUBMISSION RULE: After the caller confirms the final summary, the required sentence before the submit tool is exactly: "${SUBMISSION_START_RESPONSE}" That sentence and the submit_estimate_request tool call must be produced in the same response. Never say the sentence by itself, never repeat it, and never claim the request is being sent unless the submit tool call is present.`;
  }

  return event;
}

function prepareOutgoingEvent(event, pendingSummary) {
  if (!event || typeof event !== 'object') return { event, policy: null };

  if (event.type === 'session.update') {
    return { event: hardenSessionUpdate(event), policy: null };
  }

  replaceStringEverywhere(event, [
    [OLD_SERVICE_QUESTION, SERVICE_QUESTION],
    [OLD_SUBMISSION_START_RESPONSE, SUBMISSION_START_RESPONSE],
    [OLD_GOODBYE_PREFIX, GOODBYE_PREFIX],
    [OLD_NOTES_AND_QUESTIONS_PROMPT, NOTES_AND_QUESTIONS_PROMPT],
    [PREVIOUS_NOTES_AND_QUESTIONS_PROMPT, NOTES_AND_QUESTIONS_PROMPT],
    [OLD_UNKNOWN_BUSINESS_QUESTION_RESPONSE, UNKNOWN_BUSINESS_QUESTION_RESPONSE],
    [PREVIOUS_UNKNOWN_BUSINESS_QUESTION_RESPONSE, UNKNOWN_BUSINESS_QUESTION_RESPONSE],
  ]);

  if (
    event.type === 'response.create'
    && typeof event.response?.instructions === 'string'
    && /^Explain this problem briefly and ask only for what is needed to correct it:/i.test(event.response.instructions)
  ) {
    event.response.instructions = event.response.instructions.replace(
      /^Explain this problem briefly and ask only for what is needed to correct it:/i,
      'Ask only for what is needed to correct this. Do not explain internal validation, reasoning, workflow, or process:',
    );
  }

  if (
    event.type === 'response.create'
    && typeof event.response?.instructions === 'string'
    && /Use only the returned summary values:/i.test(event.response.instructions)
    && pendingSummary
  ) {
    const speech = buildPreparedSummarySpeech(pendingSummary);
    event.response.instructions = exactSpeechInstruction(speech);
    return {
      event,
      policy: {
        expectedTranscript: speech,
        repairInstruction: exactSpeechInstruction(speech),
      },
    };
  }

  return { event, policy: null };
}

function parseFunctionOutput(event) {
  if (
    event?.type !== 'conversation.item.create'
    || event.item?.type !== 'function_call_output'
  ) return null;
  try {
    return JSON.parse(String(event.item.output || '{}'));
  } catch {
    return null;
  }
}

function createGuardedWebSocketClass({
  context,
  InnerWebSocketClass,
  onClear,
}) {
  const businessName = spokenBusinessName(context?.businessName);

  return class GuardedRealtimeWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.inner = new InnerWebSocketClass(url, options);
      this.responses = new Map();
      this.pendingIntakeField = '';
      this.lastAnsweredField = '';
      this.lastAnsweredTranscript = '';
      this.latestCallerTranscript = '';
      this.latestCallerDisposition = 'none';
      this.notesResolvedNegative = false;
      this.notesHadContent = false;
      this.notesCallerBuffer = [];
      this.pendingSummary = null;
      this.pendingResponsePolicies = [];
      this.repairAttempts = 0;
      this.submitCallIds = new Set();
      this.submissionStarted = false;
      this.failedSubmitFollowupPending = false;
      this.pendingDeleteItems = new Set();
      this.deleteRequestItems = new Map();
      this.deleteRequestSequence = 0;
      this.completedIntakeFields = new Set();

      this.inner.on('open', (...args) => this.emit('open', ...args));
      this.inner.on('error', (...args) => this.emit('error', ...args));
      this.inner.on('close', (...args) => this.emit('close', ...args));
      this.inner.on('message', (raw) => this.handleIncoming(raw));
    }

    get readyState() {
      return this.inner.readyState;
    }

    send(value) {
      let event;
      try {
        event = JSON.parse(String(value));
      } catch {
        return this.inner.send(value);
      }

      const toolOutput = parseFunctionOutput(event);
      if (toolOutput?.status === 'ready_for_confirmation' && toolOutput.summary) {
        this.pendingSummary = toolOutput.summary;
        for (const field of COMPLETABLE_INTAKE_FIELDS) this.completedIntakeFields.add(field);
      }
      if (
        event.type === 'conversation.item.create'
        && event.item?.type === 'function_call_output'
        && this.submitCallIds.has(cleanText(event.item.call_id))
      ) {
        this.submitCallIds.delete(cleanText(event.item.call_id));
        if (toolOutput?.ok === false) this.failedSubmitFollowupPending = true;
      }

      const failedSubmitFollowup = event.type === 'response.create' && this.failedSubmitFollowupPending;
      if (failedSubmitFollowup) {
        this.failedSubmitFollowupPending = false;
        event.response.instructions = exactSpeechInstruction(SUBMISSION_FAILURE_RESPONSE);
      }

      const prepared = prepareOutgoingEvent(event, this.pendingSummary);
      if (failedSubmitFollowup) {
        prepared.policy = {
          expectedTranscript: SUBMISSION_FAILURE_RESPONSE,
          repairInstruction: exactSpeechInstruction(SUBMISSION_FAILURE_RESPONSE),
        };
      }
      if (prepared.policy) this.pendingResponsePolicies.push(prepared.policy);
      return this.inner.send(JSON.stringify(prepared.event));
    }

    close(...args) {
      return this.inner.close(...args);
    }

    responseState(responseId) {
      const id = cleanText(responseId);
      if (!this.responses.has(id)) {
        this.responses.set(id, {
          id,
          createdEvent: null,
          createdForwarded: false,
          audioEvents: [],
          transcriptEvents: [],
          transcript: '',
          transcriptDoneEvent: null,
          transcriptForwarded: false,
          approved: false,
          blocked: false,
          interrupted: false,
          itemIds: new Set(),
          callerDisposition: this.latestCallerDisposition,
          callerTranscript: this.latestCallerTranscript,
          answeredField: this.lastAnsweredField,
          notesResolvedNegative: this.notesResolvedNegative,
          notesHadContent: this.notesHadContent,
          policy: null,
        });
      }
      return this.responses.get(id);
    }

    emitJson(event) {
      this.emit('message', Buffer.from(JSON.stringify(event)));
    }

    deleteConversationItem(itemId) {
      const id = cleanText(itemId);
      if (!id || this.pendingDeleteItems.has(id)) return;
      const eventId = `guard-delete-${this.deleteRequestSequence += 1}`;
      this.pendingDeleteItems.add(id);
      this.deleteRequestItems.set(eventId, id);
      this.inner.send(JSON.stringify({
        type: 'conversation.item.delete',
        event_id: eventId,
        item_id: id,
      }));
    }

    clearDeleteRequest(itemId, eventId = '') {
      const id = cleanText(itemId);
      const requestId = cleanText(eventId);
      if (id) this.pendingDeleteItems.delete(id);
      if (requestId) this.deleteRequestItems.delete(requestId);
      for (const [key, value] of this.deleteRequestItems) {
        if (value === id) this.deleteRequestItems.delete(key);
      }
    }

    consumeMissingDeleteError(event) {
      const message = cleanText(event.error?.message);
      if (!/error deleting item:.*does not exist/i.test(message)) return false;
      const requestId = cleanText(event.error?.event_id);
      const itemFromRequest = this.deleteRequestItems.get(requestId) || '';
      const itemFromMessage = message.match(/item with id ['"]([^'"]+)['"]/i)?.[1] || '';
      const itemId = cleanText(itemFromRequest || itemFromMessage);
      if (!itemId || !this.pendingDeleteItems.has(itemId)) return false;
      this.clearDeleteRequest(itemId, requestId);
      return true;
    }

    recordCompletedFields(state, pending, answeredDifferentField) {
      if (answeredDifferentField) return;
      switch (state.answeredField) {
        case 'service':
          if (pending && pending !== 'service') this.completedIntakeFields.add('service');
          if (callerVolunteeredName(state.callerTranscript) && pending !== 'name') {
            this.completedIntakeFields.add('name');
          }
          break;
        case 'name':
          if (pending === 'address') this.completedIntakeFields.add('name');
          break;
        case 'address':
          if (pending === 'schedule') this.completedIntakeFields.add('address');
          break;
        case 'schedule':
          if (pending === 'notes') this.completedIntakeFields.add('schedule');
          break;
        case 'notes':
          if (pending === 'consent' && notesStepCompleted(state.callerTranscript)) {
            this.completedIntakeFields.add('notes');
          }
          break;
        case 'consent':
          if (isClearAffirmative(state.callerTranscript)) {
            this.completedIntakeFields.add('consent');
          }
          break;
        default:
          break;
      }
    }

    forwardCreated(state) {
      if (!state.createdEvent || state.createdForwarded) return;
      this.emitJson(state.createdEvent);
      state.createdForwarded = true;
    }

    markBlocked(state) {
      state.blocked = true;
      state.audioEvents.length = 0;
      state.transcriptEvents.length = 0;
      state.transcriptDoneEvent = null;
    }

    shouldRequireSubmissionStart(state) {
      return !this.submissionStarted
        && state.answeredField === 'summary'
        && isClearAffirmative(state.callerTranscript);
    }

    shouldRequireSummaryPreparation(state) {
      return state.answeredField === 'consent'
        && isClearAffirmative(state.callerTranscript)
        && !state.policy?.expectedTranscript;
    }

    approveResponse(state, transcript, transcriptDoneEvent = null) {
      if (state.blocked || state.interrupted) return false;
      const spoken = cleanText(transcript);
      const pending = classifyPendingField(spoken);

      if (
        state.policy?.callerTranscript
        && !sameSpokenText(state.callerTranscript, state.policy.callerTranscript)
      ) {
        state.policy.stale = true;
        this.markBlocked(state);
        return false;
      }

      if (state.policy?.expectedTranscript && !sameSpokenText(spoken, state.policy.expectedTranscript)) {
        this.markBlocked(state);
        return false;
      }

      if (!state.policy && state.callerDisposition === 'filler') {
        this.markBlocked(state);
        return false;
      }

      if (!state.policy && state.callerDisposition === 'unclear') {
        this.markBlocked(state);
        return false;
      }

      if (pending && this.completedIntakeFields.has(pending)) {
        const explicitSummaryCorrection = state.answeredField === 'summary'
          && !isClearAffirmative(state.callerTranscript);
        if (explicitSummaryCorrection && COMPLETABLE_INTAKE_FIELDS.has(pending)) {
          this.completedIntakeFields.delete(pending);
        } else {
          this.markBlocked(state);
          return false;
        }
      }

      const answeredDifferentField = callerAnsweredDifferentField(
        state.answeredField,
        state.callerTranscript,
      );
      if (answeredDifferentField) {
        if (pending !== state.answeredField) {
          this.markBlocked(state);
          return false;
        }
      }

      if (
        state.answeredField === 'service'
        && !answeredDifferentField
        && !looksLikeBusinessQuestion(state.callerTranscript)
        && (
          (!callerVolunteeredName(state.callerTranscript) && pending !== 'name')
          || (callerVolunteeredName(state.callerTranscript) && !pending)
        )
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        state.answeredField === 'name'
        && !looksLikeStreetAddress(state.callerTranscript)
        && pending !== 'address'
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        state.answeredField === 'address'
        && /\b(?:did you mean|is that|is this|is it)\b/i.test(spoken)
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        state.answeredField === 'address'
        && !answeredDifferentField
        && !looksLikeBusinessQuestion(state.callerTranscript)
      ) {
        const addressComplete = hasCompleteProjectAddress(state.callerTranscript);
        const validNextField = addressComplete
          ? pending === 'schedule'
          : pending === 'address' || pending === 'schedule';
        if (!validNextField) {
          this.markBlocked(state);
          return false;
        }
      }

      if (state.answeredField === 'notes' && !notesStepCompleted(state.callerTranscript)) {
        if (pending !== 'notes') {
          this.markBlocked(state);
          return false;
        }
        if (
          !looksLikeBusinessQuestion(state.callerTranscript)
          && normalized(spoken).startsWith(normalized(UNKNOWN_BUSINESS_QUESTION_RESPONSE))
        ) {
          this.markBlocked(state);
          return false;
        }
        if (
          looksLikeBusinessQuestion(state.callerTranscript)
          && !businessDataSupportsQuestion(state.callerTranscript, context)
          && !normalized(spoken).startsWith(normalized(UNKNOWN_BUSINESS_QUESTION_RESPONSE))
        ) {
          this.markBlocked(state);
          return false;
        }
      }

      if (
        state.answeredField === 'notes'
        && notesStepCompleted(state.callerTranscript)
      ) {
        const expectedConsent = contactConsentQuestionForBusiness(businessName, state.notesHadContent);
        if (!sameSpokenText(spoken, expectedConsent)) {
          this.markBlocked(state);
          return false;
        }
      }

      if (state.answeredField === 'schedule') {
        const scheduleComplete = hasCompleteAvailableSchedule(state.callerTranscript, context);
        const validNextField = scheduleComplete
          ? pending === 'notes' && endsWithSpokenText(spoken, NOTES_AND_QUESTIONS_PROMPT)
          : pending === 'schedule';
        if (!validNextField) {
          this.markBlocked(state);
          return false;
        }
      }

      if (
        state.answeredField === 'consent'
        && isClearAffirmative(state.callerTranscript)
        && !state.policy?.expectedTranscript
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        sameSpokenText(spoken, SUBMISSION_START_RESPONSE)
        && !this.shouldRequireSubmissionStart(state)
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        this.shouldRequireSubmissionStart(state)
        && !sameSpokenText(spoken, SUBMISSION_START_RESPONSE)
      ) {
        this.markBlocked(state);
        return false;
      }

      if (shouldBlockReceptionistOutput(spoken)) {
        this.markBlocked(state);
        return false;
      }

      state.approved = true;
      state.transcript = spoken;
      this.recordCompletedFields(state, pending, answeredDifferentField);
      this.forwardCreated(state);
      for (const event of state.audioEvents.splice(0)) this.emitJson(event);
      for (const event of state.transcriptEvents.splice(0)) this.emitJson(event);
      if (transcriptDoneEvent && !state.transcriptForwarded) {
        this.emitJson(transcriptDoneEvent);
        state.transcriptForwarded = true;
      }
      state.transcriptDoneEvent = null;

      if (pending) {
        this.pendingIntakeField = pending;
        if (pending === 'consent') {
          this.notesResolvedNegative = false;
          this.notesCallerBuffer = [];
        }
      }
      if (state.answeredField === 'notes') this.notesCallerBuffer = [];
      this.repairAttempts = 0;
      return true;
    }

    sendRepair(plan) {
      if (!plan?.instructions || this.repairAttempts >= MAX_REPAIR_ATTEMPTS) return;
      this.repairAttempts += 1;
      this.pendingResponsePolicies.push({
        expectedTranscript: plan.expectedTranscript || '',
        repairInstruction: plan.instructions,
        callerTranscript: this.latestCallerTranscript,
      });
      this.inner.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: plan.instructions,
        },
      }));
    }

    discardResponse(event, state, { repair = true } = {}) {
      const response = event.response || {};
      for (const id of outputItemIds(response)) state.itemIds.add(id);

      this.emitJson({
        ...event,
        response: {
          ...response,
          output: [],
        },
      });

      for (const itemId of state.itemIds) this.deleteConversationItem(itemId);

      if (!repair || state.interrupted) return;

      if (state.policy?.repairInstruction && !state.policy.stale) {
        this.sendRepair({
          instructions: state.policy.repairInstruction,
          expectedTranscript: state.policy.expectedTranscript || '',
        });
        return;
      }

      const plan = repairPlanForBlockedOutput({
        answeredField: state.answeredField,
        callerTranscript: state.callerTranscript,
        callerDisposition: state.callerDisposition,
        businessName,
        businessContext: context,
        notesResolvedNegative: state.notesResolvedNegative,
        notesHadContent: state.notesHadContent,
      });
      this.sendRepair(plan);
    }

    updateActiveResponseCallerContext({
      disposition,
      transcript,
      answeredField,
      notesResolvedNegative,
      notesHadContent,
    }) {
      for (const state of this.responses.values()) {
        if (state.approved || state.interrupted) continue;
        state.callerDisposition = disposition;
        state.callerTranscript = transcript;
        state.answeredField = answeredField;
        state.notesResolvedNegative = notesResolvedNegative;
        state.notesHadContent = notesHadContent;
      }
    }

    handleIncoming(raw) {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        this.emit('message', raw);
        return;
      }

      if (event.type === 'error' && this.consumeMissingDeleteError(event)) return;

      if (event.type === 'conversation.item.deleted') {
        this.clearDeleteRequest(event.item_id);
        this.emitJson(event);
        return;
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        onClear?.();
        for (const state of this.responses.values()) {
          if (state.interrupted) continue;
          state.interrupted = true;
          state.audioEvents.length = 0;
          state.transcriptEvents.length = 0;
          state.transcriptDoneEvent = null;
        }
        this.emitJson(event);
        return;
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const callerTranscript = cleanText(event.transcript);
        const disposition = callerTranscriptDisposition(callerTranscript);
        this.latestCallerTranscript = callerTranscript;
        this.latestCallerDisposition = disposition;

        let answeredField = this.pendingIntakeField;
        let effectiveTranscript = callerTranscript;
        if (disposition === 'meaningful' && this.pendingIntakeField) {
          if (this.pendingIntakeField === 'notes') {
            if (isConversationRepairRequest(callerTranscript)) {
              this.notesResolvedNegative = false;
            } else if (notesStepCompleted(callerTranscript)) {
              this.notesResolvedNegative = true;
              this.notesCallerBuffer = [];
            } else {
              this.notesResolvedNegative = false;
              this.notesCallerBuffer.push(callerTranscript);
              effectiveTranscript = cleanText(this.notesCallerBuffer.join(' '));
              if (looksLikeBusinessQuestion(effectiveTranscript)) {
                if (!businessDataSupportsQuestion(effectiveTranscript, context)) this.notesHadContent = true;
              } else if (!isClearAffirmative(callerTranscript)) {
                this.notesHadContent = true;
              }
            }
          }

          if (
            this.pendingIntakeField === 'notes'
            && this.notesResolvedNegative
            && !notesStepCompleted(callerTranscript)
            && !/^(?:actually|wait|hold on)\b/i.test(callerTranscript)
          ) {
            answeredField = 'notes';
          } else {
            this.lastAnsweredField = this.pendingIntakeField;
            this.lastAnsweredTranscript = effectiveTranscript;
            answeredField = this.lastAnsweredField;
          }
        }

        if (disposition === 'meaningful') this.latestCallerTranscript = effectiveTranscript;

        this.updateActiveResponseCallerContext({
          disposition,
          transcript: disposition === 'meaningful'
            ? (effectiveTranscript || this.lastAnsweredTranscript || callerTranscript)
            : callerTranscript,
          answeredField,
          notesResolvedNegative: this.notesResolvedNegative,
          notesHadContent: this.notesHadContent,
        });

        this.emitJson(event);
        return;
      }

      if (event.type === 'response.created') {
        const state = this.responseState(event.response?.id);
        state.createdEvent = event;
        if (this.pendingResponsePolicies.length) {
          state.policy = this.pendingResponsePolicies.shift();
        }
        return;
      }

      if (event.type === 'response.output_audio.delta' && event.delta) {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        if (state.blocked || state.interrupted) return;
        if (state.approved) this.emitJson(event);
        else state.audioEvents.push(event);
        return;
      }

      if (event.type === 'response.output_audio_transcript.delta') {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        state.transcript += String(event.delta || '');
        if (state.blocked || state.interrupted) return;
        if (state.approved) this.emitJson(event);
        else state.transcriptEvents.push(event);
        return;
      }

      if (event.type === 'response.output_audio_transcript.done') {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        const transcript = cleanText(event.transcript || state.transcript);
        state.transcript = transcript;
        if (sameSpokenText(transcript, SUBMISSION_START_RESPONSE)) {
          state.transcriptDoneEvent = event;
          return;
        }
        this.approveResponse(state, transcript, event);
        return;
      }

      if (event.type === 'response.done') {
        const responseId = cleanText(event.response?.id);
        const state = this.responseState(responseId);
        for (const id of outputItemIds(event.response)) state.itemIds.add(id);

        if (state.interrupted) {
          this.discardResponse(event, state, { repair: false });
          this.responses.delete(responseId);
          return;
        }

        if (!state.transcript) state.transcript = extractResponseTranscript(event.response);
        const hasPrepareCall = hasFunctionCall(event.response, 'prepare_estimate_summary');
        const hasSubmitCall = hasFunctionCall(event.response, 'submit_estimate_request');
        const isSubmissionStart = sameSpokenText(state.transcript, SUBMISSION_START_RESPONSE);

        if (isSubmissionStart) {
          if (!this.shouldRequireSubmissionStart(state) || !hasSubmitCall) {
            this.markBlocked(state);
          } else if (!state.approved) {
            this.approveResponse(state, state.transcript, state.transcriptDoneEvent);
          }
        } else if (!state.approved && !state.blocked && state.transcript) {
          this.approveResponse(state, state.transcript);
        }

        if (hasSubmitCall) {
          if (!this.shouldRequireSubmissionStart(state) || !state.approved || !isSubmissionStart) {
            this.markBlocked(state);
          }
        }

        if (this.shouldRequireSummaryPreparation(state) && !hasPrepareCall) {
          this.markBlocked(state);
        }

        if (state.blocked) {
          this.discardResponse(event, state, { repair: true });
          this.responses.delete(responseId);
          return;
        }

        for (const item of event.response?.output || []) {
          if (
            item?.type === 'function_call'
            && cleanText(item.name) === 'submit_estimate_request'
            && cleanText(item.call_id)
          ) {
            this.submitCallIds.add(cleanText(item.call_id));
          }
        }

        if (hasSubmitCall && isSubmissionStart && state.approved) {
          this.submissionStarted = true;
          this.pendingIntakeField = '';
          this.lastAnsweredField = '';
          this.lastAnsweredTranscript = '';
        }

        this.forwardCreated(state);
        if (!state.approved) {
          for (const audioEvent of state.audioEvents.splice(0)) this.emitJson(audioEvent);
          for (const transcriptEvent of state.transcriptEvents.splice(0)) this.emitJson(transcriptEvent);
          if (state.transcriptDoneEvent && !state.transcriptForwarded) {
            this.emitJson(state.transcriptDoneEvent);
            state.transcriptForwarded = true;
            state.transcriptDoneEvent = null;
          }
        }
        this.emitJson(event);
        this.responses.delete(responseId);
        return;
      }

      this.emitJson(event);
    }
  };
}

export function createGuardedOpenAiReceptionist(options = {}) {
  const {
    WebSocketClass: InnerWebSocketClass = WebSocket,
    context = {},
    onClear,
  } = options;
  const GuardedWebSocketClass = createGuardedWebSocketClass({
    context,
    InnerWebSocketClass,
    onClear,
  });
  return createOpenAiReceptionist({
    ...options,
    WebSocketClass: GuardedWebSocketClass,
  });
}
