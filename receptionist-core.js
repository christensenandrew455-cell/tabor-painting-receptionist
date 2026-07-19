export const AUDIO_FORMAT = Object.freeze({ type: 'audio/pcmu' });
export const REALTIME_MODEL = cleanText(process.env.AI_MODEL) || 'gpt-realtime-mini';
export const REALTIME_VOICE = cleanText(process.env.AI_VOICE) || 'alloy';
export const SPEECH_SPEED = clampNumber(process.env.AI_SPEECH_SPEED, 0.94, 0.25, 1.5);
export const SILENCE_DURATION_MS = Math.round(clampNumber(process.env.AI_SILENCE_MS, 1200, 300, 3000));

const DEFAULT_BUSINESS = Object.freeze({
  name: 'Tabor Painting',
  receptionist: 'Alex',
  owner: 'Jason Beirne',
  phone: '(774) 245-3383',
  email: 'Taborpainting508@gmail.com',
  hours: 'Monday through Friday, 8 AM to 5 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:30 PM',
  base: 'Berlin, Massachusetts',
  serviceAreas: [
    'Berlin', 'Bolton', 'Hudson', 'Clinton', 'Marlborough', 'Northborough',
    'Boylston', 'West Boylston', 'Sterling', 'Lancaster', 'Worcester',
  ],
  services: {
    'interior painting': 'Walls, rooms, ceilings, trim, doors, touch-ups, repainting, and other indoor painting.',
    'exterior painting': 'Exterior surfaces and trim, with careful surface preparation and clean coverage.',
    'small paint repair': 'Small touch-ups, minor paint damage, and small paint or patch repairs.',
    'wood staining': 'Staining wood surfaces such as decks, fences, trim, and other wood features.',
  },
  about: [
    'Tabor Painting is a residential painting company based in Berlin, Massachusetts.',
    'Jason Beirne founded the company after gaining hands-on experience with Student Painters.',
    'The company focuses on careful preparation, clean work areas, clear communication, attention to detail, smooth finishes, and professional long-lasting results.',
  ],
  openingLine: '',
  closingLine: '',
  extraInformation: '',
});

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function cleanText(value = '') {
  return String(value ?? '').trim();
}

function parseBusinessInfo(value) {
  const raw = cleanText(value);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Backward compatibility: plain text is treated as additional business knowledge.
  }

  return { extraInformation: raw };
}

function firstConfigured(config, keys, fallback = '') {
  for (const key of keys) {
    const value = config?.[key];
    if (value !== undefined && value !== null && cleanText(value)) return value;
  }
  return fallback;
}

function textList(value, fallback = []) {
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => cleanText(item)).filter(Boolean);
    if (cleaned.length) return cleaned;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [...fallback];
}

function serviceMap(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
      .map(([name, description]) => [cleanText(name).toLowerCase(), cleanText(description)])
      .filter(([name]) => Boolean(name));
    if (entries.length) return Object.fromEntries(entries);
  }

  if (Array.isArray(value)) {
    const entries = value
      .map((name) => cleanText(name).toLowerCase())
      .filter(Boolean)
      .map((name) => [name, `${name}.`]);
    if (entries.length) return Object.fromEntries(entries);
  }

  return { ...fallback };
}

const configuredBusiness = parseBusinessInfo(process.env.BUSINESS_INFO);

export const BUSINESS = Object.freeze({
  name: cleanText(firstConfigured(configuredBusiness, ['name', 'businessName'], DEFAULT_BUSINESS.name)),
  receptionist: cleanText(firstConfigured(configuredBusiness, ['receptionist', 'receptionistName'], DEFAULT_BUSINESS.receptionist)),
  owner: cleanText(firstConfigured(configuredBusiness, ['owner', 'ownerName'], DEFAULT_BUSINESS.owner)),
  phone: cleanText(firstConfigured(configuredBusiness, ['phone', 'businessPhone'], DEFAULT_BUSINESS.phone)),
  email: cleanText(firstConfigured(configuredBusiness, ['email', 'businessEmail'], DEFAULT_BUSINESS.email)),
  hours: cleanText(firstConfigured(configuredBusiness, ['hours', 'businessHours'], DEFAULT_BUSINESS.hours)),
  timeZone: cleanText(firstConfigured(configuredBusiness, ['timeZone', 'timezone'], DEFAULT_BUSINESS.timeZone)),
  estimateDays: cleanText(firstConfigured(configuredBusiness, ['estimateDays', 'estimateDaysText'], DEFAULT_BUSINESS.estimateDays)),
  estimateWeekdays: textList(
    firstConfigured(configuredBusiness, ['estimateWeekdays', 'bookingWeekdays'], DEFAULT_BUSINESS.estimateWeekdays),
    DEFAULT_BUSINESS.estimateWeekdays,
  ).map((day) => day.toLowerCase()),
  earliestEstimateStart: cleanText(firstConfigured(
    configuredBusiness,
    ['earliestEstimateStart', 'earliestEstimateTime'],
    DEFAULT_BUSINESS.earliestEstimateStart,
  )),
  latestEstimateStart: cleanText(firstConfigured(
    configuredBusiness,
    ['latestEstimateStart', 'latestEstimateTime'],
    DEFAULT_BUSINESS.latestEstimateStart,
  )),
  base: cleanText(firstConfigured(configuredBusiness, ['base', 'location', 'businessBase'], DEFAULT_BUSINESS.base)),
  serviceAreas: textList(
    firstConfigured(configuredBusiness, ['serviceAreas', 'areasServed'], DEFAULT_BUSINESS.serviceAreas),
    DEFAULT_BUSINESS.serviceAreas,
  ),
  services: serviceMap(configuredBusiness.services, DEFAULT_BUSINESS.services),
  about: textList(configuredBusiness.about, DEFAULT_BUSINESS.about),
  openingLine: cleanText(configuredBusiness.openingLine),
  closingLine: cleanText(configuredBusiness.closingLine),
  extraInformation: cleanText(firstConfigured(
    configuredBusiness,
    ['extraInformation', 'additionalInformation', 'businessInformation'],
    DEFAULT_BUSINESS.extraInformation,
  )),
});

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
  if (SERVICE_TYPES.length <= 1) return SERVICE_TYPES[0] || 'the available services';
  return `${SERVICE_TYPES.slice(0, -1).join(', ')}, or ${SERVICE_TYPES.at(-1)}`;
}

function weekdayList() {
  const labels = WEEKDAYS.map((day) => day.charAt(0).toUpperCase() + day.slice(1));
  if (labels.length <= 1) return labels[0] || BUSINESS.estimateDays;
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

const DEFAULT_OPENING_LINE = 'Hi, this is {{receptionist_name}} with {{business_name}}. Can I set you up with an estimate today?';
const DEFAULT_CLOSING_LINE = '{{owner_first_name}} will follow up with you shortly. Thanks for calling {{business_name}}. Goodbye.';

export const openingLine = renderTemplate(BUSINESS.openingLine || DEFAULT_OPENING_LINE);
export const closingLine = renderTemplate(BUSINESS.closingLine || DEFAULT_CLOSING_LINE);
export const afterSaveQuestion = `Do you have any questions about ${BUSINESS.name}?`;
export const saveFailureLine = `I could not save that just now, but ${OWNER_FIRST_NAME} can still follow up.`;
export const SAFETY_IDENTIFIER = cleanText(process.env.OCM_CLIENT_ID)
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '') || 'ark-receptionist';
export const TRANSCRIPTION_PROMPT = `Natural phone calls for ${BUSINESS.name}: names, email addresses, service requests, towns or cities, street addresses, dates, and times.`;

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

  const earliest = clockMinutes(BUSINESS.earliestEstimateStart) ?? 9 * 60;
  const latest = clockMinutes(BUSINESS.latestEstimateStart) ?? 16 * 60 + 30;
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
  const clientId = cleanText(process.env.OCM_CLIENT_ID) || 'tabor-painting';
  const source = `${clientId}-receptionist`;
  const requestedWeekday = cleanText(lead.preferredDay);
  const preferredDate = resolvePreferredDate(requestedWeekday);
  const requestedTime = cleanText(lead.preferredTime);
  const contactMethod = cleanText(lead.contactMethod).toLowerCase();
  const additionalNotes = cleanText(lead.additionalNotes);
  const notes = [
    contactMethod && `Best contact method: ${contactMethod}`,
    requestedWeekday && `Requested estimate: ${requestedWeekday}${requestedTime ? ` at ${requestedTime}` : ''}${preferredDate ? ` (${preferredDate})` : ''}`,
    `Additional notes: ${additionalNotes || 'none'}`,
  ].filter(Boolean).join('\n');

  return {
    clientId,
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
- About: ${BUSINESS.about.join(' ')}
${BUSINESS.extraInformation ? `- Additional information: ${BUSINESS.extraInformation}\n` : ''}- Never quote a price, promise exact availability, or invent an answer. Say ${OWNER_FIRST_NAME} can confirm anything not listed here.`;
}

const DEFAULT_SCRIPT = `OPENING
The server separately says exactly: "{{opening_line}}"
Wait for the caller’s answer.
- If yes, begin the estimate intake.
- If no, say: "No problem. What can I help you with?" Answer only from the business information. If they later want an estimate, begin the intake.

ESTIMATE INTAKE — USE THIS ORDER
Collect any missing fields in this exact order:
1. Ask: "Can I please have your first and last name?"
2. Ask exactly: "Would you like to add your email? Yes or no."
   - If the caller says no, say: "Okay." Save email as an empty string and move directly to question 3.
   - If the caller says yes, ask: "What would your email be?" Then wait for the complete email address.
   - If the caller declined email but later chooses email as the best contact method, ask for the email address then.
3. Ask: "What service would you like? We specialize in {{services}}."
4. Ask: "What town or city is the project located in?"
5. Ask: "What is the street address of the project?"
6. Ask for the best contact method based on the information actually available.
   - If no email was provided, ask exactly: "What is the best way we can contact you: call or text?" Do not offer email.
   - If an email was provided, ask exactly: "What is the best way we can contact you: call, text, or email?"
7. Ask: "What day would work best for the estimate? We schedule estimates {{estimate_days}}."
8. After the caller gives a valid day, ask: "What time would work best? We accept estimate times from {{earliest_estimate_time}} to {{latest_estimate_time}}."
9. Ask: "Is there anything else you would like {{owner_first_name}} to know?"

DAY AND TIME RULES
- Accept only the configured estimate weekdays.
- If the caller gives a day outside that schedule, explain the available estimate days and ask for another day.
- Accept times only from {{earliest_estimate_time}} through {{latest_estimate_time}}, inclusive.
- Normalize the time clearly, such as 9:00 AM, 1:30 PM, or 4:30 PM.
- Never say the estimate is booked. Say {{owner_first_name}} will confirm the requested day and time.

SERVICE CLASSIFICATION
- Collect one configured service category.
- Do not ask about project size, scope, number of rooms, surfaces, measurements, condition, colors, or other job details.
- When you infer the category, confirm it naturally before continuing.
- If the description could fit more than one category, ask one short clarifying question.
- Retain volunteered project details as additional notes.

CONFIRMATION
- After the intake is complete, summarize once: full name, email only when provided, service category, town or city, street address, best contact method, preferred estimate day, preferred estimate time, and anything {{owner_first_name}} should know.
- Never say or repeat the caller-ID phone number.
- Ask: "Is all of that correct?" Then stop and listen.
- Correct only what the caller changes, then summarize the corrected details and confirm again.`;

const customScript = cleanText(process.env.RECEPTIONIST_SCRIPT);
export const receptionistScript = renderTemplate((customScript || DEFAULT_SCRIPT)
  .replaceAll('{{opening_line}}', openingLine)
  .replaceAll('{{closing_line}}', closingLine));

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
