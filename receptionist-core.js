function clean(value) {
  return String(value ?? '').trim();
}

function requireEnv(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredNumber(name, minimum, maximum) {
  const value = Number(requireEnv(name));
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function parseBusinessInfo() {
  let value;
  try {
    value = JSON.parse(requireEnv('BUSINESS_INFO'));
  } catch {
    throw new Error('BUSINESS_INFO must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BUSINESS_INFO must be one JSON object.');
  }
  return value;
}

function requiredText(config, field) {
  const value = clean(config[field]);
  if (!value) throw new Error(`BUSINESS_INFO.${field} is required.`);
  return value;
}

function requiredList(config, field) {
  const value = config[field];
  const items = Array.isArray(value)
    ? value.map(clean).filter(Boolean)
    : typeof value === 'string'
      ? value.split(',').map(clean).filter(Boolean)
      : [];
  if (!items.length) throw new Error(`BUSINESS_INFO.${field} must contain at least one value.`);
  return items;
}

function requiredServices(config) {
  if (!config.services || typeof config.services !== 'object' || Array.isArray(config.services)) {
    throw new Error('BUSINESS_INFO.services must be a JSON object.');
  }
  const entries = Object.entries(config.services)
    .map(([name, description]) => [clean(name).toLowerCase(), clean(description)])
    .filter(([name, description]) => name && description);
  if (!entries.length) throw new Error('BUSINESS_INFO.services must contain at least one service.');
  return Object.fromEntries(entries);
}

function cleanClientId(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const REALTIME_VOICE = requireEnv('AI_VOICE');
export const SPEECH_SPEED = requiredNumber('AI_SPEECH_SPEED', 0.25, 1.5);
export const SILENCE_DURATION_MS = Math.round(requiredNumber('AI_SILENCE_MS', 300, 3000));

const configured = parseBusinessInfo();

export const BUSINESS = Object.freeze({
  name: requiredText(configured, 'name'),
  receptionist: requiredText(configured, 'receptionist'),
  owner: requiredText(configured, 'owner'),
  phone: requiredText(configured, 'phone'),
  email: requiredText(configured, 'email'),
  hours: requiredText(configured, 'hours'),
  timeZone: requiredText(configured, 'timeZone'),
  estimateDays: requiredText(configured, 'estimateDays'),
  estimateWeekdays: requiredList(configured, 'estimateWeekdays').map((day) => day.toLowerCase()),
  earliestEstimateStart: requiredText(configured, 'earliestEstimateStart'),
  latestEstimateStart: requiredText(configured, 'latestEstimateStart'),
  base: requiredText(configured, 'base'),
  serviceAreas: requiredList(configured, 'serviceAreas'),
  services: requiredServices(configured),
  about: Array.isArray(configured.about) ? configured.about.map(clean).filter(Boolean) : [],
  extraInformation: clean(configured.extraInformation),
});

try {
  new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS.timeZone }).format();
} catch {
  throw new Error('BUSINESS_INFO.timeZone must be a valid IANA time zone.');
}

const CLIENT_ID = cleanClientId(requireEnv('OCM_CLIENT_ID'));
if (!CLIENT_ID) throw new Error('OCM_CLIENT_ID must contain letters, numbers, hyphens, or underscores.');

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
const MONTH_INDEX = Object.freeze({
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
});

function serviceList() {
  if (SERVICE_TYPES.length === 1) return SERVICE_TYPES[0];
  return `${SERVICE_TYPES.slice(0, -1).join(', ')}, or ${SERVICE_TYPES.at(-1)}`;
}

function weekdayList() {
  const labels = WEEKDAYS.map((day) => day.charAt(0).toUpperCase() + day.slice(1));
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
}

function clockMinutes(value) {
  const raw = clean(value)
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
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

export function normalizePreferredTime(value = '') {
  const requested = clockMinutes(value);
  const earliest = clockMinutes(BUSINESS.earliestEstimateStart);
  const latest = clockMinutes(BUSINESS.latestEstimateStart);
  if (requested === null || earliest === null || latest === null || earliest > latest) return '';
  if (requested < earliest || requested > latest) return '';
  return displayClock(requested);
}

function businessToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 12));
}

function validDateParts(date, year, month, day) {
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseDate(value, today) {
  const text = clean(value).toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const weekday = text.replace(/^(?:this|next)\s+/, '');
  if (WEEKDAY_INDEX[weekday] !== undefined) {
    const result = new Date(today);
    const delta = (WEEKDAY_INDEX[weekday] - result.getUTCDay() + 7) % 7 || 7;
    result.setUTCDate(result.getUTCDate() + delta);
    return result;
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, year, month, day] = iso.map(Number);
    const result = new Date(Date.UTC(year, month - 1, day, 12));
    return validDateParts(result, year, month, day) ? result : null;
  }

  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (numeric) {
    let year = numeric[3] ? Number(numeric[3]) : today.getUTCFullYear();
    if (year < 100) year += 2000;
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    let result = new Date(Date.UTC(year, month - 1, day, 12));
    if (!numeric[3] && result <= today) {
      year += 1;
      result = new Date(Date.UTC(year, month - 1, day, 12));
    }
    return validDateParts(result, year, month, day) ? result : null;
  }

  const written = text.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
  if (!written) return null;
  const month = MONTH_INDEX[written[1]] + 1;
  const day = Number(written[2]);
  let year = written[3] ? Number(written[3]) : today.getUTCFullYear();
  let result = new Date(Date.UTC(year, month - 1, day, 12));
  if (!written[3] && result <= today) {
    year += 1;
    result = new Date(Date.UTC(year, month - 1, day, 12));
  }
  return validDateParts(result, year, month, day) ? result : null;
}

export function resolvePreferredDate(value = '', now = new Date()) {
  const today = businessToday(now);
  const date = parseDate(value, today);
  if (!date || date <= today) return '';
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' })
    .format(date)
    .toLowerCase();
  if (!WEEKDAYS.includes(weekday)) return '';
  return date.toISOString().slice(0, 10);
}

export function validateLead(rawLead = {}, now = new Date()) {
  const lead = {
    fullName: clean(rawLead.fullName),
    serviceType: clean(rawLead.serviceType).toLowerCase(),
    cityOrTown: clean(rawLead.cityOrTown),
    state: clean(rawLead.state),
    streetNumber: clean(rawLead.streetNumber),
    streetName: clean(rawLead.streetName),
    preferredDateOrDay: clean(rawLead.preferredDateOrDay),
    preferredTime: clean(rawLead.preferredTime),
    additionalNotes: clean(rawLead.additionalNotes) || 'none',
    contactConsent: rawLead.contactConsent === true,
  };

  const preferredDate = resolvePreferredDate(lead.preferredDateOrDay, now);
  const preferredTime = normalizePreferredTime(lead.preferredTime);
  const errors = [];
  if (lead.fullName.split(/\s+/).filter(Boolean).length < 2) errors.push('the caller first and last name');
  if (!SERVICE_TYPES.includes(lead.serviceType)) errors.push(`one configured service: ${serviceList()}`);
  if (!lead.cityOrTown) errors.push('the project city or town');
  if (!lead.state) errors.push('the project state');
  if (!lead.streetNumber) errors.push('the project street number');
  if (!lead.streetName) errors.push('the project street name');
  if (!preferredDate) errors.push(`an upcoming configured estimate date or weekday: ${weekdayList()}`);
  if (!preferredTime) errors.push(`an estimate time from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}`);
  if (!lead.contactConsent) errors.push('clear consent to be contacted');

  return {
    valid: errors.length === 0,
    errors,
    lead: { ...lead, preferredDate, preferredTime },
  };
}

export function buildOcmPayload(callerPhone, lead) {
  const [FirstName, ...lastParts] = clean(lead.fullName).split(/\s+/);
  const LastName = lastParts.join(' ');
  const streetAddress = `${clean(lead.streetNumber)} ${clean(lead.streetName)}`.trim();
  return {
    clientId: CLIENT_ID,
    FirstName,
    LastName,
    Name: clean(lead.fullName),
    Phone: clean(callerPhone),
    Job: clean(lead.serviceType),
    ServiceType: clean(lead.serviceType),
    StreetAddress: streetAddress,
    TownOrCity: clean(lead.cityOrTown),
    State: clean(lead.state),
    Address: `${streetAddress}, ${clean(lead.cityOrTown)}, ${clean(lead.state)}`,
    PreferredDate: clean(lead.preferredDate),
    EstimateDate: clean(lead.preferredDate),
    PreferredDay: clean(lead.preferredDateOrDay),
    PreferredTime: clean(lead.preferredTime),
    Notes: clean(lead.additionalNotes) || 'none',
    source: `${CLIENT_ID}-receptionist`,
  };
}
