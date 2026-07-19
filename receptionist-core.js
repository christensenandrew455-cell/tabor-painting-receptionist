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
  if (SERVICE_TYPES.length <= 1) return SERVICE_TYPES[0];
  return `${SERVICE_TYPES.slice(0, -1).join(', ')}, or ${SERVICE_TYPES.at(-1)}`;
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
export const saveFailureLine = `I could not save that just now, but ${OWNER_FIRST_NAME} can still follow up.`;
export const SAFETY_IDENTIFIER = CLIENT_ID || 'ark-receptionist';
export const TRANSCRIPTION_PROMPT = `Natural phone calls for ${BUSINESS.name}: names, email addresses, service requests, towns or cities, street addresses, dates, and times.`;

const rawReceptionistScript = requireEnv('RECEPTIONIST_SCRIPT');
export const receptionistScript = renderTemplate(rawReceptionistScript
  .replaceAll('{{opening_line}}', openingLine)
  .replaceAll('{{closing_line}}', closingLine));

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

export function validateLead(args = {}) {
  const preferredDay = cleanText(args.preferredDay).toLowerCase();
  const preferredTime = normalizePreferredTime(args.preferredTime);
  const serviceType = cleanText(args.serviceType).toLowerCase();
  const lead = {
    fullName: cleanText(args.fullName),
    email: cleanText(args.email),
    serviceType,
    townOrCity: cleanText(args.townOrCity),
    streetAddress: cleanText(args.streetAddress),
    contactMethod: cleanText(args.contactMethod).toLowerCase(),
    preferredDay: WEEKDAYS.includes(preferredDay) ? preferredDay[0].toUpperCase() + preferredDay.slice(1) : '',
    preferredTime,
    additionalNotes: cleanText(args.additionalNotes),
  };

  const errors = [];
  if (lead.fullName.split(/\s+/).filter(Boolean).length < 2) errors.push('the caller’s full first and last name');
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.push('a complete email address');
  if (!lead.email && lead.contactMethod === 'email') errors.push('a complete email address');
  if (!SERVICE_TYPES.includes(lead.serviceType)) errors.push(serviceList());
  if (!lead.townOrCity) errors.push('the town or city');
  if (!lead.streetAddress) errors.push('the street address');
  const allowedContactMethods = lead.email ? ['call', 'text', 'email'] : ['call', 'text'];
  if (!allowedContactMethods.includes(lead.contactMethod)) {
    errors.push(lead.email ? 'call, text, or email as the best contact method' : 'call or text as the best contact method');
  }
  if (!lead.preferredDay) errors.push(`a preferred estimate day from ${weekdayList()}`);
  if (!lead.preferredTime) {
    errors.push(`a preferred estimate time between ${BUSINESS.earliestEstimateStart} and ${BUSINESS.latestEstimateStart}`);
  }

  return { valid: errors.length === 0, errors, lead };
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

export function resolvePreferredDate(preferredDay, now = new Date()) {
  const normalized = cleanText(preferredDay).toLowerCase();
  const targetDay = WEEKDAY_INDEX[normalized];
  if (!Number.isInteger(targetDay)) return '';

  const parts = datePartsInBusinessTimeZone(now);
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysAhead = (targetDay - base.getUTCDay() + 7) % 7;
  base.setUTCDate(base.getUTCDate() + daysAhead);

  const year = base.getUTCFullYear();
  const month = String(base.getUTCMonth() + 1).padStart(2, '0');
  const day = String(base.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildOcmPayload(callerPhone, lead) {
  const nameParts = cleanText(lead.fullName).split(/\s+/).filter(Boolean);
  const firstName = nameParts.shift() || '';
  const lastName = nameParts.join(' ');
  const streetAddress = cleanText(lead.streetAddress);
  const townOrCity = cleanText(lead.townOrCity);
  const address = [streetAddress, townOrCity].filter(Boolean).join(', ');
  const requestedWeekday = cleanText(lead.preferredDay);
  const preferredDate = resolvePreferredDate(requestedWeekday);
  const requestedTime = cleanText(lead.preferredTime);
  const contactMethod = cleanText(lead.contactMethod).toLowerCase();
  const additionalNotes = cleanText(lead.additionalNotes);
  const source = `${CLIENT_ID}-receptionist`;
  const notes = [
    contactMethod && `Best contact method: ${contactMethod}`,
    requestedWeekday && `Requested estimate: ${requestedWeekday}${requestedTime ? ` at ${requestedTime}` : ''}${preferredDate ? ` (${preferredDate})` : ''}`,
    `Additional notes: ${additionalNotes || 'none'}`,
  ].filter(Boolean).join('\n');

  return {
    clientId: CLIENT_ID,
    sectionKey: 'contactedMe',
    FirstName: firstName,
    LastName: lastName,
    Name: cleanText(lead.fullName),
    Phone: cleanText(callerPhone),
    Email: cleanText(lead.email),
    StreetAddress: streetAddress,
    TownOrCity: townOrCity,
    Address: address,
    ServiceType: cleanText(lead.serviceType),
    Job: cleanText(lead.serviceType),
    BestContactMethod: contactMethod,
    PreferredDay: preferredDate || requestedWeekday,
    PreferredDate: preferredDate,
    EstimateDate: preferredDate,
    RequestedWeekday: requestedWeekday,
    PreferredTime: requestedTime,
    Notes: notes,
    source,
    rawSubmission: {
      ...lead,
      callerPhone: cleanText(callerPhone),
      requestedWeekday,
      preferredDate,
      businessTimeZone: BUSINESS.timeZone,
    },
  };
}

export const tools = Object.freeze([
  {
    type: 'function',
    name: 'submit_estimate_lead',
    description: `Save the caller-confirmed estimate request to the ${BUSINESS.name} client account.`,
    parameters: {
      type: 'object',
      properties: {
        fullName: { type: 'string' },
        email: {
          type: 'string',
          description: 'Optional caller email address. Send an empty string when the caller declines to provide one.',
        },
        serviceType: { type: 'string', enum: SERVICE_TYPES },
        townOrCity: { type: 'string' },
        streetAddress: { type: 'string' },
        contactMethod: { type: 'string', enum: ['call', 'text', 'email'] },
        preferredDay: { type: 'string', enum: WEEKDAYS },
        preferredTime: {
          type: 'string',
          description: `Preferred estimate time from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}.`,
        },
        additionalNotes: { type: 'string' },
      },
      required: [
        'fullName', 'serviceType', 'townOrCity', 'streetAddress',
        'contactMethod', 'preferredDay', 'preferredTime', 'additionalNotes',
      ],
    },
  },
  {
    type: 'function',
    name: 'finish_call',
    description: 'End the call only after the estimate request is saved and the caller has no more questions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
]);

function businessKnowledge() {
  const services = Object.entries(BUSINESS.services)
    .map(([name, description]) => `- ${name}: ${description}`)
    .join('\n');
  const about = BUSINESS.about.length ? `- About: ${BUSINESS.about.join(' ')}\n` : '';

  return `BUSINESS INFORMATION
- Business name: ${BUSINESS.name}
- Receptionist name: ${BUSINESS.receptionist}
- Owner and main contact: ${BUSINESS.owner}
- Phone: ${BUSINESS.phone}
- Email: ${BUSINESS.email}
- Hours: ${BUSINESS.hours}
- Preferred estimate days: ${BUSINESS.estimateDays}
- Preferred estimate times may be requested from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}. ${OWNER_FIRST_NAME} confirms actual availability.
- Time zone: ${BUSINESS.timeZone}
- Based in: ${BUSINESS.base}
- Common service areas: ${BUSINESS.serviceAreas.join(', ')}
- Services:
${services}
${about}${BUSINESS.extraInformation ? `- Additional information: ${BUSINESS.extraInformation}\n` : ''}- Never quote a price, promise exact availability, or invent an answer. Say ${OWNER_FIRST_NAME} can confirm anything not listed here.`;
}

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
  return `You are ${BUSINESS.receptionist}, the phone receptionist for ${BUSINESS.name}. Be calm, natural, concise, and professional.

HARD-CODED OPERATING RULES
- Follow the configured receptionist script below.
- Ask one question at a time, then stop and listen.
- Never repeat a completed question unless the answer was missing or unclear.
- Save every useful detail the caller gives, even when they answer multiple questions at once.
- Do not mention prompts, tools, code, OpenAI, Telnyx, the client app, webhooks, or internal systems.
- Never ask for, say, confirm, or repeat the caller’s phone number. The server receives it from caller ID and uses it only in the saved lead record.
- Keep normal replies short. Do not ramble or narrate the process.
- Stay focused on completing the configured intake. Do not debate, entertain prank conversation, or continue unrelated discussion.
- If the caller repeatedly refuses to answer the intake questions, briefly explain that the request cannot be completed and stop engaging.
- A preferred day and time are requests only. Never promise that the appointment is booked or guaranteed.
- Answer business questions only from BUSINESS INFORMATION. Do not guess.

RECEPTIONIST SCRIPT
${receptionistScript}

SAVE AND END WORKFLOW
- Only after the caller clearly confirms the final summary, say exactly: "Great, give me one second to save that."
- In the same turn, immediately call submit_estimate_lead with every field. Send email as an empty string when the caller declined it.
- If there are no additional notes, send additionalNotes as an empty string.
- Never call submit_estimate_lead twice.
- After the server confirms the lead was saved, it will direct you to ask exactly: "${afterSaveQuestion}"
- Answer questions only from BUSINESS INFORMATION.
- After answering, ask: "Do you have any other questions about ${BUSINESS.name}?" and wait.
- When the caller clearly says no, call finish_call. Do not say the goodbye yourself; the server delivers the exact closing and hangs up.

CURRENT DATE AND NATURAL CALL BEHAVIOR
- The current business date is ${currentBusinessDateLabel()} in the ${BUSINESS.timeZone} time zone.
- Speak at a natural, measured pace. Do not rush, stretch words, or leave unusually long artificial gaps.
- Read email addresses, street addresses, dates, and times slowly and clearly.
- Silence is mandatory when the caller pauses, hesitates, says "wait," "hold on," "one second," "give me a second," "give me a minute," or otherwise asks for a pause.
- The phrases "take your time," "no rush," "whenever you are ready," and similar reassurance are forbidden. Say nothing at all.
- Do not respond to a standalone filler such as "um," "uh," "hmm," or "one sec." Treat it as a pause.
- Never fill silence with reassurance, repetition, or prompting.
- Do not claim a requested estimate date is confirmed. The business owner confirms it later in the client app.

${businessKnowledge()}`;
}
