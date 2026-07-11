export const REALTIME_MODEL = 'gpt-realtime-mini';
export const REALTIME_VOICE = 'alloy';
export const AUDIO_FORMAT = { type: 'audio/pcmu' };

export const BUSINESS = Object.freeze({
  name: 'Tabor Painting',
  receptionist: 'Alex',
  owner: 'Jason Beirne',
  phone: '(774) 245-3383',
  email: 'Taborpainting508@gmail.com',
  hours: 'Monday through Friday, 8 AM to 5 PM',
  estimateDays: 'Monday through Friday',
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
  ]
});

const SERVICE_TYPES = Object.freeze([
  'interior painting',
  'exterior painting',
  'wood staining',
  'small paint repair'
]);

const WEEKDAYS = Object.freeze([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday'
]);

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

export function normalizePreferredTime(value = '') {
  const raw = cleanText(value).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const match = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/);
  if (!match) return '';

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3] || '';

  if (meridiem) {
    if (hour < 1 || hour > 12) return '';
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  } else if (hour < 0 || hour > 23) {
    return '';
  }

  const minutesAfterMidnight = hour * 60 + minute;
  if (minutesAfterMidnight < 9 * 60 || minutesAfterMidnight > 16 * 60 + 30) return '';

  const displayHour = hour % 12 || 12;
  const displayMinute = String(minute).padStart(2, '0');
  const displayMeridiem = hour >= 12 ? 'PM' : 'AM';
  return `${displayHour}:${displayMinute} ${displayMeridiem}`;
}

export function validateLead(args = {}) {
  const preferredDay = cleanText(args.preferredDay).toLowerCase();
  const preferredTime = normalizePreferredTime(args.preferredTime);
  const lead = {
    fullName: cleanText(args.fullName),
    email: cleanText(args.email),
    serviceType: cleanText(args.serviceType).toLowerCase(),
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
  if (!SERVICE_TYPES.includes(lead.serviceType)) errors.push('interior painting, exterior painting, wood staining, or small paint repair');
  if (!lead.townOrCity) errors.push('the town or city');
  if (!lead.streetAddress) errors.push('the street address');
  if (!['call', 'text', 'email'].includes(lead.contactMethod)) errors.push('call, text, or email as the best contact method');
  if (!lead.preferredDay) errors.push('a preferred estimate day from Monday through Friday');
  if (!lead.preferredTime) errors.push('a preferred estimate time between 9:00 AM and 4:30 PM');

  return { valid: errors.length === 0, errors, lead };
}

export function buildOcmPayload(callerPhone, lead) {
  const notes = [
    `Best contact method: ${lead.contactMethod}`,
    lead.additionalNotes ? `Additional notes: ${lead.additionalNotes}` : 'Additional notes: none'
  ].join('\n');

  return {
    clientId: 'tabor-painting',
    sectionKey: 'contactedMe',
    Name: lead.fullName,
    Phone: cleanText(callerPhone),
    Email: lead.email,
    Address: `${lead.streetAddress}, ${lead.townOrCity}`,
    Job: lead.serviceType,
    PreferredDay: lead.preferredDay,
    PreferredTime: lead.preferredTime,
    Notes: notes,
    source: 'tabor-painting-receptionist',
    rawSubmission: { ...lead, callerPhone: cleanText(callerPhone) }
  };
}

export const tools = [
  {
    type: 'function',
    name: 'submit_estimate_lead',
    description: 'Save the caller-confirmed estimate request to the Tabor Painting OCM.',
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
        preferredTime: { type: 'string', description: 'Preferred estimate time from 9:00 AM through 4:30 PM.' },
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
  return `
BUSINESS INFORMATION
- Business name: ${BUSINESS.name}
- Receptionist name: ${BUSINESS.receptionist}
- Owner and main contact: ${BUSINESS.owner}
- Phone: ${BUSINESS.phone}
- Email: ${BUSINESS.email}
- Hours: ${BUSINESS.hours}
- Preferred estimate days: ${BUSINESS.estimateDays}
- Preferred estimate times may be requested from ${BUSINESS.earliestEstimateStart} through ${BUSINESS.latestEstimateStart}. Jason confirms actual availability.
- Based in: ${BUSINESS.base}
- Common service areas: ${BUSINESS.serviceAreas.join(', ')}
- Interior painting: ${BUSINESS.services['interior painting']}
- Exterior painting: ${BUSINESS.services['exterior painting']}
- Small paint repair: ${BUSINESS.services['small paint repair']}
- Wood staining: ${BUSINESS.services['wood staining']}
- About: ${BUSINESS.about.join(' ')}
- Never quote a price, promise exact availability, or invent an answer. Say Jason can confirm anything not listed here.`;
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
3. Ask: "What service would you like? We specialize in interior painting, exterior painting, wood staining, and small paint repair."
4. Ask: "What town or city is the project located in?"
5. Ask: "What is the street address of the project?"
6. Ask: "What is the best way we can contact you: call, text, or email?"
7. Ask: "What day would work best for the estimate? We schedule estimates Monday through Friday."
8. After the caller gives a valid weekday, ask: "What time would work best? We accept estimate times from 9:00 AM to 4:30 PM."
9. Ask: "Is there anything else you would like Jason to know?"

DAY AND TIME RULES
- Accept only Monday, Tuesday, Wednesday, Thursday, or Friday.
- If the caller gives Saturday or Sunday, say: "We schedule estimates Monday through Friday. What weekday would work best?" Then wait.
- Accept times from 9:00 AM through 4:30 PM, inclusive.
- If the caller gives a time before 9:00 AM or after 4:30 PM, say: "We can only do estimate times between 9:00 AM and 4:30 PM. What time in that range would work best?" Then wait.
- Normalize the time clearly, such as 9:00 AM, 1:30 PM, or 4:30 PM.
- Never say the estimate is booked. Say Jason will confirm the requested day and time.

SERVICE CLASSIFICATION
- Only collect the service category: interior painting, exterior painting, wood staining, or small paint repair.
- Do not ask about project size, scope, number of rooms, surfaces, measurements, condition, colors, or other job details.
- Inside a home, room, indoor walls, ceilings, interior trim, or interior doors usually means interior painting.
- Outside a home, siding, exterior walls, or exterior trim usually means exterior painting.
- A touch-up, small damaged area, small patch, or minor repair usually means small paint repair.
- Staining a deck, fence, trim, or another wood surface usually means wood staining.
- When you infer the category, confirm it naturally before continuing. Example: "That sounds like exterior painting. Is that correct?"
- If the caller mentions walls or painting but does not say whether the work is inside or outside, ask only whether it is inside or outside before categorizing it.
- If the caller voluntarily shares project details, retain them as additionalNotes. At question 9, ask whether there is anything else Jason should know.

CONFIRMATION AND SAVE
- After all nine questions are complete, summarize once: full name, email, service category, town or city, street address, best contact method, preferred estimate day, preferred estimate time, and anything Jason should know. Include the caller-ID phone number only if the server provided it.
- Ask: "Is all of that correct?" Then stop and listen.
- Correct only what the caller changes, then summarize the corrected details and confirm again.
- Only after the caller clearly confirms, call submit_estimate_lead with every field.
- If the caller has no additional notes, send additionalNotes as an empty string.
- Never call submit_estimate_lead twice.

QUESTIONS AND ENDING
- After the server confirms the lead was saved, it will direct you to ask exactly: "Do you have any questions about Tabor Painting?"
- Answer questions only from the business information below.
- After answering, ask: "Do you have any other questions about Tabor Painting?" and wait.
- When the caller clearly says no, call finish_call. Do not say the goodbye yourself; the server will deliver the exact closing and hang up.

${businessKnowledge()}`;
}
