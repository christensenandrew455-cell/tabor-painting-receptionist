import {
  buildQuestionCatalog,
  buildReceptionistPrompt,
  callMemorySummary,
  createCallMemory,
  rememberAssistant,
  rememberCaller,
  resetIntakeMemory,
  serviceList as configuredServiceList,
} from './receptionist-customization.js';

function cleanText(value = '') {
  return String(value ?? '').trim();
}

function requireEnv(name) {
  const value = cleanText(process.env[name]);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredNumber(name, minimum, maximum) {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function parseBusinessInfo() {
  const raw = requireEnv('BUSINESS_INFO');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BUSINESS_INFO must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BUSINESS_INFO must be one JSON object.');
  }
  return parsed;
}

function requiredText(config, field) {
  const value = cleanText(config[field]);
  if (!value) throw new Error(`BUSINESS_INFO.${field} is required.`);
  return value;
}

function requiredList(config, field) {
  const value = config[field];
  const list = Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter(Boolean)
    : typeof value === 'string'
      ? value.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
  if (!list.length) throw new Error(`BUSINESS_INFO.${field} must contain at least one value.`);
  return list;
}

function requiredServices(config) {
  const value = config.services;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BUSINESS_INFO.services must be a JSON object of service names and descriptions.');
  }
  const entries = Object.entries(value)
    .map(([name, description]) => [cleanText(name).toLowerCase(), cleanText(description)])
    .filter(([name, description]) => name && description);
  if (!entries.length) throw new Error('BUSINESS_INFO.services must contain at least one service.');
  return Object.fromEntries(entries);
}

function cleanClientId(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const AUDIO_FORMAT = Object.freeze({ type: 'audio/pcmu' });
export const REALTIME_MODEL = requireEnv('AI_MODEL');
export const REALTIME_VOICE = requireEnv('AI_VOICE');
export const SPEECH_SPEED = requiredNumber('AI_SPEECH_SPEED', 0.25, 1.5);
export const SILENCE_DURATION_MS = Math.round(requiredNumber('AI_SILENCE_MS', 300, 3000));

const configuredBusiness = parseBusinessInfo();

export const BUSINESS = Object.freeze({
  name: requiredText(configuredBusiness, 'name'),
  receptionist: requiredText(configuredBusiness, 'receptionist'),
  owner: requiredText(configuredBusiness, 'owner'),
  phone: requiredText(configuredBusiness, 'phone'),
  email: requiredText(configuredBusiness, 'email'),
  hours: requiredText(configuredBusiness, 'hours'),
  timeZone: requiredText(configuredBusiness, 'timeZone'),
  estimateDays: requiredText(configuredBusiness, 'estimateDays'),
  estimateWeekdays: requiredList(configuredBusiness, 'estimateWeekdays').map((day) => day.toLowerCase()),
  earliestEstimateStart: requiredText(configuredBusiness, 'earliestEstimateStart'),
  latestEstimateStart: requiredText(configuredBusiness, 'latestEstimateStart'),
  base: requiredText(configuredBusiness, 'base'),
  serviceAreas: requiredList(configuredBusiness, 'serviceAreas'),
  services: requiredServices(configuredBusiness),
  about: Array.isArray(configuredBusiness.about)
    ? configuredBusiness.about.map((item) => cleanText(item)).filter(Boolean)
    : cleanText(configuredBusiness.about) ? [cleanText(configuredBusiness.about)] : [],
  openingLine: requiredText(configuredBusiness, 'openingLine'),
  closingLine: requiredText(configuredBusiness, 'closingLine'),
  extraInformation: cleanText(configuredBusiness.extraInformation),
});

try {
  new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS.timeZone }).format();
} catch {
  throw new Error('BUSINESS_INFO.timeZone must be a valid IANA time zone, such as America/New_York.');
}

const CLIENT_ID = cleanClientId(requireEnv('OCM_CLIENT_ID'));
if (!CLIENT_ID) throw new Error('OCM_CLIENT_ID must contain letters, numbers, hyphens, or underscores.');

const OWNER_FIRST_NAME = BUSINESS.owner.split(/\s+/).filter(Boolean)[0] || 'the owner';
const SERVICE_TYPES = Object.freeze(Object.keys(BUSINESS.services));
const WEEKDAYS = Object.freeze(BUSINESS.estimateWeekdays);
const WEEKDAY_INDEX = Object.freeze({ sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 });
const MONTH_INDEX = Object.freeze({
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
});

function serviceList() {
  return configuredServiceList(BUSINESS.services);
}

function weekdayList() {
  const labels = WEEKDAYS.map((day) => day.charAt(0).toUpperCase() + day.slice(1));
  if (labels.length <= 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
}

const TEMPLATE_VALUES = Object.freeze({
  business_name: BUSINESS.name,
  receptionist_name: BUSINESS.receptionist,
  owner_name: BUSINESS.owner,
  owner_first_name: OWNER_FIRST_NAME,
  services: serviceList(),
  service_list: serviceList(),
  estimate_days: BUSINESS.estimateDays,
  earliest_estimate_time: BUSINESS.earliestEstimateStart,
  latest_estimate_time: BUSINESS.latestEstimateStart,
});

export function renderTemplate(value = '') {
  return String(value || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const replacement = TEMPLATE_VALUES[String(key).toLowerCase()];
    return replacement === undefined ? match : replacement;
  });
}

export const openingLine = renderTemplate(BUSINESS.openingLine);
export const closingLine = `Okay. Thank you for calling ${BUSINESS.name}. Have a good day.`;
export const afterSaveQuestion = `Do you have any other questions about ${BUSINESS.name}?`;
export const afterSaveFollowUpQuestion = afterSaveQuestion;
export const saveSuccessLine = `The request has been sent out. ${BUSINESS.name} will follow up with you shortly. ${afterSaveQuestion}`;
export const contactConsentQuestion = `Do you consent to being contacted by ${BUSINESS.name}?`;
export const contactConsentRefusalLine = `I'm sorry, I cannot submit the estimate request unless you consent to being contacted by ${BUSINESS.name}.`;
export const contactConsentFinalLine = `${contactConsentRefusalLine} Goodbye.`;
export const saveFailureLine = "I'm sorry. The request couldn't get sent out.";
export const cancellationLine = `Okay, no problem. I've canceled the estimate request. Do you have any questions about ${BUSINESS.name} or its services?`;
export const SAFETY_IDENTIFIER = CLIENT_ID || 'ark-receptionist';
export const TRANSCRIPTION_PROMPT = '';
export const questionCatalog = buildQuestionCatalog({ business: BUSINESS, ownerFirstName: OWNER_FIRST_NAME });

export {
  callMemorySummary,
  createCallMemory,
  rememberAssistant,
  rememberCaller,
  resetIntakeMemory,
};

export function getCallerPhone(payload = {}) {
  const candidates = [
    payload?.data?.payload?.from,
    payload?.payload?.from,
    payload?.start?.from,
    payload?.start?.caller_id_number,
    payload?.from,
    payload?.caller_id_number,
  ];
  return cleanText(candidates.find((value) => cleanText(value))).replace(/^tel:/i, '');
}

function clockMinutes(value) {
  const raw = cleanText(value)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bo\s*'?clock\b/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3] || '';

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  } else if (hour >= 1 && hour <= 12) {
    const earliest = clockMinutes(BUSINESS.earliestEstimateStart);
    const latest = clockMinutes(BUSINESS.latestEstimateStart);
    const morning = hour * 60 + minute;
    const afternoon = (hour === 12 ? 12 : hour + 12) * 60 + minute;
    if (earliest !== null && latest !== null) {
      if (morning >= earliest && morning <= latest) return morning;
      if (afternoon >= earliest && afternoon <= latest) return afternoon;
    }
    return morning;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return hour * 60 + minute;
}

function displayClock(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const displayHour = hour % 12 || 12;
  const displayMinute = String(minute).padStart(2, '0');
  const displayMeridiem = hour >= 12 ? 'PM' : 'AM';
  return `${displayHour}:${displayMinute} ${displayMeridiem}`;
}

export function normalizePreferredTime(value = '') {
  const minutesAfterMidnight = clockMinutes(value);
  if (minutesAfterMidnight === null) return '';

  const earliest = clockMinutes(BUSINESS.earliestEstimateStart);
  const latest = clockMinutes(BUSINESS.latestEstimateStart);
  if (earliest === null || latest === null || earliest > latest) {
    throw new Error('BUSINESS_INFO estimate start times are invalid.');
  }
  if (minutesAfterMidnight < earliest || minutesAfterMidnight > latest) return '';
  return displayClock(minutesAfterMidnight);
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function todayInBusinessTimeZone(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`);
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function weekdayAllowed(date) {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(date).toLowerCase();
  return WEEKDAYS.includes(weekday);
}

function nextAllowedDayOfMonth(day, today, monthIndex = null, year = null) {
  const candidates = [];
  const startYear = year ?? today.getUTCFullYear();
  const startMonth = monthIndex ?? today.getUTCMonth();
  for (let offset = 0; offset < 14; offset += 1) {
    const month = monthIndex === null ? startMonth + offset : startMonth;
    const candidate = new Date(Date.UTC(year ?? startYear, month, day, 12));
    if (candidate.getUTCDate() !== day) continue;
    if (candidate <= today) continue;
    candidates.push(candidate);
    if (monthIndex !== null) break;
  }
  return candidates.find(weekdayAllowed) || null;
}

export function resolvePreferredDate(value = '', now = new Date()) {
  const raw = cleanText(value);
  if (!raw) return '';
  const today = todayInBusinessTimeZone(now);
  const normalized = raw.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedWeekday = normalized.replace(/^(?:this|next)\s+/, '');

  if (WEEKDAY_INDEX[normalizedWeekday] !== undefined) {
    const target = new Date(today);
    const delta = (WEEKDAY_INDEX[normalizedWeekday] - target.getUTCDay() + 7) % 7 || 7;
    target.setUTCDate(target.getUTCDate() + delta);
    return weekdayAllowed(target) ? formatIsoDate(target) : '';
  }

  let candidate = '';
  if (validIsoDate(raw)) candidate = raw;
  else {
    const numeric = normalized.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
    if (numeric) {
      const [, month, day, rawYear] = numeric;
      let year = rawYear ? Number(rawYear) : today.getUTCFullYear();
      if (rawYear && rawYear.length === 2) year += 2000;
      let date = new Date(Date.UTC(year, Number(month) - 1, Number(day), 12));
      if (!rawYear && date <= today) date = new Date(Date.UTC(year + 1, Number(month) - 1, Number(day), 12));
      candidate = formatIsoDate(date);
    } else {
      const named = normalized.match(/^(?:on\s+)?(?:the\s+)?(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
      if (named) {
        const [, monthName, dayText, yearText] = named;
        const date = nextAllowedDayOfMonth(
          Number(dayText),
          today,
          monthName ? MONTH_INDEX[monthName] : null,
          yearText ? Number(yearText) : null,
        );
        if (date) candidate = formatIsoDate(date);
      }
    }
  }

  if (!validIsoDate(candidate)) return '';
  const date = new Date(`${candidate}T12:00:00Z`);
  if (date <= today || !weekdayAllowed(date)) return '';
  return candidate;
}

export function validateLead(rawLead = {}, now = new Date()) {
  const lead = {
    fullName: cleanText(rawLead.fullName),
    serviceType: cleanText(rawLead.serviceType).toLowerCase(),
    cityOrTown: cleanText(rawLead.cityOrTown),
    state: cleanText(rawLead.state),
    streetNumber: cleanText(rawLead.streetNumber),
    streetName: cleanText(rawLead.streetName),
    preferredDateOrDay: cleanText(rawLead.preferredDateOrDay),
    preferredTime: cleanText(rawLead.preferredTime),
    additionalNotes: cleanText(rawLead.additionalNotes),
    contactConsent: rawLead.contactConsent === true,
  };

  const errors = [];
  const parts = lead.fullName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) errors.push('the caller first and last name');
  if (!SERVICE_TYPES.includes(lead.serviceType)) errors.push(`one configured service: ${serviceList()}`);
  if (!lead.cityOrTown) errors.push('the project city or town');
  if (!lead.state) errors.push('the project state');
  if (!lead.streetNumber) errors.push('the project street number');
  if (!lead.streetName) errors.push('the project street name');
  const preferredDate = resolvePreferredDate(lead.preferredDateOrDay, now);
  if (!preferredDate) errors.push(`an upcoming configured estimate date or weekday: ${weekdayList()}`);
  const preferredTime = normalizePreferredTime(lead.preferredTime);
  if (!preferredTime) errors.push(`an estimate time from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}`);
  if (!lead.contactConsent) errors.push('clear consent to be contacted');

  return {
    valid: errors.length === 0,
    errors,
    lead: { ...lead, preferredDate, preferredTime },
  };
}

export function buildOcmPayload(callerPhone, lead) {
  const [FirstName, ...lastParts] = cleanText(lead.fullName).split(/\s+/);
  const LastName = lastParts.join(' ');
  const streetAddress = `${lead.streetNumber} ${lead.streetName}`.trim();
  return {
    clientId: CLIENT_ID,
    FirstName,
    LastName,
    Name: lead.fullName,
    Phone: cleanText(callerPhone),
    Job: lead.serviceType,
    ServiceType: lead.serviceType,
    StreetAddress: streetAddress,
    TownOrCity: lead.cityOrTown,
    State: lead.state,
    Address: `${streetAddress}, ${lead.cityOrTown}, ${lead.state}`,
    PreferredDate: lead.preferredDate,
    EstimateDate: lead.preferredDate,
    PreferredDay: lead.preferredDateOrDay,
    PreferredTime: lead.preferredTime,
    Notes: lead.additionalNotes || 'none',
    source: `${CLIENT_ID}-receptionist`,
  };
}

export const tools = Object.freeze([
  {
    type: 'function',
    name: 'submit_estimate_lead',
    description: 'Submit the fully confirmed estimate request after the caller agrees to be contacted and confirms the complete summary.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullName: { type: 'string' },
        serviceType: { type: 'string', enum: SERVICE_TYPES },
        cityOrTown: { type: 'string' },
        state: { type: 'string' },
        streetNumber: { type: 'string' },
        streetName: { type: 'string' },
        preferredDateOrDay: { type: 'string' },
        preferredTime: { type: 'string' },
        additionalNotes: { type: 'string' },
        contactConsent: { type: 'boolean' },
      },
      required: ['fullName', 'serviceType', 'cityOrTown', 'state', 'streetNumber', 'streetName', 'preferredDateOrDay', 'preferredTime', 'contactConsent'],
    },
  },
  {
    type: 'function',
    name: 'record_contact_consent',
    description: 'Record whether the caller clearly agreed to be contacted about this estimate request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { agreed: { type: 'boolean' } },
      required: ['agreed'],
    },
  },
  {
    type: 'function',
    name: 'finish_call',
    description: 'Finish the call only after the estimate has been saved or a save attempt has failed and the caller has no more questions.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
]);

export function instructions(now = new Date()) {
  const currentDateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS.timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  return buildReceptionistPrompt({ business: BUSINESS, ownerFirstName: OWNER_FIRST_NAME, currentDateLabel });
}
