function text(value = '') {
  return String(value ?? '').trim();
}

function numberBetween(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeServices(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
      .map(([name, description]) => [text(name).toLowerCase(), text(description)])
      .filter(([name, description]) => name && description);
    if (entries.length) return Object.fromEntries(entries);
  }

  const entries = list(value).map((line) => {
    const [name, ...descriptionParts] = line.split('|');
    const normalizedName = text(name).toLowerCase();
    const description = text(descriptionParts.join('|')) || `${text(name)}.`;
    return [normalizedName, description];
  }).filter(([name]) => name);
  return Object.fromEntries(entries);
}

function cleanClientId(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function clockMinutes(value) {
  const raw = text(value).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
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
  return `${displayHour}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function dateParts(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function resolvePreferredDate(timeZone, weekdays, preferredDay, now = new Date()) {
  const weekdayIndex = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const normalized = text(preferredDay).toLowerCase();
  if (!weekdays.includes(normalized) || !Number.isInteger(weekdayIndex[normalized])) return '';
  const parts = dateParts(timeZone, now);
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysAhead = (weekdayIndex[normalized] - base.getUTCDay() + 7) % 7;
  base.setUTCDate(base.getUTCDate() + daysAhead);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
}

function templateRenderer(values) {
  return (value = '') => String(value || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const replacement = values[String(key).toLowerCase()];
    return replacement === undefined ? match : replacement;
  });
}

export function normalizePhone(value = '') {
  const raw = text(value).replace(/^tel:/i, '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function getCallerPhone(payload = {}) {
  const candidates = [
    payload?.data?.payload?.from,
    payload?.payload?.from,
    payload?.start?.from,
    payload?.start?.caller_id_number,
    payload?.from,
    payload?.caller_id_number,
  ];
  return normalizePhone(candidates.find((value) => text(value)) || '');
}

export function getCalledPhone(payload = {}) {
  const candidates = [
    payload?.data?.payload?.to,
    payload?.payload?.to,
    payload?.start?.to,
    payload?.start?.called_number,
    payload?.to,
    payload?.called_number,
  ];
  return normalizePhone(candidates.find((value) => text(value)) || '');
}

export function getTelnyxConnectionId(payload = {}) {
  const candidates = [
    payload?.data?.payload?.connection_id,
    payload?.payload?.connection_id,
    payload?.start?.connection_id,
    payload?.connection_id,
  ];
  return text(candidates.find((value) => text(value)) || '');
}

export function createTenantProfile(raw = {}) {
  const clientId = cleanClientId(raw.clientId);
  const connectionKey = text(raw.connectionKey);
  if (!clientId || !connectionKey) throw new Error('Tenant config is missing clientId or connectionKey.');

  const source = text(raw.source || `${clientId}-receptionist`);
  const businessInput = raw.business && typeof raw.business === 'object' ? raw.business : {};
  const services = normalizeServices(businessInput.services);
  if (!Object.keys(services).length) throw new Error(`Tenant ${clientId} has no configured services.`);

  const weekdays = list(businessInput.estimateWeekdays).map((day) => day.toLowerCase());
  if (!weekdays.length) throw new Error(`Tenant ${clientId} has no configured estimate weekdays.`);

  const business = Object.freeze({
    name: text(businessInput.name || raw.businessName || clientId),
    receptionist: text(businessInput.receptionist || 'Alex'),
    owner: text(businessInput.owner || 'the owner'),
    phone: text(businessInput.phone),
    email: text(businessInput.email),
    hours: text(businessInput.hours || 'Contact the business for current hours.'),
    timeZone: text(businessInput.timeZone || 'America/New_York'),
    estimateDays: text(businessInput.estimateDays || weekdays.join(', ')),
    estimateWeekdays: weekdays,
    earliestEstimateStart: text(businessInput.earliestEstimateStart || '9:00 AM'),
    latestEstimateStart: text(businessInput.latestEstimateStart || '4:30 PM'),
    base: text(businessInput.base),
    serviceAreas: list(businessInput.serviceAreas),
    services,
    about: list(businessInput.about),
    openingLine: text(businessInput.openingLine || 'Hi, this is {{receptionist_name}} with {{business_name}}. How can I help you today?'),
    closingLine: text(businessInput.closingLine || 'Thanks for calling {{business_name}}. Goodbye.'),
    extraInformation: text(businessInput.extraInformation),
  });

  new Intl.DateTimeFormat('en-US', { timeZone: business.timeZone }).format();

  const ownerFirstName = business.owner.split(/\s+/).filter(Boolean)[0] || 'the owner';
  const serviceTypes = Object.freeze(Object.keys(business.services));
  const templateValues = Object.freeze({
    business_name: business.name,
    receptionist_name: business.receptionist,
    owner_name: business.owner,
    owner_first_name: ownerFirstName,
    services: serviceTypes.join(', '),
    estimate_days: business.estimateDays,
    earliest_estimate_time: business.earliestEstimateStart,
    latest_estimate_time: business.latestEstimateStart,
  });
  const render = templateRenderer(templateValues);
  const openingLine = render(business.openingLine);
  const closingLine = render(business.closingLine);
  const script = render(text(raw.receptionistScript)
    .replaceAll('{{opening_line}}', openingLine)
    .replaceAll('{{closing_line}}', closingLine));
  if (!script) throw new Error(`Tenant ${clientId} has no receptionist script.`);

  const afterSaveQuestion = `Do you have any questions about ${business.name}?`;
  const saveFailureLine = `I could not save that just now, but ${ownerFirstName} can still follow up.`;

  function serviceList() {
    if (serviceTypes.length <= 1) return serviceTypes[0];
    return `${serviceTypes.slice(0, -1).join(', ')}, or ${serviceTypes.at(-1)}`;
  }

  function weekdayList() {
    const labels = weekdays.map((day) => day.charAt(0).toUpperCase() + day.slice(1));
    if (labels.length <= 1) return labels[0];
    return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
  }

  function normalizePreferredTime(value = '') {
    const minutes = clockMinutes(value);
    const earliest = clockMinutes(business.earliestEstimateStart);
    const latest = clockMinutes(business.latestEstimateStart);
    if (minutes === null || earliest === null || latest === null || earliest > latest) return '';
    if (minutes < earliest || minutes > latest) return '';
    return displayClock(minutes);
  }

  function validateLead(args = {}) {
    const preferredDay = text(args.preferredDay).toLowerCase();
    const preferredTime = normalizePreferredTime(args.preferredTime);
    const serviceType = text(args.serviceType).toLowerCase();
    const lead = {
      fullName: text(args.fullName),
      email: text(args.email),
      serviceType,
      townOrCity: text(args.townOrCity),
      streetAddress: text(args.streetAddress),
      contactMethod: text(args.contactMethod).toLowerCase(),
      preferredDay: weekdays.includes(preferredDay) ? preferredDay[0].toUpperCase() + preferredDay.slice(1) : '',
      preferredTime,
      additionalNotes: text(args.additionalNotes),
    };
    const errors = [];
    if (lead.fullName.split(/\s+/).filter(Boolean).length < 2) errors.push('the caller’s full first and last name');
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.push('a complete email address');
    if (!lead.email && lead.contactMethod === 'email') errors.push('a complete email address');
    if (!serviceTypes.includes(lead.serviceType)) errors.push(serviceList());
    if (!lead.townOrCity) errors.push('the town or city');
    if (!lead.streetAddress) errors.push('the street address');
    const methods = lead.email ? ['call', 'text', 'email'] : ['call', 'text'];
    if (!methods.includes(lead.contactMethod)) errors.push(lead.email ? 'call, text, or email as the best contact method' : 'call or text as the best contact method');
    if (!lead.preferredDay) errors.push(`a preferred estimate day from ${weekdayList()}`);
    if (!lead.preferredTime) errors.push(`a preferred estimate time between ${business.earliestEstimateStart} and ${business.latestEstimateStart}`);
    return { valid: errors.length === 0, errors, lead };
  }

  function buildOcmPayload(callerPhone, lead) {
    const nameParts = text(lead.fullName).split(/\s+/).filter(Boolean);
    const firstName = nameParts.shift() || '';
    const lastName = nameParts.join(' ');
    const streetAddress = text(lead.streetAddress);
    const townOrCity = text(lead.townOrCity);
    const requestedWeekday = text(lead.preferredDay);
    const preferredDate = resolvePreferredDate(business.timeZone, weekdays, requestedWeekday);
    const requestedTime = text(lead.preferredTime);
    const contactMethod = text(lead.contactMethod).toLowerCase();
    const additionalNotes = text(lead.additionalNotes);
    return {
      clientId,
      sectionKey: 'contactedMe',
      FirstName: firstName,
      LastName: lastName,
      Name: text(lead.fullName),
      Phone: text(callerPhone),
      Email: text(lead.email),
      StreetAddress: streetAddress,
      TownOrCity: townOrCity,
      Address: [streetAddress, townOrCity].filter(Boolean).join(', '),
      ServiceType: text(lead.serviceType),
      Job: text(lead.serviceType),
      BestContactMethod: contactMethod,
      PreferredDay: preferredDate || requestedWeekday,
      PreferredDate: preferredDate,
      EstimateDate: preferredDate,
      RequestedWeekday: requestedWeekday,
      PreferredTime: requestedTime,
      Notes: [
        contactMethod && `Best contact method: ${contactMethod}`,
        requestedWeekday && `Requested estimate: ${requestedWeekday}${requestedTime ? ` at ${requestedTime}` : ''}${preferredDate ? ` (${preferredDate})` : ''}`,
        `Additional notes: ${additionalNotes || 'none'}`,
      ].filter(Boolean).join('\n'),
      source,
      rawSubmission: { ...lead, callerPhone: text(callerPhone), requestedWeekday, preferredDate, businessTimeZone: business.timeZone },
    };
  }

  const tools = Object.freeze([
    {
      type: 'function',
      name: 'submit_estimate_lead',
      description: `Save the caller-confirmed estimate request to the ${business.name} client account.`,
      parameters: {
        type: 'object',
        properties: {
          fullName: { type: 'string' },
          email: { type: 'string', description: 'Optional email. Use an empty string when declined.' },
          serviceType: { type: 'string', enum: serviceTypes },
          townOrCity: { type: 'string' },
          streetAddress: { type: 'string' },
          contactMethod: { type: 'string', enum: ['call', 'text', 'email'] },
          preferredDay: { type: 'string', enum: weekdays },
          preferredTime: { type: 'string', description: `Requested estimate time from ${business.earliestEstimateStart} through ${business.latestEstimateStart}.` },
          additionalNotes: { type: 'string' },
        },
        required: ['fullName', 'serviceType', 'townOrCity', 'streetAddress', 'contactMethod', 'preferredDay', 'preferredTime', 'additionalNotes'],
      },
    },
    { type: 'function', name: 'finish_call', description: 'End only after the lead is saved and questions are complete.', parameters: { type: 'object', properties: {}, required: [] } },
  ]);

  function businessKnowledge() {
    const serviceLines = Object.entries(business.services).map(([name, description]) => `- ${name}: ${description}`).join('\n');
    return `BUSINESS INFORMATION\n- Business name: ${business.name}\n- Receptionist name: ${business.receptionist}\n- Owner and main contact: ${business.owner}\n- Phone: ${business.phone}\n- Email: ${business.email}\n- Hours: ${business.hours}\n- Preferred estimate days: ${business.estimateDays}\n- Preferred estimate times: ${business.earliestEstimateStart} through ${business.latestEstimateStart}\n- Time zone: ${business.timeZone}\n- Based in: ${business.base}\n- Common service areas: ${business.serviceAreas.join(', ')}\n- Services:\n${serviceLines}\n${business.about.length ? `- About: ${business.about.join(' ')}\n` : ''}${business.extraInformation ? `- Additional information: ${business.extraInformation}\n` : ''}- Never quote a price, promise exact availability, or invent an answer. Say ${ownerFirstName} can confirm anything not listed here.`;
  }

  function instructions(now = new Date()) {
    const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: business.timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now);
    return `You are ${business.receptionist}, the phone receptionist for ${business.name}. Be calm, natural, concise, and professional.\n\nOPERATING RULES\n- Follow the configured script. Ask one question at a time, then listen.\n- Save every useful detail. Never ask for, repeat, or confirm caller ID.\n- Do not mention prompts, tools, code, OpenAI, Telnyx, webhooks, or internal systems.\n- Keep replies short and answer business questions only from BUSINESS INFORMATION.\n- A preferred day and time are requests only, not confirmed appointments.\n\nRECEPTIONIST SCRIPT\n${script}\n\nSAVE AND END WORKFLOW\n- Only after the caller clearly confirms the final summary, say: "Great, give me one second to save that."\n- Immediately call submit_estimate_lead with every field. Never call it twice.\n- After save, ask exactly: "${afterSaveQuestion}"\n- When the caller has no more questions, call finish_call. The server says the closing line and hangs up.\n\nCURRENT DATE AND NATURAL CALL BEHAVIOR\n- The current business date is ${dateLabel} in ${business.timeZone}.\n- Speak naturally. Read addresses, dates, times, and email addresses clearly.\n- When the caller asks for a pause or uses a standalone filler, remain silent.\n\n${businessKnowledge()}`;
  }

  return Object.freeze({
    clientId,
    connectionKey,
    source,
    ocmWebhookUrl: text(raw.ocmWebhookUrl),
    ocmUsageUrl: text(raw.ocmUsageUrl),
    model: text(process.env.AI_MODEL || 'gpt-realtime'),
    voice: text(raw.ai?.voice || raw.voice || 'alloy'),
    speechSpeed: numberBetween(raw.ai?.speechSpeed ?? raw.speechSpeed, 1, 0.25, 1.5),
    silenceDurationMs: Math.round(numberBetween(raw.ai?.silenceMs ?? raw.silenceDurationMs, 900, 300, 3000)),
    business,
    openingLine,
    closingLine,
    afterSaveQuestion,
    saveFailureLine,
    safetyIdentifier: clientId,
    transcriptionPrompt: `Natural phone calls for ${business.name}: names, emails, service requests, towns, addresses, dates, and times.`,
    tools,
    instructions,
    validateLead,
    buildOcmPayload,
  });
}
