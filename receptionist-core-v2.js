import {
  AUDIO_FORMAT,
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  buildOcmPayload as buildBaseOcmPayload,
  closingLine,
  getCallerPhone,
  instructions as baseInstructions,
  normalizePreferredTime,
  openingLine,
  tools as baseTools,
  validateLead as baseValidateLead,
} from './receptionist-core.js';

export {
  AUDIO_FORMAT,
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  closingLine,
  getCallerPhone,
  normalizePreferredTime,
  openingLine,
};

const WEEKDAY_INDEX = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

const BUSINESS_TIME_ZONE = String(
  process.env.BUSINESS_TIME_ZONE || BUSINESS.timeZone || 'America/New_York'
).trim() || 'America/New_York';

const EMAIL_VALIDATION_ERROR = 'a complete email address';

export function validateLead(args = {}) {
  const result = baseValidateLead(args);
  const emailWasDeclined = !result.lead.email && result.lead.contactMethod !== 'email';

  if (!emailWasDeclined) return result;

  const errors = result.errors.filter((error) => error !== EMAIL_VALIDATION_ERROR);
  return {
    ...result,
    valid: errors.length === 0,
    errors,
  };
}

export const tools = Object.freeze(baseTools.map((tool) => {
  if (tool.name !== 'submit_estimate_lead') return tool;

  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        email: {
          ...tool.parameters.properties.email,
          description: 'Optional caller email address. Send an empty string when the caller declines to provide one.',
        },
      },
      required: tool.parameters.required.filter((field) => field !== 'email'),
    },
  };
}));

function datePartsInBusinessTimeZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
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
  const normalized = String(preferredDay || '').trim().toLowerCase();
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

function currentBusinessDateLabel(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}

export function buildOcmPayload(callerPhone, lead) {
  const payload = buildBaseOcmPayload(callerPhone, lead);
  const requestedWeekday = String(lead?.preferredDay || '').trim();
  const preferredDate = resolvePreferredDate(requestedWeekday);
  const contactMethod = String(lead?.contactMethod || '').trim().toLowerCase();
  const requestedTime = String(lead?.preferredTime || '').trim();
  const additionalNotes = String(lead?.additionalNotes || '').trim();
  const notes = [
    contactMethod && `Best contact method: ${contactMethod}`,
    requestedWeekday && `Requested estimate: ${requestedWeekday}${requestedTime ? ` at ${requestedTime}` : ''}${preferredDate ? ` (${preferredDate})` : ''}`,
    `Additional notes: ${additionalNotes || 'none'}`,
  ].filter(Boolean).join('\n');

  return {
    ...payload,
    PreferredDay: preferredDate || payload.PreferredDay,
    PreferredDate: preferredDate,
    EstimateDate: preferredDate,
    RequestedWeekday: requestedWeekday,
    Notes: notes,
    rawSubmission: {
      ...(payload.rawSubmission || {}),
      requestedWeekday,
      preferredDate,
      businessTimeZone: BUSINESS_TIME_ZONE,
    },
  };
}

function intakeInstructions() {
  return baseInstructions()
    .replace(
      '- Never ask for the caller’s phone number. The server gets it from caller ID.',
      '- Never ask for, say, confirm, or repeat the caller’s phone number. The server gets it from caller ID and uses it only for the saved lead record.'
    )
    .replace(
      '2. Ask: "Can you please share your email address?"',
      `2. Ask exactly: "Would you like to add your email? Yes or no."
   - If the caller says no, say: "Okay." Save email as an empty string and move directly to question 3.
   - If the caller says yes, ask: "What would your email be?" Then wait for the complete email address.
   - If the caller declined email but later chooses email as the best contact method, ask for the email address then.`
    )
    .replace(
      '- After all nine questions are complete, summarize once: full name, email, service category, town or city, street address, best contact method, preferred estimate day, preferred estimate time, and anything Jason should know. Include the caller-ID phone number only if the server provided it.',
      '- After the intake is complete, summarize once: full name, email only when one was provided, service category, town or city, street address, best contact method, preferred estimate day, preferred estimate time, and anything Jason should know. Never say or repeat the caller-ID phone number.'
    )
    .replace(
      '- Only after the caller clearly confirms, call submit_estimate_lead with every field.',
      '- Only after the caller clearly confirms, call submit_estimate_lead. Send email as an empty string when the caller declined it.'
    );
}

export function instructions() {
  return `${intakeInstructions()}

CURRENT DATE AND NATURAL CALL BEHAVIOR
- The current business date is ${currentBusinessDateLabel()} in the ${BUSINESS_TIME_ZONE} time zone.
- Speak at a calm, measured pace. Use short natural pauses between important details and do not rush through the final summary.
- Read email addresses, street addresses, dates, and times especially slowly and clearly.
- If the caller says "wait," "hold on," "one second," "give me a second," "give me a minute," or otherwise asks for a pause, remain completely silent. Do not say "take your time," do not repeat the question, and do not prompt them. Wait until the caller speaks again, then continue naturally.
- Never fill a silence with repeated reassurance. A quiet pause is allowed.
- After the caller confirms the final summary is correct, say exactly: "Great, give me one second to save that." Then immediately call submit_estimate_lead in the same turn.
- Do not claim the requested estimate date is confirmed. The business owner confirms it later in the client app.
- The caller-ID phone number is private internal data. Never speak it, confirm it, or include it in any summary, even if another context message mentions it.`;
}
