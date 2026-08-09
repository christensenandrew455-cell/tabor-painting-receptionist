import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { cleanText } from './business-context.js';
import {
  normalizeRequestedTime,
  resolveRequestedDate,
  validateEstimateAvailability,
} from './intake.js';
import { createOpenAiReceptionist, ESTIMATE_TOOLS } from './openai-receptionist.js';
import {
  INTAKE_FIELD_ORDER,
  MORE_NOTES_AND_QUESTIONS_PROMPT,
  NAME_QUESTION,
  NOTES_AND_QUESTIONS_PROMPT,
  NOTES_DETAILS_PROMPT,
  PROJECT_ADDRESS_QUESTION,
  SCHEDULE_QUESTION,
  SERVICE_QUESTION,
  SUBMISSION_FAILURE_RESPONSE,
  SUBMISSION_START_RESPONSE,
  UNCLEAR_CALLER_RESPONSE,
  UNKNOWN_BUSINESS_QUESTION_RESPONSE,
  callerVolunteeredName as policyCallerVolunteeredName,
  classifyCallerTranscript,
  contactConsentQuestion as policyContactConsentQuestion,
  isClearAffirmative as policyIsClearAffirmative,
  isClearNegative as policyIsClearNegative,
  isConversationRepairRequest as policyIsConversationRepairRequest,
  isStandaloneBackchannel as policyIsStandaloneBackchannel,
  hasUsableNameAnswer as policyHasUsableNameAnswer,
  hasUsableServiceAnswer as policyHasUsableServiceAnswer,
  looksLikeBusinessQuestion as policyLooksLikeBusinessQuestion,
  spokenBusinessName as policySpokenBusinessName,
} from './receptionist-policy.js';

const RESPONSE_PLAN_METADATA_KEY = 'receptionist_plan_id';
const MAX_REPAIR_ATTEMPTS = 3;
const COMPLETABLE_INTAKE_FIELDS = new Set(INTAKE_FIELD_ORDER);

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

const OPEN_ENDED_HELP_OFFER_PATTERN = /\b(?:if you need (?:help with )?anything else|anything else (?:i|we) can help (?:you )?with|just let me know)\b/i;

const STANDALONE_ACKNOWLEDGMENT = /^(?:okay|ok|great|got it|okay great|okay got it|sounds good|thanks|thank you)[.!]*$/i;
const STREET_ADDRESS_PATTERN = /\b\d{1,6}\s+[a-z0-9.' -]+\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|court|ct\.?|circle|place|pl\.?|parkway|pkwy\.?|highway|hwy\.?|route)\b/i;
const US_STATE_PATTERN = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|a[klrz]|c[aot]|d[ec]|fl|ga|hi|i[adln]|k[sy]|la|m[adeinost]|n[cdehjmvty]|o[hkr]|pa|ri|s[cd]|t[nx]|ut|v[at]|w[aivy])\b/i;
const SCHEDULE_PATTERN = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december|morning|afternoon|evening|noon|midnight)\b|\b(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}[/-]\d{1,2}\b|\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const STARTS_SCHEDULE_PATTERN = /^\s*(?:(?:this|next)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december|morning|afternoon|evening|noon|midnight)\b|^\s*(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b|^\s*\d{1,2}[/-]\d{1,2}\b|^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const QUESTION_TOPIC_STOP_WORDS = new Set([
  'about', 'also', 'been', 'business', 'could', 'does', 'doing', 'guys', 'have', 'like',
  'long', 'normally', 'please', 'project', 'really', 'service',
  'should', 'take', 'that', 'their', 'there', 'they', 'this', 'what', 'when', 'where', 'which',
  'would', 'work', 'your', 'you', 'with', 'from', 'just', 'know', 'much', 'thing', 'things',
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
  return policySpokenBusinessName(value);
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
  if (OPEN_ENDED_HELP_OFFER_PATTERN.test(text)) return true;
  if (isDisallowedAddressClarification(text)) return true;

  if (
    /(?:full|complete) project address/i.test(text)
    && /including\s+(?:street|address|city|state)/i.test(text)
  ) return true;

  return false;
}

export function callerTranscriptDisposition(value) {
  return classifyCallerTranscript(value);
}

function classifyPendingField(value) {
  const raw = cleanText(value);
  const text = normalized(value);
  if (/\bwhat service were you looking for\b/.test(text)) return 'service';
  if (/\bwhat kind of work do you need done\b/.test(text)) return 'service';
  if (/\bwhat name should i (?:use|put) (?:for|on) the estimate request\b/.test(text)) return 'name';
  if (/\bwhat'?s the (?:full|complete) project address\b/.test(text)) return 'address';
  if (/\bi was asking for (?:the )?(?:project )?address\b/.test(text)) return 'address';
  if (/\bwhat (?:day or date would you prefer|date and time would work best) for the estimate\b/.test(text)) return 'schedule';
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
  return policyIsClearNegative(value);
}

function isClearAffirmative(value) {
  return policyIsClearAffirmative(value);
}

function isConversationRepairRequest(value) {
  return policyIsConversationRepairRequest(value);
}

function notesStepCompleted(value) {
  return isClearNegative(value) && !isConversationRepairRequest(value);
}

function looksLikeBusinessQuestion(value) {
  return policyLooksLikeBusinessQuestion(value);
}

function callerVolunteeredName(value) {
  return policyCallerVolunteeredName(value);
}

function isStandaloneBackchannel(value) {
  return policyIsStandaloneBackchannel(value);
}

function hasUsableServiceAnswer(value, context = {}) {
  return policyHasUsableServiceAnswer(value, context);
}

function hasUsableNameAnswer(value, context = {}) {
  return policyHasUsableNameAnswer(value, context);
}

function scheduleTimeFromCaller(value) {
  const text = cleanText(value);
  const hour = String.raw`(?:\d{1,2}(?::[0-5]\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
  const meridiem = String.raw`(?:a\.?m\.?|p\.?m\.?)`;
  if (/\bnoon\b/i.test(text)) return '12 PM';
  if (/\bmidnight\b/i.test(text)) return '12 AM';
  const afterAt = text.match(new RegExp(
    String.raw`\b(?:at|around|about)\s*(?:,\s*)?(?:(?:like|uh|um)\s*(?:,\s*)?)*(${hour}\s*${meridiem}?)\b`,
    'i',
  ));
  if (afterAt) return afterAt[1];
  const explicit = text.match(new RegExp(
    String.raw`\b(${hour}\s*${meridiem})\b`,
    'i',
  ));
  if (explicit) return explicit[1];
  const cuedBareTime = text.match(new RegExp(
    String.raw`\b(?:do|for|prefer|want|make it|say)\s+(${hour})\b`,
    'i',
  ));
  if (cuedBareTime) return cuedBareTime[1];
  const beforeWeekday = text.match(new RegExp(
    String.raw`\b(${hour})\s+(?:on\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b`,
    'i',
  ));
  return beforeWeekday ? beforeWeekday[1] : '';
}

function scheduleDateFromCaller(value) {
  const text = cleanText(value);
  const relativeDay = text.match(
    /\b(?:the\s+day\s+after\s+tomorrow|day\s+after\s+tomorrow|today|tomorrow)\b/i,
  );
  if (relativeDay) return relativeDay[0];
  const relativeWeekday = text.match(
    /\b(?:(?:this|next)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  );
  if (relativeWeekday) return relativeWeekday[0];
  const writtenDate = text.match(
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b/i,
  );
  if (writtenDate) return writtenDate[0];
  const numericDate = text.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/);
  if (numericDate) return numericDate[0];
  const dayOfMonth = text.match(/\b(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b/i);
  return dayOfMonth ? dayOfMonth[0] : '';
}

function hasCompleteAvailableSchedule(value, context = {}) {
  const text = cleanText(value);
  const callerDate = scheduleDateFromCaller(text);
  const callerTime = scheduleTimeFromCaller(text);
  if (!callerDate || !callerTime) return false;

  try {
    const requestedDate = resolveRequestedDate(callerDate, {
      now: context.now instanceof Date ? context.now : new Date(),
      timeZone: context.timeZone,
    });
    const requestedTime = normalizeRequestedTime(callerTime, context);
    validateEstimateAvailability(requestedDate, requestedTime, context);
  } catch {
    return false;
  }
  return true;
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
  if (/\bhow long\b/.test(question) || /\b(?:take|takes)\b.*\b(?:job|project|service|work)\b/.test(question)) {
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
      return `I'm sorry, I was asking for your name. ${NAME_QUESTION}`;
    case 'address':
      return `I'm sorry, I was asking for the project address. ${PROJECT_ADDRESS_QUESTION}`;
    case 'schedule':
      return `I'm sorry, I was asking for the estimate date and time. ${SCHEDULE_QUESTION}`;
    default:
      return '';
  }
}

function questionForField(field) {
  switch (field) {
    case 'service':
      return SERVICE_QUESTION;
    case 'name':
      return NAME_QUESTION;
    case 'address':
      return PROJECT_ADDRESS_QUESTION;
    case 'schedule':
      return SCHEDULE_QUESTION;
    default:
      return '';
  }
}

function callerAnsweredPendingField(field, value, context = {}) {
  switch (field) {
    case 'service':
      return hasUsableServiceAnswer(value, context);
    case 'name':
      return hasUsableNameAnswer(value, context);
    case 'address':
      return hasCompleteProjectAddress(value);
    case 'schedule':
      return hasCompleteAvailableSchedule(value, context);
    default:
      return false;
  }
}

function contactConsentQuestionForBusiness(businessName, hasNotes) {
  return policyContactConsentQuestion(businessName, hasNotes);
}

function exactSpeechInstruction(text, extra = '') {
  return `Say exactly: ${JSON.stringify(text)} Do not add anything before or after it.${extra ? ` ${extra}` : ''}`;
}

function summaryPreparationPlan() {
  return {
    instructions: 'Call prepare_estimate_summary now using only details the caller already provided. Do not speak any preamble, acknowledgement, process narration, transition, address confirmation, ZIP question, apartment question, suite question, or unit question before the tool call.',
    expectedTranscript: '',
    toolName: 'prepare_estimate_summary',
  };
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

function buildNextResponsePlan({
  answeredField = '',
  callerTranscript = '',
  callerDisposition = 'meaningful',
  businessName = 'the business',
  businessContext = {},
  notesResolvedNegative = false,
  notesHadContent = false,
  conversational = false,
} = {}) {
  if (callerDisposition === 'filler') return { instructions: '', expectedTranscript: '' };
  if (callerDisposition === 'unclear') {
    return {
      instructions: exactSpeechInstruction(UNCLEAR_CALLER_RESPONSE),
      expectedTranscript: UNCLEAR_CALLER_RESPONSE,
    };
  }

  if (
    looksLikeBusinessQuestion(callerTranscript)
    && questionForField(answeredField)
    && !callerAnsweredPendingField(answeredField, callerTranscript, businessContext)
  ) {
    const pendingQuestion = questionForField(answeredField);
    if (!businessDataSupportsQuestion(callerTranscript, businessContext)) {
      const text = `${UNKNOWN_BUSINESS_QUESTION_RESPONSE} ${pendingQuestion}`;
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    return {
      instructions: `Answer the caller's business question briefly using only the business information supplied for this call. Do not answer from general knowledge and do not add a grounded answer to project notes. End the same response with exactly: ${JSON.stringify(pendingQuestion)} Do not ask any other question.`,
      expectedTranscript: '',
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
      if (isStandaloneBackchannel(callerTranscript)) {
        return { instructions: '', expectedTranscript: '' };
      }
      if (!hasUsableServiceAnswer(callerTranscript, businessContext)) {
        return {
          instructions: exactSpeechInstruction(SERVICE_QUESTION),
          expectedTranscript: SERVICE_QUESTION,
        };
      }
      const text = callerVolunteeredName(callerTranscript)
        ? conversational
          ? `Okay, ${PROJECT_ADDRESS_QUESTION.toLowerCase()}`
          : PROJECT_ADDRESS_QUESTION
        : conversational
          ? `Okay, ${NAME_QUESTION.replace(/^What/, 'what')}`
          : NAME_QUESTION;
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'name': {
      if (isStandaloneBackchannel(callerTranscript)) {
        return { instructions: '', expectedTranscript: '' };
      }
      if (!hasUsableNameAnswer(callerTranscript, businessContext)) {
        const text = NAME_QUESTION;
        return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
      }
      const text = `${conversational ? 'Thanks. ' : ''}${PROJECT_ADDRESS_QUESTION}`;
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'address': {
      const text = hasCompleteProjectAddress(callerTranscript)
        ? `${conversational ? 'Got it. ' : ''}${SCHEDULE_QUESTION}`
        : looksLikeStreetAddress(callerTranscript)
          ? 'What city or town and state is the project in?'
          : PROJECT_ADDRESS_QUESTION;
      return { instructions: exactSpeechInstruction(text), expectedTranscript: text };
    }
    case 'schedule': {
      const text = !cleanText(callerTranscript)
        || hasCompleteAvailableSchedule(callerTranscript, businessContext)
        ? `${conversational ? 'Okay, sounds good. ' : ''}${NOTES_AND_QUESTIONS_PROMPT}`
        : SCHEDULE_QUESTION;
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
          instructions: `Answer only the caller's business question using only the supplied business data for this call. Do not add an answered question to the notes. Never answer from general knowledge, common industry knowledge, hardcoded fallback claims, or assumptions about the trade or service. Then ask exactly: ${JSON.stringify(MORE_NOTES_AND_QUESTIONS_PROMPT)} Do not ask another intake question and do not discuss how the caller's own project maps to a service.`,
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
        return summaryPreparationPlan();
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
          toolName: 'submit_estimate_request',
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
  return buildNextResponsePlan(options).instructions;
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

function prepareOutgoingEvent(event, pendingSummary) {
  if (!event || typeof event !== 'object') return { event, policy: null };

  if (event.type === 'session.update') {
    return { event, policy: null };
  }

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
        trustedPlan: true,
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
      this.addressCallerBuffer = [];
      this.pendingSummary = null;
      this.summaryCorrectionField = '';
      this.summaryPreparationRequired = false;
      this.summaryPreparationInFlight = false;
      this.prepareCallIds = new Set();
      this.pendingResponsePolicies = [];
      this.responsePoliciesById = new Map();
      this.responsePlanSequence = 0;
      this.repairAttempts = 0;
      this.submitCallIds = new Set();
      this.submissionStarted = false;
      this.failedSubmitFollowupPending = false;
      this.terminalPreparationFailurePending = false;
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

    summaryCorrectionAnswerIsComplete(field, transcript) {
      if (isConversationRepairRequest(transcript)) return false;
      switch (field) {
        case 'address':
          return hasCompleteProjectAddress(transcript);
        case 'schedule':
          return hasCompleteAvailableSchedule(transcript, context);
        case 'notes':
          return notesStepCompleted(transcript) || Boolean(cleanText(transcript));
        case 'service':
        case 'name':
          return Boolean(cleanText(transcript));
        default:
          return false;
      }
    }

    prepareCallerTurnResponse(event) {
      if (
        event.type !== 'response.create'
        || cleanText(event.response?.instructions)
      ) return { event, policy: null, suppressed: false };

      let answeredField = this.lastAnsweredField || this.pendingIntakeField || 'service';
      let plan;
      if (
        this.pendingSummary
        && !this.summaryCorrectionField
        && this.pendingIntakeField !== 'summary'
      ) {
        const speech = buildPreparedSummarySpeech(this.pendingSummary);
        plan = {
          instructions: exactSpeechInstruction(speech),
          expectedTranscript: speech,
        };
      } else if (this.summaryPreparationRequired) {
        if (this.summaryPreparationInFlight) {
          return { event, policy: null, suppressed: true };
        }
        answeredField = 'consent';
        plan = summaryPreparationPlan();
      } else {
        if (this.latestCallerDisposition === 'none') {
          return { event, policy: null, suppressed: false };
        }
        const summaryCorrectionComplete = answeredField === this.summaryCorrectionField
          && this.latestCallerDisposition === 'meaningful'
          && this.summaryCorrectionAnswerIsComplete(answeredField, this.latestCallerTranscript);
        plan = summaryCorrectionComplete
          ? {
            instructions: 'Call prepare_estimate_summary now using the corrected detail and every other previously confirmed detail. Do not repeat another intake question and do not speak before the tool call.',
            expectedTranscript: '',
            toolName: 'prepare_estimate_summary',
          }
          : buildNextResponsePlan({
            answeredField,
            callerTranscript: this.latestCallerTranscript,
            callerDisposition: this.latestCallerDisposition,
            businessName,
            businessContext: context,
            notesResolvedNegative: this.notesResolvedNegative,
            notesHadContent: this.notesHadContent,
            conversational: true,
          });
      }

      if (!plan.instructions) return { event, policy: null, suppressed: true };
      if (plan.toolName === 'prepare_estimate_summary') {
        this.summaryPreparationRequired = true;
      }

      event.response ||= {};
      event.response.instructions = plan.instructions;
      const allowedTool = plan.toolName
        ? ESTIMATE_TOOLS.find((tool) => tool.name === plan.toolName)
        : null;
      event.response.tools = allowedTool ? [structuredClone(allowedTool)] : [];
      event.response.tool_choice = allowedTool
        ? { type: 'function', name: allowedTool.name }
        : 'none';
      if (plan.expectedTranscript && !allowedTool) event.response.input = [];
      const planId = `caller-turn-${this.responsePlanSequence += 1}`;
      event.response.metadata = {
        ...(event.response.metadata || {}),
        [RESPONSE_PLAN_METADATA_KEY]: planId,
      };

      return {
        event,
        suppressed: false,
        policy: {
          expectedTranscript: plan.expectedTranscript || '',
          repairInstruction: plan.instructions,
          callerTranscript: this.latestCallerTranscript,
          callerDisposition: this.latestCallerDisposition,
          answeredField,
          trustedPlan: Boolean(plan.expectedTranscript && !allowedTool),
          requiredToolName: allowedTool?.name || '',
          planId,
        },
      };
    }

    send(value) {
      let event;
      try {
        event = JSON.parse(String(value));
      } catch {
        return this.inner.send(value);
      }

      const toolOutput = parseFunctionOutput(event);
      const functionOutputCallId = cleanText(event.item?.call_id);
      if (functionOutputCallId && this.prepareCallIds.has(functionOutputCallId)) {
        this.prepareCallIds.delete(functionOutputCallId);
        this.summaryPreparationInFlight = false;
        if (toolOutput?.terminal_preparation_failure === true) {
          this.summaryPreparationRequired = false;
          this.pendingSummary = null;
          this.terminalPreparationFailurePending = true;
          this.pendingIntakeField = '';
          this.lastAnsweredField = '';
          this.lastAnsweredTranscript = '';
        } else if (toolOutput?.status !== 'ready_for_confirmation' || !toolOutput.summary) {
          this.summaryPreparationRequired = true;
          this.pendingSummary = null;
        }
      }
      if (toolOutput?.status === 'ready_for_confirmation' && toolOutput.summary) {
        this.pendingSummary = toolOutput.summary;
        this.summaryCorrectionField = '';
        this.summaryPreparationRequired = false;
        this.summaryPreparationInFlight = false;
        this.addressCallerBuffer = [];
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
      const terminalPreparationFollowup = (
        event.type === 'response.create'
        && this.terminalPreparationFailurePending
      );
      if (terminalPreparationFollowup) {
        this.terminalPreparationFailurePending = false;
        event.response ||= {};
        event.response.instructions = exactSpeechInstruction(SUBMISSION_FAILURE_RESPONSE);
        event.response.input = [];
        event.response.tools = [];
        event.response.tool_choice = 'none';
      }

      const callerTurn = this.prepareCallerTurnResponse(event);
      if (callerTurn.suppressed) return false;

      const prepared = prepareOutgoingEvent(callerTurn.event, this.pendingSummary);
      if (callerTurn.policy) prepared.policy = callerTurn.policy;
      if (failedSubmitFollowup) {
        prepared.policy = {
          expectedTranscript: SUBMISSION_FAILURE_RESPONSE,
          repairInstruction: exactSpeechInstruction(SUBMISSION_FAILURE_RESPONSE),
        };
      }
      if (terminalPreparationFollowup) {
        prepared.policy = {
          expectedTranscript: SUBMISSION_FAILURE_RESPONSE,
          repairInstruction: exactSpeechInstruction(SUBMISSION_FAILURE_RESPONSE),
          trustedPlan: true,
        };
      }
      if (prepared.policy) {
        const allowMetadataFallback = !prepared.policy.planId;
        const planId = prepared.policy.planId || `response-plan-${this.responsePlanSequence += 1}`;
        prepared.policy.planId = planId;
        prepared.event.response ||= {};
        prepared.event.response.metadata = {
          ...(prepared.event.response.metadata || {}),
          [RESPONSE_PLAN_METADATA_KEY]: planId,
        };
        if (prepared.policy.trustedPlan && prepared.policy.expectedTranscript) {
          prepared.event.response.input = [];
        }
        this.responsePoliciesById.set(planId, prepared.policy);
        if (allowMetadataFallback) this.pendingResponsePolicies.push(prepared.policy);
      }
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
          itemIds: new Set(),
          callerDisposition: this.latestCallerDisposition,
          callerTranscript: this.latestCallerTranscript,
          answeredField: this.lastAnsweredField,
          notesResolvedNegative: this.notesResolvedNegative,
          notesHadContent: this.notesHadContent,
          policy: null,
          plannedTransitionCommitted: false,
          callerSpokeDuringResponse: false,
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

    commitTrustedPlan(state) {
      if (!state.policy?.trustedPlan || state.plannedTransitionCommitted) return;
      state.plannedTransitionCommitted = true;
      state.approved = true;
      state.answeredField = state.policy.answeredField || state.answeredField;
      state.callerTranscript = state.policy.callerTranscript || state.callerTranscript;
      state.callerDisposition = state.policy.callerDisposition || state.callerDisposition;

      const pending = classifyPendingField(state.policy.expectedTranscript);
      const answeredDifferentField = callerAnsweredDifferentField(
        state.answeredField,
        state.callerTranscript,
      );
      this.recordCompletedFields(state, pending, answeredDifferentField);
      if (pending) {
        if (pending === 'address' && state.answeredField !== 'address') {
          this.addressCallerBuffer = [];
        }
        this.pendingIntakeField = pending;
        if (pending === 'consent') {
          this.notesResolvedNegative = false;
          this.notesCallerBuffer = [];
        }
      }
      if (state.answeredField === 'address' && pending !== 'address') {
        this.addressCallerBuffer = [];
      }
      if (state.answeredField === 'notes') this.notesCallerBuffer = [];
      this.repairAttempts = 0;

      this.forwardCreated(state);
      for (const event of state.audioEvents.splice(0)) this.emitJson(event);
      for (const event of state.transcriptEvents.splice(0)) this.emitJson(event);
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
      return this.summaryPreparationRequired || (
        state.answeredField === 'consent'
        && isClearAffirmative(state.callerTranscript)
        && !state.policy?.expectedTranscript
      );
    }

    approveResponse(state, transcript, transcriptDoneEvent = null) {
      if (state.blocked) return false;
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
          this.summaryCorrectionField = pending;
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
          (!hasUsableServiceAnswer(state.callerTranscript, context) && pending !== 'service')
          || (
            hasUsableServiceAnswer(state.callerTranscript, context)
            && !callerVolunteeredName(state.callerTranscript)
            && pending !== 'name'
          )
          || (
            hasUsableServiceAnswer(state.callerTranscript, context)
            && callerVolunteeredName(state.callerTranscript)
            && pending !== 'address'
          )
        )
      ) {
        this.markBlocked(state);
        return false;
      }

      if (
        state.answeredField === 'name'
        && !looksLikeStreetAddress(state.callerTranscript)
        && (
          (hasUsableNameAnswer(state.callerTranscript, context) && pending !== 'address')
          || (!hasUsableNameAnswer(state.callerTranscript, context) && pending !== 'name')
        )
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
          : pending === 'address';
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
        if (pending === 'address' && state.answeredField !== 'address') {
          this.addressCallerBuffer = [];
        }
        this.pendingIntakeField = pending;
        if (pending === 'consent') {
          this.notesResolvedNegative = false;
          this.notesCallerBuffer = [];
        }
      }
      if (state.answeredField === 'address' && pending !== 'address') {
        this.addressCallerBuffer = [];
      }
      if (state.answeredField === 'notes') this.notesCallerBuffer = [];
      this.repairAttempts = 0;
      return true;
    }

    sendRepair(plan) {
      if (!plan?.instructions || this.repairAttempts >= MAX_REPAIR_ATTEMPTS) return;
      this.repairAttempts += 1;
      const allowedTool = plan.toolName
        ? ESTIMATE_TOOLS.find((tool) => tool.name === plan.toolName)
        : null;
      const planId = `repair-${this.responsePlanSequence += 1}`;
      const policy = {
        expectedTranscript: plan.expectedTranscript || '',
        repairInstruction: plan.instructions,
        callerTranscript: this.latestCallerTranscript,
        requiredToolName: allowedTool?.name || '',
        trustedPlan: Boolean(plan.expectedTranscript && !allowedTool),
        planId,
      };
      this.responsePoliciesById.set(planId, policy);
      this.inner.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: plan.instructions,
          ...(plan.expectedTranscript && !allowedTool ? { input: [] } : {}),
          tools: allowedTool ? [structuredClone(allowedTool)] : [],
          tool_choice: allowedTool
            ? { type: 'function', name: allowedTool.name }
            : 'none',
          metadata: {
            [RESPONSE_PLAN_METADATA_KEY]: planId,
          },
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

      if (!repair) return;

      if (
        this.summaryPreparationRequired
        || state.policy?.requiredToolName === 'prepare_estimate_summary'
      ) {
        this.summaryPreparationRequired = true;
        this.summaryPreparationInFlight = false;
        this.sendRepair(summaryPreparationPlan());
        return;
      }

      if (state.callerSpokeDuringResponse) return;

      if (state.policy?.repairInstruction && !state.policy.stale) {
        this.sendRepair({
          instructions: state.policy.repairInstruction,
          expectedTranscript: state.policy.expectedTranscript || '',
          toolName: state.policy.requiredToolName || '',
        });
        return;
      }

      if (
        this.pendingSummary
        && !this.summaryCorrectionField
        && this.pendingIntakeField !== 'summary'
      ) {
        const speech = buildPreparedSummarySpeech(this.pendingSummary);
        this.sendRepair({
          instructions: exactSpeechInstruction(speech),
          expectedTranscript: speech,
        });
        return;
      }

      const plan = buildNextResponsePlan({
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
        this.emitJson(event);
        return;
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        for (const state of this.responses.values()) {
          state.callerSpokeDuringResponse = true;
        }
        const callerTranscript = cleanText(event.transcript);
        const disposition = callerTranscriptDisposition(callerTranscript);
        this.latestCallerTranscript = callerTranscript;
        this.latestCallerDisposition = disposition;

        let answeredField = this.pendingIntakeField;
        let effectiveTranscript = callerTranscript;
        if (
          disposition === 'meaningful'
          && this.pendingIntakeField === 'consent'
          && isClearAffirmative(callerTranscript)
        ) {
          if (!this.summaryPreparationRequired) this.summaryPreparationInFlight = false;
          this.summaryPreparationRequired = true;
          this.completedIntakeFields.add('consent');
          this.repairAttempts = 0;
        }
        if (disposition === 'meaningful' && this.pendingIntakeField) {
          if (
            this.pendingIntakeField === 'address'
            && !isConversationRepairRequest(callerTranscript)
            && !callerAnsweredDifferentField('address', callerTranscript)
          ) {
            this.addressCallerBuffer.push(callerTranscript);
            effectiveTranscript = cleanText(this.addressCallerBuffer.join(' '));
          }

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

        this.emitJson(event);
        return;
      }

      if (event.type === 'response.created') {
        const state = this.responseState(event.response?.id);
        state.createdEvent = event;
        const planId = cleanText(event.response?.metadata?.[RESPONSE_PLAN_METADATA_KEY]);
        if (planId && this.responsePoliciesById.has(planId)) {
          state.policy = this.responsePoliciesById.get(planId);
          this.responsePoliciesById.delete(planId);
          this.pendingResponsePolicies = this.pendingResponsePolicies.filter(
            (policy) => policy.planId !== planId,
          );
        } else if (this.pendingResponsePolicies.length) {
          state.policy = this.pendingResponsePolicies.shift();
          if (state.policy?.planId) this.responsePoliciesById.delete(state.policy.planId);
        }
        if (state.policy?.planId) {
          state.answeredField = state.policy.answeredField || state.answeredField;
          state.callerTranscript = state.policy.callerTranscript || state.callerTranscript;
          state.callerDisposition = state.policy.callerDisposition || state.callerDisposition;
        }
        this.commitTrustedPlan(state);
        this.forwardCreated(state);
        return;
      }

      if (event.type === 'response.output_audio.delta' && event.delta) {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        if (state.blocked) return;
        this.commitTrustedPlan(state);
        if (state.approved) this.emitJson(event);
        else state.audioEvents.push(event);
        return;
      }

      if (event.type === 'response.output_audio_transcript.delta') {
        const state = this.responseState(event.response_id);
        const itemId = cleanText(event.item_id);
        if (itemId) state.itemIds.add(itemId);
        state.transcript += String(event.delta || '');
        if (state.blocked) return;
        this.commitTrustedPlan(state);
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
        if (state.policy?.trustedPlan) {
          this.commitTrustedPlan(state);
          if (!state.transcriptForwarded) {
            this.emitJson(event);
            state.transcriptForwarded = true;
          }
          return;
        }
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

        if (!state.transcript) state.transcript = extractResponseTranscript(event.response);
        if (state.policy?.trustedPlan && state.transcript) this.commitTrustedPlan(state);
        const hasPrepareCall = hasFunctionCall(event.response, 'prepare_estimate_summary');
        const hasSubmitCall = hasFunctionCall(event.response, 'submit_estimate_request');
        const isSubmissionStart = sameSpokenText(state.transcript, SUBMISSION_START_RESPONSE);

        if (!state.policy?.trustedPlan && isSubmissionStart) {
          if (!this.shouldRequireSubmissionStart(state) || !hasSubmitCall) {
            this.markBlocked(state);
          } else if (!state.approved) {
            this.approveResponse(state, state.transcript, state.transcriptDoneEvent);
          }
        } else if (!state.policy?.trustedPlan && !state.approved && !state.blocked && state.transcript) {
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

        if (
          state.policy?.requiredToolName
          && !hasFunctionCall(event.response, state.policy.requiredToolName)
        ) {
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
            && cleanText(item.name) === 'prepare_estimate_summary'
            && cleanText(item.call_id)
          ) {
            this.prepareCallIds.add(cleanText(item.call_id));
            if (this.summaryPreparationRequired) this.summaryPreparationInFlight = true;
          }
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
  } = options;
  const GuardedWebSocketClass = createGuardedWebSocketClass({
    context,
    InnerWebSocketClass,
  });
  return createOpenAiReceptionist({
    ...options,
    WebSocketClass: GuardedWebSocketClass,
  });
}
