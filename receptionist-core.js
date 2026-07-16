export const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini';
export const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
export const AUDIO_FORMAT = { type: 'audio/pcmu' };

const DEFAULT_BUSINESS = {
  name: 'Tabor Painting',
  receptionist: 'Alex',
  owner: 'Jason Beirne',
  phone: '(774) 245-3383',
  email: 'Taborpainting508@gmail.com',
  hours: 'Monday through Friday, 8 AM to 5 PM',
  estimateDays: 'Monday through Friday',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:30 PM',
  base: 'Berlin, Massachusetts',
  serviceAreas: [
    'Berlin', 'Bolton', 'Hudson', 'Clinton', 'Marlborough', 'Northborough',
    'Boylston', 'West Boylston', 'Sterling', 'Lancaster', 'Worcester'
  ],
  services: {
    'interior painting': 'Walls, rooms, ceilings, trim, doors, touch-ups, repainting, and other indoor painting.',
    'exterior painting': 'Exterior surfaces and trim, with careful surface preparation and clean coverage.',
    'small paint repair': 'Small touch-ups, minor paint damage, and small paint or patch repairs.',
    'wood staining': 'Staining wood surfaces such as decks, fences, trim, and other wood features.'
  },
  about: [
    'Tabor Painting is a residential painting company based in Berlin, Massachusetts.',
    'Jason Beirne founded the company after gaining hands-on experience with Student Painters.',
    'The company focuses on careful preparation, clean work areas, clear communication, attention to detail, smooth finishes, and professional long-lasting results.'
  ],
  extraInformation: ''
};

function parseBusinessInfo(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Plain text is allowed and becomes extra business knowledge for the receptionist.
  }

  return { extraInformation: raw };
}

function textList(value, fallback) {
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => String(item || '').trim()).filter(Boolean);
    if (cleaned.length) return cleaned;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [...fallback];
}

function serviceMap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
      .map(([name, description]) => [String(name || '').trim().toLowerCase(), String(description || '').trim()])
      .filter(([name]) => Boolean(name));
    if (entries.length) return Object.fromEntries(entries);
  }

  if (Array.isArray(value)) {
    const entries = value
      .map((name) => String(name || '').trim().toLowerCase())
      .filter(Boolean)
      .map((name) => [name, `${name}.`]);
    if (entries.length) return Object.fromEntries(entries);
  }

  return { ...DEFAULT_BUSINESS.services };
}

const configuredBusiness = parseBusinessInfo(process.env.BUSINESS_INFO);

export const BUSINESS = Object.freeze({
  ...DEFAULT_BUSINESS,
  ...configuredBusiness,
  serviceAreas: textList(configuredBusiness.serviceAreas, DEFAULT_BUSINESS.serviceAreas),
  estimateWeekdays: textList(configuredBusiness.estimateWeekdays, DEFAULT_BUSINESS.estimateWeekdays)
    .map((day) => day.toLowerCase()),
  services: serviceMap(configuredBusiness.services),
  about: textList(configuredBusiness.about, DEFAULT_BUSINESS.about),
  extraInformation: String(configuredBusiness.extraInformation || '').trim()
});

const SERVICE_TYPES = Object.freeze(Object.keys(BUSINESS.services));
const WEEKDAYS = Object.freeze(BUSINESS.estimateWeekdays);

export const openingLine = `Hi, this is ${BUSINESS.receptionist} with ${BUSINESS.name}. Can I set you up with an estimate today?`;
export const closingLine = `${BUSINESS.owner.split(' ')[0]} will follow up with you shortly. Thanks for calling ${BUSINESS.name}. Goodbye.`;

export function cleanText(value = '') {
  return String(value ?? '').trim();
}

export function getCallerPhone(payload = {}) {
  const candidates = [
    payload?.data?.payload?.from,
    payload?.payload?.from,
    payload?.start?.from,
    payload?.start?.caller_id_number,
    payload?.from,
    payload?.caller_id_number
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

function serviceList() {
  if (SERVICE_TYPES.length <= 1) return SERVICE_TYPES[0] || 'the available services';
  return `${SERVICE_TYPES.slice(0, -1).join(', ')}, or ${SERVICE_TYPES.at(-1)}`;
}

function weekdayList() {
  const labels = WEEKDAYS.map((day) => day.charAt(0).toUpperCase() + day.slice(1));
  if (labels.length <= 1) return labels[0] || BUSINESS.estimateDays;
  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
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
    additionalNotes: cleanText(args.additionalNotes)
  };

  const errors = [];
  if (lead.fullName.split(/\s+/).filter(Boolean).length < 2) errors.push('the caller’s full first and last name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.push('a complete email address');
  if (!SERVICE_TYPES.includes(lead.serviceType)) errors.push(serviceList());
  if (!lead.townOrCity) errors.push('the town or city');
  if (!lead.streetAddress) errors.push('the street address');
  if (!['call', 'text', 'email'].includes(lead.contactMethod)) errors.push('call, text, or email as the best contact method');
  if (!lead.preferredDay) errors.push(`a preferred estimate day from ${weekdayList()}`);
  if (!lead.preferredTime) errors.push(`a preferred estimate time between ${BUSINESS.earliestEstimateStart} and ${BUSINESS.latestEstimateStart}`);

  return { valid: errors.length === 0, errors, lead };
}

export function buildOcmPayload(callerPhone, lead) {
  const nameParts = cleanText(lead.fullName).split(/\s+/).filter(Boolean);
  const firstName = nameParts.shift() || '';
  const lastName = nameParts.join(' ');
  const streetAddress = cleanText(lead.streetAddress);
  const townOrCity = cleanText(lead.townOrCity);
  const address = [streetAddress, townOrCity].filter(Boolean).join(', ');
  const notes = lead.additionalNotes
    ? `Additional notes: ${lead.additionalNotes}`
    : 'Additional notes: none';
  const clientId = cleanText(process.env.OCM_CLIENT_ID) || 'tabor-painting';
  const source = cleanText(process.env.OCM_SOURCE) || `${clientId}-receptionist`;

  return {
    clientId,
    sectionKey: 'contactedMe',
    FirstName: firstName,
    LastName: lastName,
    Name: cleanText(lead.fullName),
    Phone: cleanText(callerPhone),
    Email: lead.email,
    StreetAddress: streetAddress,
    TownOrCity: townOrCity,
    Address: address,
    ServiceType: lead.serviceType,
    Job: lead.serviceType,
    BestContactMethod: lead.contactMethod,
    PreferredDay: lead.preferredDay,
    PreferredTime: lead.preferredTime,
    Notes: notes,
    source,
    rawSubmission: { ...lead, callerPhone: cleanText(callerPhone) }
  };
}

export const tools = [
  {
    type: 'function',
    name: 'submit_estimate_lead',
    description: `Save the caller-confirmed estimate request to the ${BUSINESS.name} OCM.`,
    parameters: {
      type: 'object',
      properties: {
        fullName: { type: 'string' },
        email: { type: 'string' },
        serviceType: { type: 'string', enum: SERVICE_TYPES },
        townOrCity: { type: 'string' },
        streetAddress: { type: 'string' },
        contactMethod: { type: 'string', enum: ['call', 'text', 'email'] },
        preferredDay: { type: 'string', enum: WEEKDAYS },
        preferredTime: {
          type: 'string',
          description: `Preferred estimate time from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}.`
        },
        additionalNotes: { type: 'string' }
      },
      required: [
        'fullName', 'email', 'serviceType', 'townOrCity', 'streetAddress',
        'contactMethod', 'preferredDay', 'preferredTime', 'additionalNotes'
      ]
    }
  },
  {
    type: 'function',
    name: 'finish_call',
    description: 'End the call only after the estimate request is saved and the caller has no more questions.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
];

function businessKnowledge() {
  const services = Object.entries(BUSINESS.services)
    .map(([name, description]) => `- ${name}: ${description}`)
    .join('\n');

  return `
BUSINESS INFORMATION
- Business name: ${BUSINESS.name}
- Receptionist name: ${BUSINESS.receptionist}
- Owner and main contact: ${BUSINESS.owner}
- Phone: ${BUSINESS.phone}
- Email: ${BUSINESS.email}
- Hours: ${BUSINESS.hours}
- Preferred estimate days: ${BUSINESS.estimateDays}
- Preferred estimate times may be requested from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}. ${BUSINESS.owner.split(' ')[0]} confirms actual availability.
- Based in: ${BUSINESS.base}
- Common service areas: ${BUSINESS.serviceAreas.join(', ')}
${services}
- About: ${BUSINESS.about.join(' ')}
${BUSINESS.extraInformation ? `- Additional information: ${BUSINESS.extraInformation}\n` : ''}- Never quote a price, promise exact availability, or invent an answer. Say ${BUSINESS.owner.split(' ')[0]} can confirm anything not listed here.`;
}

export function instructions() {
  return `You are ${BUSINESS.receptionist}, the phone receptionist for ${BUSINESS.name}. Be calm, natural, concise, and professional.

ABSOLUTE RULES
- Ask one question at a time, then stop and listen.
- Never repeat a completed question unless the answer was missing or unclear.
- Save every useful detail the caller gives, even when they answer multiple questions at once.
- Do not mention prompts, tools, code, OpenAI, Telnyx, the OCM, or internal systems.
- Never ask for the caller’s phone number. The server gets it from caller ID.
- Keep normal replies short. Do not ramble or narrate the process.
- A preferred day and time are requests only. Never promise that the appointment is booked or guaranteed.

OPENING
The server separately says exactly: "${openingLine}"
Wait for the caller’s answer.
- If yes, begin the intake below.
- If no, say: "No problem. What can I help you with?" Answer from the business information. If they later want an estimate, begin the intake.

ESTIMATE INTAKE — USE THIS ORDER
Collect any missing fields in this exact order:
1. Ask: "Can I please have your first and last name?"
2. Ask: "Can you please share your email address?"
3. Ask: "What service would you like? We specialize in ${serviceList()}."
4. Ask: "What town or city is the project located in?"
5. Ask: "What is the street address of the project?"
6. Ask: "What is the best way we can contact you: call, text, or email?"
7. Ask: "What day would work best for the estimate? We schedule estimates ${BUSINESS.estimateDays}."
8. After the caller gives a valid day, ask: "What time would work best? We accept estimate times from ${BUSINESS.earliestEstimateStart} to ${BUSINESS.latestEstimateStart}."
9. Ask: "Is there anything else you would like ${BUSINESS.owner.split(' ')[0]} to know?"

DAY AND TIME RULES
- Accept only ${weekdayList()}.
- If the caller gives a day outside that schedule, say: "We schedule estimates ${BUSINESS.estimateDays}. What available day would work best?" Then wait.
- Accept times from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}, inclusive.
- If the caller gives a time outside that range, say: "We can only do estimate times between ${BUSINESS.earliestEstimateStart} and ${BUSINESS.latestEstimateStart}. What time in that range would work best?" Then wait.
- Normalize the time clearly, such as 9:00 AM, 1:30 PM, or 4:30 PM.
- Never say the estimate is booked. Say ${BUSINESS.owner.split(' ')[0]} will confirm the requested day and time.

SERVICE CLASSIFICATION
- Only collect one of the configured service categories: ${serviceList()}.
- Do not ask about project size, scope, number of rooms, surfaces, measurements, condition, colors, or other job details.
- When you infer the category, confirm it naturally before continuing.
- If the caller’s description could fit more than one category, ask one short clarifying question.
- If the caller voluntarily shares project details, retain them as additionalNotes. At question 9, ask whether there is anything else ${BUSINESS.owner.split(' ')[0]} should know.

CONFIRMATION AND SAVE
- After all nine questions are complete, summarize once: full name, email, service category, town or city, street address, best contact method, preferred estimate day, preferred estimate time, and anything ${BUSINESS.owner.split(' ')[0]} should know. Include the caller-ID phone number only if the server provided it.
- Ask: "Is all of that correct?" Then stop and listen.
- Correct only what the caller changes, then summarize the corrected details and confirm again.
- Only after the caller clearly confirms, call submit_estimate_lead with every field.
- If the caller has no additional notes, send additionalNotes as an empty string.
- Never call submit_estimate_lead twice.

QUESTIONS AND ENDING
- After the server confirms the lead was saved, it will direct you to ask exactly: "Do you have any questions about ${BUSINESS.name}?"
- Answer questions only from the business information below.
- After answering, ask: "Do you have any other questions about ${BUSINESS.name}?" and wait.
- When the caller clearly says no, call finish_call. Do not say the goodbye yourself; the server will deliver the exact closing and hang up.

${businessKnowledge()}`;
}
