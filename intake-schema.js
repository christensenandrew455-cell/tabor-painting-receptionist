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

const SPOKEN_HOURS = Object.freeze({
  one: 1,
  two: 2,
  too: 2,
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

const STATE_CODES = Object.freeze({
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
});

const STATE_CODE_SET = new Set(Object.values(STATE_CODES));
const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);

export function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function validateClientId(value) {
  const clientId = clean(value);
  if (!clientId) throw new Error('OCM client ID is required.');
  if (clientId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(clientId)) {
    throw new Error('OCM client ID has an invalid format.');
  }
  return clientId;
}

export function normalizePhone(value) {
  const raw = clean(value).replace(/^tel:/i, '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

export function normalizeName(value) {
  return clean(value)
    .replace(/^(?:(?:um+|uh+|erm|hmm+|well|so|like|yeah|yes|okay|ok)\b[,.;:\s-]*)+/i, '')
    .replace(/^(?:my full name is|my name is|i am|i'm)\s+/i, '')
    .replace(/[!?;,]+$/g, '')
    .trim();
}

export function isValidFullName(value) {
  const name = normalizeName(value);
  if (!name || name.length > 100 || /[?]/.test(name)) return false;
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 7) return false;
  const nameToken = /^\p{L}[\p{L}\p{M}'’.-]*$/u;
  const meaningful = tokens.filter((token) => !NAME_SUFFIXES.has(token.toLowerCase()));
  return meaningful.length >= 2 && tokens.every((token) => nameToken.test(token));
}

function normalizedServiceText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/^(?:i\s+(?:need|want|would like)|we\s+(?:need|want)|looking for|it is|it's)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchConfiguredService(value, services = {}) {
  const requested = normalizedServiceText(value);
  if (!requested) return '';

  const configured = Object.keys(services || {});
  const exact = configured.find((service) => normalizedServiceText(service) === requested);
  if (exact) return exact;

  const contained = configured.filter((service) => {
    const candidate = normalizedServiceText(service);
    return candidate && new RegExp(`(?:^|\\b)${candidate.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}(?:\\b|$)`, 'i').test(requested);
  });
  return contained.length === 1 ? contained[0] : '';
}

function localDateParts(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const values = Object.fromEntries(
    formatter.formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: values.year, month: values.month, day: values.day };
}

function dateFromParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

function parseCalendarDate(text, today) {
  if (text === 'today') return new Date(today);
  if (text === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return tomorrow;
  }

  const weekdayMatch = text.match(/^(?:(this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (weekdayMatch) {
    const target = WEEKDAY_INDEX[weekdayMatch[2]];
    let daysAhead = (target - today.getUTCDay() + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    if (weekdayMatch[1] === 'next' && daysAhead < 7) daysAhead += 7;
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + daysAhead);
    return date;
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return dateFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (numeric) {
    let year = numeric[3] ? Number(numeric[3]) : today.getUTCFullYear();
    if (year < 100) year += 2000;
    let date = dateFromParts(year, Number(numeric[1]), Number(numeric[2]));
    if (!numeric[3] && date && date <= today) {
      year += 1;
      date = dateFromParts(year, Number(numeric[1]), Number(numeric[2]));
    }
    return date;
  }

  const written = text.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{2}|\d{4}))?$/);
  if (!written) return null;
  let year = written[3] ? Number(written[3]) : today.getUTCFullYear();
  if (year < 100) year += 2000;
  const month = MONTH_INDEX[written[1]] + 1;
  let date = dateFromParts(year, month, Number(written[2]));
  if (!written[3] && date && date <= today) {
    year += 1;
    date = dateFromParts(year, month, Number(written[2]));
  }
  return date;
}

export function resolveEstimateDate(value, {
  now = new Date(),
  timeZone = 'America/New_York',
  allowedWeekdays = [],
} = {}) {
  const text = clean(value).toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!text) return '';

  let todayParts;
  try {
    todayParts = localDateParts(now, timeZone);
  } catch {
    return '';
  }
  const today = dateFromParts(todayParts.year, todayParts.month, todayParts.day);
  const date = parseCalendarDate(text, today);
  if (!date || date <= today) return '';

  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' })
    .format(date)
    .toLowerCase();
  const allowed = (allowedWeekdays || []).map((day) => clean(day).toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(weekday)) return '';
  return date.toISOString().slice(0, 10);
}

function clockLiteralMinutes(value) {
  let raw = clean(value)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bo\s*'?clock\b/g, '')
    .replace(/\./g, '')
    .replace(/^at\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const spoken = raw.match(/^(one|two|too|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(am|pm))?$/);
  if (spoken) raw = `${SPOKEN_HOURS[spoken[1]]}${spoken[2] ? ` ${spoken[2]}` : ''}`;

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
  return { minutes: hour * 60 + minute, ambiguous: !meridiem && hour >= 1 && hour <= 12 };
}

function displayClock(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

export function normalizeEstimateTime(value, { earliest, latest } = {}) {
  const requested = clockLiteralMinutes(value);
  const minimum = clockLiteralMinutes(earliest);
  const maximum = clockLiteralMinutes(latest);
  if (!requested || !minimum || !maximum || minimum.minutes > maximum.minutes) return '';

  const candidates = [requested.minutes];
  if (requested.ambiguous) {
    const hour = Math.floor(requested.minutes / 60);
    if (hour < 12) candidates.push(requested.minutes + 12 * 60);
  }
  const valid = [...new Set(candidates)]
    .filter((minutes) => minutes >= minimum.minutes && minutes <= maximum.minutes);
  if (valid.length !== 1) return '';
  return displayClock(valid[0]);
}

function normalizeState(value) {
  const raw = clean(value).replace(/\./g, '');
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (STATE_CODE_SET.has(upper)) return upper;
  return STATE_CODES[raw.toLowerCase()] || '';
}

export function parseProjectAddress(value) {
  const input = clean(value).replace(/[.!?]+$/g, '');
  const invalid = (missing) => ({
    valid: false,
    missing,
    input,
    streetNumber: '',
    streetName: '',
    unit: '',
    cityOrTown: '',
    state: '',
    postalCode: '',
    formatted: input,
  });
  if (!input || input.length > 240) return invalid(['street address', 'city or town', 'state']);

  const segments = input.split(',').map(clean).filter(Boolean);
  if (segments.length < 3) return invalid(['comma-separated street address, city or town, and state']);

  const street = segments.shift();
  let unit = '';
  if (segments.length >= 3 && /^(?:apt|apartment|unit|suite|ste|#)\b/i.test(segments[0])) {
    unit = segments.shift();
  }
  const cityOrTown = segments.shift() || '';
  const stateAndPostal = segments.join(' ');
  const stateMatch = stateAndPostal.match(/^(.+?)(?:\s+(\d{5}(?:-\d{4})?))?$/);
  const state = normalizeState(stateMatch?.[1] || '');
  const postalCode = clean(stateMatch?.[2]);
  const streetMatch = street.match(/^(\d+[A-Za-z-]*)\s+(.{2,})$/);
  const streetNumber = clean(streetMatch?.[1]);
  const streetName = clean(streetMatch?.[2]);

  const missing = [];
  if (!streetNumber) missing.push('street number');
  if (!streetName) missing.push('street name');
  if (cityOrTown.length < 2) missing.push('city or town');
  if (!state) missing.push('valid state');

  const streetLine = clean(`${streetNumber} ${streetName}`);
  const formatted = [streetLine, unit, cityOrTown, clean(`${state}${postalCode ? ` ${postalCode}` : ''}`)]
    .filter(Boolean)
    .join(', ');

  return {
    valid: missing.length === 0,
    missing,
    input,
    streetNumber,
    streetName,
    unit,
    cityOrTown,
    state,
    postalCode,
    formatted,
  };
}

export function validateIntakeLead(rawLead = {}, {
  business,
  callerPhone,
  now = new Date(),
} = {}) {
  const fullName = normalizeName(rawLead.fullName);
  const serviceType = matchConfiguredService(rawLead.serviceType, business?.services);
  const addressInput = clean(rawLead.projectLocation)
    || [rawLead.streetAddress, rawLead.cityOrTown, rawLead.state].map(clean).filter(Boolean).join(', ');
  const address = parseProjectAddress(addressInput);
  const preferredDate = resolveEstimateDate(rawLead.preferredDateOrDay || rawLead.preferredDate, {
    now,
    timeZone: business?.timeZone,
    allowedWeekdays: business?.estimateWeekdays,
  });
  const preferredTime = normalizeEstimateTime(rawLead.preferredTime, {
    earliest: business?.earliestEstimateStart,
    latest: business?.latestEstimateStart,
  });
  const phone = normalizePhone(rawLead.callbackPhone || callerPhone);
  const notes = clean(rawLead.additionalNotes || rawLead.notes) || 'none';
  const contactConsent = rawLead.contactConsent === true;

  const errors = [];
  if (!isValidFullName(fullName)) errors.push('the caller first and last name');
  if (!serviceType) errors.push('one configured service');
  if (!address.valid) errors.push(`a complete project address: ${address.missing.join(', ')}`);
  if (!preferredDate) errors.push('an upcoming configured estimate date');
  if (!preferredTime) {
    errors.push(`an estimate time from ${business?.earliestEstimateStart} through ${business?.latestEstimateStart}`);
  }
  if (!phone) errors.push('a valid callback phone number');
  if (!contactConsent) errors.push('clear consent to be contacted');
  if (notes.length > 500) errors.push('additional notes no longer than 500 characters');

  return {
    valid: errors.length === 0,
    errors,
    lead: {
      fullName,
      serviceType,
      callbackPhone: phone,
      projectLocation: address.formatted,
      streetNumber: address.streetNumber,
      streetName: address.streetName,
      unit: address.unit,
      cityOrTown: address.cityOrTown,
      state: address.state,
      postalCode: address.postalCode,
      preferredDateOrDay: clean(rawLead.preferredDateOrDay || rawLead.preferredDate),
      preferredDate,
      preferredTime,
      additionalNotes: notes,
      contactConsent,
    },
  };
}
