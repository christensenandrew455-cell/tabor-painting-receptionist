import { createHash } from 'node:crypto';
import { cleanText } from './business-context.js';

const WEEKDAYS = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

const MONTHS = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});

const SPOKEN_HOURS = Object.freeze({
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
});

function fail(message, field = '') {
  const error = new Error(message);
  error.field = field;
  throw error;
}

function isConversationMetadataNote(value) {
  const text = cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
  if (!text) return true;
  return /^no (?:other |additional )?(?:project )?notes? (?:(?:were|was) )?provided\b/.test(text)
    || /\bwhat(?:'s| is) (?:the|your) question\b/.test(text)
    || /\b(?:did not|didn't) (?:even )?ask (?:a|the|that|any) question\b/.test(text)
    || /\b(?:caller|customer|they|he|she) (?:asked|wondered|said)\b.*\bwhat\b.*\b(?:talking|asking) about\b/.test(text)
    || /\b(?:consent(?:ed)?|permission)\b.*\bcontact(?:ed)?\b/.test(text)
    || /^(?:hello|are you (?:still )?there|can you hear me)$/i.test(text);
}

export function sanitizeAdditionalNotes(value) {
  const text = cleanText(value);
  if (!text) return '';
  return text
    .split(/\s*;\s*|(?<=[.!?])\s+/)
    .map((part) => cleanText(part))
    .filter((part) => part && !isConversationMetadataNote(part))
    .join(' ')
    .trim();
}

function datePartsInZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  );
  return { year: values.year, month: values.month, day: values.day };
}

function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateFromNumeric(match, today) {
  let year = match[3] ? Number(match[3]) : today.getUTCFullYear();
  if (year < 100) year += 2000;
  let date = calendarDate(year, Number(match[1]), Number(match[2]));
  if (!match[3] && date && date < today) {
    date = calendarDate(year + 1, Number(match[1]), Number(match[2]));
  }
  return date;
}

function parseRequestedDate(text, today) {
  if (text === 'today') return today;
  if (text === 'tomorrow') return addDays(today, 1);
  if (text === 'day after tomorrow' || text === 'the day after tomorrow') return addDays(today, 2);

  const relative = text.match(/^in\s+(\d{1,3})\s+(day|days|week|weeks)$/);
  if (relative) {
    const amount = Number(relative[1]) * (relative[2].startsWith('week') ? 7 : 1);
    return addDays(today, amount);
  }

  const weekday = text.match(/^(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (weekday) {
    const target = WEEKDAYS[weekday[2]];
    let daysAhead = (target - today.getUTCDay() + 7) % 7;
    if (weekday[1] === 'next') daysAhead += 7;
    return addDays(today, daysAhead);
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (numeric) return dateFromNumeric(numeric, today);

  const written = text.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s+(\d{2}|\d{4}))?$/);
  if (!written) return null;
  let year = written[3] ? Number(written[3]) : today.getUTCFullYear();
  if (year < 100) year += 2000;
  let date = calendarDate(year, MONTHS[written[1]], Number(written[2]));
  if (!written[3] && date && date < today) {
    date = calendarDate(year + 1, MONTHS[written[1]], Number(written[2]));
  }
  return date;
}

export function resolveRequestedDate(value, { now = new Date(), timeZone = 'America/New_York' } = {}) {
  const input = cleanText(value)
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!input) fail('Ask the caller for their preferred estimate date.', 'preferred_date');

  let todayParts;
  try {
    todayParts = datePartsInZone(now, timeZone);
  } catch {
    fail('The business time zone is invalid.', 'preferred_date');
  }
  const today = calendarDate(todayParts.year, todayParts.month, todayParts.day);
  const date = parseRequestedDate(input, today);
  if (!date) {
    fail('That date was unclear. Ask which date they prefer.', 'preferred_date');
  }
  if (date < today) fail('The requested date must be today or later.', 'preferred_date');

  const exactDate = date.toISOString().slice(0, 10);
  const spokenDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
  return Object.freeze({ input: cleanText(value), exactDate, spokenDate });
}

function inferTimeFromEstimateHours(hour, minute, context = {}) {
  const earliest = businessEstimateTime(context.earliestEstimateStart);
  const latest = businessEstimateTime(context.latestEstimateStart);
  if (!earliest && !latest) return null;

  const baseHour = hour % 12;
  const candidates = [
    { hour: baseHour, minutes: baseHour * 60 + minute },
    { hour: baseHour + 12, minutes: (baseHour + 12) * 60 + minute },
  ].filter((candidate) => (
    (!earliest || candidate.minutes >= earliest.minutes)
    && (!latest || candidate.minutes <= latest.minutes)
  ));

  return candidates.length === 1 ? candidates[0].hour : null;
}

export function normalizeRequestedTime(value, context = {}) {
  let input = cleanText(value)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bo\s*'?clock\b/g, '')
    .replace(/^(?:at|around|about)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!input) fail('Ask the caller for their preferred estimate time.', 'preferred_time');
  if (input === 'noon') input = '12 pm';
  if (input === 'midnight') input = '12 am';

  const spoken = input.match(/^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*(am|pm))?$/);
  if (spoken) {
    input = `${SPOKEN_HOURS[spoken[1]]}${spoken[2] ? ` ${spoken[2]}` : ''}`;
  }

  const match = input.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/);
  if (!match) fail('That time was unclear. Ask what time they prefer.', 'preferred_time');

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3];
  if (!meridiem && hour >= 1 && hour <= 12) {
    const inferredHour = inferTimeFromEstimateHours(hour, minute, context);
    if (inferredHour === null) {
      fail('Ask the caller whether that time is AM or PM.', 'preferred_time');
    }
    hour = inferredHour;
  }
  if (meridiem && (hour < 1 || hour > 12)) {
    fail('That time is invalid. Ask for a valid AM or PM time.', 'preferred_time');
  }
  if (!meridiem && (hour < 0 || hour > 23)) {
    fail('That time is invalid. Ask for a valid time.', 'preferred_time');
  }

  if (meridiem) {
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  }
  const displayHour = hour % 12 || 12;
  const displayMeridiem = hour >= 12 ? 'PM' : 'AM';
  return `${displayHour}:${String(minute).padStart(2, '0')} ${displayMeridiem}`;
}

function timeInMinutes(value) {
  const match = cleanText(value).match(/^(1[0-2]|[1-9]):([0-5]\d)\s+(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(match[2]);
}

function businessEstimateTime(value) {
  const text = cleanText(value);
  const twentyFourHour = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFourHour) {
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2]);
    const displayHour = hour % 12 || 12;
    const meridiem = hour >= 12 ? 'PM' : 'AM';
    return {
      display: `${displayHour}:${String(minute).padStart(2, '0')} ${meridiem}`,
      minutes: hour * 60 + minute,
    };
  }

  try {
    const display = normalizeRequestedTime(text);
    return { display, minutes: timeInMinutes(display) };
  } catch {
    return null;
  }
}

function titleCase(value) {
  const text = cleanText(value).toLowerCase();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : '';
}

function readableWeekdays(weekdays) {
  const labels = weekdays.map(titleCase);
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

export function validateEstimateAvailability(date, requestedTime, context = {}) {
  const estimateWeekdays = Array.isArray(context.estimateWeekdays)
    ? context.estimateWeekdays.map((day) => cleanText(day).toLowerCase()).filter(Boolean)
    : [];
  const requestedDate = new Date(`${date.exactDate}T12:00:00.000Z`);
  const requestedWeekday = Object.keys(WEEKDAYS).find(
    (weekday) => WEEKDAYS[weekday] === requestedDate.getUTCDay(),
  );

  if (estimateWeekdays.length && !estimateWeekdays.includes(requestedWeekday)) {
    fail(
      `${date.spokenDate} is outside the business's estimate days. Ask for ${readableWeekdays(estimateWeekdays)}.`,
      'preferred_date',
    );
  }

  const earliest = businessEstimateTime(context.earliestEstimateStart);
  const latest = businessEstimateTime(context.latestEstimateStart);
  const requestedMinutes = timeInMinutes(requestedTime);
  const beforeOpening = earliest && requestedMinutes < earliest.minutes;
  const afterClosing = latest && requestedMinutes > latest.minutes;
  if (beforeOpening || afterClosing) {
    const allowedHours = earliest && latest
      ? `${earliest.display} through ${latest.display}`
      : (earliest ? `${earliest.display} or later` : `${latest.display} or earlier`);
    fail(
      `${requestedTime} is outside the business's estimate hours. Ask for ${allowedHours}.`,
      'preferred_time',
    );
  }
}

function normalizedService(value) {
  return cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchService(value, services = []) {
  const requested = normalizedService(value);
  if (!requested) fail('Ask which service the caller needs.', 'service');
  if (!services.length) return cleanText(value);

  const exact = services.find((service) => normalizedService(service.name) === requested);
  if (exact) return exact.name;

  const candidates = services.filter((service) => {
    const name = normalizedService(service.name);
    return name && (requested.includes(name) || name.includes(requested));
  });
  if (candidates.length === 1) return candidates[0].name;
  const choices = services.map((service) => service.name).join(', ');
  fail(`Match the caller's request to one of these website services: ${choices}.`, 'service');
}

function requiredText(value, field, label, maxLength) {
  const text = cleanText(value);
  if (!text) fail(`Ask the caller for ${label}.`, field);
  if (text.length > maxLength) fail(`${label} is too long. Ask the caller to shorten it.`, field);
  return text;
}

export function normalizeEstimateDraft(args = {}, context, now = new Date()) {
  if (args.additional_notes_asked !== true) {
    fail('Ask the caller whether they have any additional project notes before continuing.', 'additional_notes_asked');
  }
  if (args.consent_asked_separately !== true) {
    fail('Ask for contact permission as a separate question before continuing.', 'consent_asked_separately');
  }
  if (args.consent_to_contact !== true) {
    fail('The request cannot be prepared without the caller explicitly consenting to business contact.', 'consent_to_contact');
  }

  const date = resolveRequestedDate(args.preferred_date, {
    now,
    timeZone: context.timeZone,
  });
  const requestedTime = normalizeRequestedTime(args.preferred_time, context);
  validateEstimateAvailability(date, requestedTime, context);
  return Object.freeze({
    service: matchService(args.service, context.services),
    name: requiredText(args.name, 'name', 'their name', 120),
    address: requiredText(args.address, 'address', 'the project address', 300),
    requestedDateInput: date.input,
    requestedDate: date.exactDate,
    requestedDateSpoken: date.spokenDate,
    requestedTime,
    additionalNotes: sanitizeAdditionalNotes(args.additional_notes).slice(0, 1_000),
    consentToContact: true,
  });
}

export function estimateSummary(draft) {
  return Object.freeze({
    name: draft.name,
    service: draft.service,
    address: draft.address,
    preferredDateAndTime: `${draft.requestedDateSpoken} at ${draft.requestedTime}`,
    notes: draft.additionalNotes || 'None',
  });
}

function requestId(callControlId, draft) {
  return createHash('sha256')
    .update(`${cleanText(callControlId)}:${JSON.stringify(draft)}`)
    .digest('hex');
}

export function buildWebsitePayload({ context, callControlId, callerPhone, draft, submittedAt }) {
  const phone = cleanText(callerPhone);
  return Object.freeze({
    type: 'estimate_request',
    clientId: context.clientId,
    callControlId: cleanText(callControlId),
    source: 'ai_receptionist',
    callerPhone: phone,
    service: draft.service,
    name: draft.name,
    address: draft.address,
    requestedDate: draft.requestedDate,
    requestedTime: draft.requestedTime,
    additionalNotes: draft.additionalNotes,
    consentToContact: true,
    summaryConfirmed: true,
    submittedAt,
    Name: draft.name,
    Phone: phone,
    Address: draft.address,
    Job: draft.service,
    PreferredDate: draft.requestedDate,
    PreferredTime: draft.requestedTime,
    Notes: draft.additionalNotes,
  });
}

export function createIntakeManager({
  context,
  callControlId,
  callerPhone,
  deliver,
  now = () => new Date(),
}) {
  let draft = null;
  let idempotencyKey = '';
  let submission = null;

  return Object.freeze({
    prepare(args) {
      if (submission) {
        return { ok: false, error: 'The estimate request has already been sent. Answer questions only.' };
      }
      draft = normalizeEstimateDraft(args, context, now());
      idempotencyKey = requestId(callControlId, draft);
      return {
        ok: true,
        status: 'ready_for_confirmation',
        summary: estimateSummary(draft),
        instruction: 'Read only the five returned summary fields to the caller, then ask for a clear yes or no confirmation. Do not mention contact consent.',
      };
    },

    async submit(args = {}) {
      if (submission) {
        return { ok: true, status: 'already_submitted', submission };
      }
      if (!draft) {
        return { ok: false, error: 'Prepare and read back the estimate summary before submitting.' };
      }
      if (args.caller_confirmed !== true) {
        return { ok: false, error: 'Do not submit until the caller clearly confirms the complete summary.' };
      }

      const submittedAt = now().toISOString();
      const payload = buildWebsitePayload({
        context,
        callControlId,
        callerPhone,
        draft,
        submittedAt,
      });
      const result = await deliver(payload, { idempotencyKey });
      submission = Object.freeze({
        idempotencyKey,
        submittedAt,
        websiteResponse: result,
      });
      return { ok: true, status: 'submitted', submission };
    },

    get phase() {
      if (submission) return 'submitted';
      if (draft) return 'ready_for_confirmation';
      return 'collecting';
    },

    snapshot() {
      return {
        phase: submission ? 'submitted' : (draft ? 'ready_for_confirmation' : 'collecting'),
        draft: draft ? { ...draft } : null,
        submission,
      };
    },
  });
}
