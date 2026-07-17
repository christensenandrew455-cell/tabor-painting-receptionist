import {
  AUDIO_FORMAT,
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  buildOcmPayload as buildBaseOcmPayload,
  closingLine,
  getCallerPhone,
  instructions as baseInstructions,
  openingLine,
  tools,
  validateLead,
} from './receptionist-core.js';

export {
  AUDIO_FORMAT,
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  closingLine,
  getCallerPhone,
  openingLine,
  tools,
  validateLead,
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

export function instructions() {
  return `${baseInstructions()}

CURRENT DATE AND NATURAL CALL BEHAVIOR
- The current business date is ${currentBusinessDateLabel()} in the ${BUSINESS_TIME_ZONE} time zone.
- Speak at a calm, measured pace. Use short natural pauses between important details and do not rush through the final summary.
- Read email addresses, street addresses, dates, and times especially slowly and clearly.
- If the caller says "wait," "hold on," "one second," "give me a second," "give me a minute," or otherwise asks for a pause, remain completely silent. Do not say "take your time," do not repeat the question, and do not prompt them. Wait until the caller speaks again, then continue naturally.
- Never fill a silence with repeated reassurance. A quiet pause is allowed.
- After the caller confirms the final summary is correct, say exactly: "Great, give me one second to save that." Then immediately call submit_estimate_lead in the same turn.
- Do not claim the requested estimate date is confirmed. The business owner confirms it later in the client app.`;
}
