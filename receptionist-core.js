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
const WEEKDAY_INDEX = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
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
export const closingLine = renderTemplate(BUSINESS.closingLine);
export const afterSaveQuestion = `Do you have any questions about ${BUSINESS.name}?`;
export const afterSaveFollowUpQuestion = `Do you have any other questions about ${BUSINESS.name}?`;
export const saveSuccessLine = `Perfect. Your estimate request has been sent to ${BUSINESS.name}. They will follow up with you shortly. Before I go, ${afterSaveQuestion.toLowerCase()}`;
export const contactConsentQuestion = `Do you agree to be contacted by ${BUSINESS.name} about this estimate request?`;
export const contactConsentRefusalLine = `I'm sorry, I cannot submit the estimate request unless you agree to be contacted by ${BUSINESS.name}.`;
export const contactConsentFinalLine = `${contactConsentRefusalLine} Goodbye.`;
export const saveFailureLine = `I'm sorry, the estimate request was not submitted. Please try to submit a new estimate request in 24 hours.`;
export const cancellationLine = `Okay, no problem. I've canceled the estimate request. Do you have any questions about ${BUSINESS.name} or its services?`;
export const SAFETY_IDENTIFIER = CLIENT_ID || 'ark-receptionist';
export const TRANSCRIPTION_PROMPT = `Natural phone calls for ${BUSINESS.name}: names, service requests, cities or towns, states, street numbers, street names, dates, times, and additional notes.`;
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
  const raw = cleanText(value).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const match = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3] || '';

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
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
  const match = cleanText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseUsDate(value) {
  const match = cleanText(value).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return '';
  return validIsoDate(`${match[3]}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`);
}

function datePartsInBusinessTimeZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function weekdayAllowedForDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  const weekday = Object.keys(WEEKDAY_INDEX).find((name) => WEEKDAY_INDEX[name] === date.getUTCDay());
  return Boolean(weekday && WEEKDAYS.includes(weekday));
}

export function resolvePreferredDate(preferredDateOrDay, now = new Date()) {
  const raw = cleanText(preferredDateOrDay);
  const exactDate = validIsoDate(raw) || parseUsDate(raw);
  if (exactDate) return weekdayAllowedForDate(exactDate) ? exactDate : '';

  const normalized = raw.toLowerCase();
  const targetDay = WEEKDAY_INDEX[normalized];
  if (!Number.isInteger(targetDay) || !WEEKDAYS.includes(normalized)) return '';

  const parts = datePartsInBusinessTimeZone(now);
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysAhead = (targetDay - base.getUTCDay() + 7) % 7;
  base.setUTCDate(base.getUTCDate() + daysAhead);

  const year = base.getUTCFullYear();
  const month = String(base.getUTCMonth() + 1).padStart(2, '0');
  const day = String(base.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function validateLead(args = {}) {
  const serviceType = cleanText(args.serviceType).toLowerCase();
  const preferredDateOrDay = cleanText(args.preferredDateOrDay || args.preferredDay);
  const preferredDate = resolvePreferredDate(preferredDateOrDay);
  const preferredTime = normalizePreferredTime(args.preferredTime);
  const lead = {
    fullName: cleanText(args.fullName),
    serviceType,
    cityOrTown: cleanText(args.cityOrTown || args.townOrCity),
    state: cleanText(args.state),
    streetNumber: cleanText(args.streetNumber),
    streetName: cleanText(args.streetName),
    preferredDateOrDay,
    preferredDate,
    preferredTime,
    additionalNotes: cleanText(args.additionalNotes),
    contactConsent: args.contactConsent === true,
  };

  const errors = [];
  if (lead.fullName.split(/\s+/).filter(Boolean).length < 2) errors.push('the caller’s full first and last name');
  if (!SERVICE_TYPES.includes(lead.serviceType)) errors.push(serviceList());
  if (!lead.cityOrTown) errors.push('the city or town');
  if (!lead.state) errors.push('the state');
  if (!lead.streetNumber) errors.push('the street number');
  if (!lead.streetName) errors.push('the street name');
  if (!lead.preferredDate) errors.push(`an exact date or upcoming estimate day from ${weekdayList()}`);
  if (!lead.preferredTime) {
    errors.push(`a preferred estimate time between ${BUSINESS.earliestEstimateStart} and ${BUSINESS.latestEstimateStart}`);
  }
  if (!lead.contactConsent) errors.push('clear contact consent');

  return { valid: errors.length === 0, errors, lead };
}

export function buildOcmPayload(callerPhone, lead) {
  const nameParts = cleanText(lead.fullName).split(/\s+/).filter(Boolean);
  const firstName = nameParts.shift() || '';
  const lastName = nameParts.join(' ');
  const streetAddress = [cleanText(lead.streetNumber), cleanText(lead.streetName)].filter(Boolean).join(' ');
  const cityOrTown = cleanText(lead.cityOrTown);
  const state = cleanText(lead.state);
  const address = [streetAddress, cityOrTown, state].filter(Boolean).join(', ');
  const requestedDateOrDay = cleanText(lead.preferredDateOrDay);
  const preferredDate = cleanText(lead.preferredDate) || resolvePreferredDate(requestedDateOrDay);
  const requestedTime = cleanText(lead.preferredTime);
  const additionalNotes = cleanText(lead.additionalNotes);
  const source = `${CLIENT_ID}-receptionist`;
  const notes = [
    requestedDateOrDay && `Requested estimate: ${requestedDateOrDay}${requestedTime ? ` at ${requestedTime}` : ''}${preferredDate ? ` (${preferredDate})` : ''}`,
    `Additional notes: ${additionalNotes || 'none'}`,
  ].filter(Boolean).join('\n');

  return {
    clientId: CLIENT_ID,
    sectionKey: 'contactedMe',
    FirstName: firstName,
    LastName: lastName,
    Name: cleanText(lead.fullName),
    Phone: cleanText(callerPhone),
    StreetNumber: cleanText(lead.streetNumber),
    StreetName: cleanText(lead.streetName),
    StreetAddress: streetAddress,
    TownOrCity: cityOrTown,
    State: state,
    Address: address,
    ServiceType: cleanText(lead.serviceType),
    Job: cleanText(lead.serviceType),
    BestContactMethod: 'call',
    PreferredDay: preferredDate || requestedDateOrDay,
    PreferredDate: preferredDate,
    EstimateDate: preferredDate,
    RequestedWeekday: requestedDateOrDay,
    PreferredTime: requestedTime,
    Notes: notes,
    ContactConsent: lead.contactConsent === true,
    ContactConsentMethod: 'voice-call',
    ContactConsentText: contactConsentQuestion,
    ContactConsentAt: new Date().toISOString(),
    source,
    rawSubmission: {
      ...lead,
      callerPhone: cleanText(callerPhone),
      preferredDate,
      businessTimeZone: BUSINESS.timeZone,
    },
  };
}

export const tools = Object.freeze([
  {
    type: 'function',
    name: 'submit_estimate_lead',
    description: `Save the caller-confirmed estimate request to the ${BUSINESS.name} client account only after consent and final summary confirmation.`,
    parameters: {
      type: 'object',
      properties: {
        fullName: { type: 'string' },
        serviceType: { type: 'string', enum: SERVICE_TYPES },
        cityOrTown: { type: 'string' },
        state: { type: 'string' },
        streetNumber: { type: 'string' },
        streetName: { type: 'string' },
        preferredDateOrDay: {
          type: 'string',
          description: `An exact date or an upcoming configured weekday from ${BUSINESS.estimateDays}.`,
        },
        preferredTime: {
          type: 'string',
          description: `Preferred estimate time from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}.`,
        },
        additionalNotes: {
          type: 'string',
          description: 'Optional additional notes. Send an empty string when the caller has none.',
        },
        contactConsent: {
          type: 'boolean',
          description: 'Must be true only after the caller clearly agrees to be contacted by the business.',
        },
      },
      required: [
        'fullName', 'serviceType', 'cityOrTown', 'state', 'streetNumber', 'streetName',
        'preferredDateOrDay', 'preferredTime', 'contactConsent',
      ],
    },
  },
  {
    type: 'function',
    name: 'record_contact_consent',
    description: 'Record one clear yes or no answer to the required contact-consent question. Call once for every clear answer.',
    parameters: {
      type: 'object',
      properties: { agreed: { type: 'boolean' } },
      required: ['agreed'],
    },
  },
  {
    type: 'function',
    name: 'finish_call',
    description: 'End the call only after the estimate request is saved and the caller has no more questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
]);

function currentBusinessDateLabel(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS.timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}

export function instructions() {
  return buildReceptionistPrompt({
    business: BUSINESS,
    ownerFirstName: OWNER_FIRST_NAME,
    currentDateLabel: currentBusinessDateLabel(),
  });
}
