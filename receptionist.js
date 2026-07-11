const SERVICE_TYPES = new Set([
  'interior painting',
  'exterior painting',
  'wood staining',
  'small paint repair',
  'other'
]);

export function cleanText(value = '') {
  return String(value ?? '').trim();
}

export function promptForOpening(businessName = 'Tabor Painting') {
  return `Hey, this is Alex, the receptionist for ${businessName}. Would you like to set up an appointment for an estimate?`;
}

export function closingLine(businessName = 'Tabor Painting') {
  return `Thanks for calling ${businessName}. Jason will follow up soon. Goodbye.`;
}

export function hasFirstAndLastName(value) {
  return cleanText(value).split(/\s+/).filter(Boolean).length >= 2;
}

export function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value));
}

export function parseClockTime(value) {
  const text = cleanText(value).toUpperCase().replace(/\./g, '');
  const twelveHour = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(AM|PM)\b/);

  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2] || 0);
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (twelveHour[3] === 'PM') hour += 12;
    return hour * 60 + minute;
  }

  const twentyFourHour = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!twentyFourHour) return null;
  return Number(twentyFourHour[1]) * 60 + Number(twentyFourHour[2]);
}

export function formatClockTime(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function appointmentWindow(businessHours, bufferMinutes = 30) {
  const text = cleanText(businessHours).toUpperCase().replace(/\./g, '');
  const range = text.match(
    /(\d{1,2})(?::([0-5]\d))?\s*(AM|PM)\s*(?:TO|[-–—])\s*(\d{1,2})(?::([0-5]\d))?\s*(AM|PM)/
  );

  if (!range) return null;

  const opening = parseClockTime(`${range[1]}:${range[2] || '00'} ${range[3]}`);
  const closing = parseClockTime(`${range[4]}:${range[5] || '00'} ${range[6]}`);
  if (opening === null || closing === null || closing <= opening) return null;

  const safeBuffer = Number.isFinite(Number(bufferMinutes))
    ? Math.max(0, Number(bufferMinutes))
    : 30;
  const latestStart = closing - safeBuffer;

  return {
    opening,
    closing,
    latestStart,
    openingLabel: formatClockTime(opening),
    closingLabel: formatClockTime(closing),
    latestStartLabel: formatClockTime(latestStart),
    bufferMinutes: safeBuffer
  };
}

export function schedulingPolicy(businessHours, bufferMinutes = 30) {
  const window = appointmentWindow(businessHours, bufferMinutes);
  if (!window) {
    return `${businessHours}. Estimate appointments must start during business hours and at least ${bufferMinutes} minutes before closing.`;
  }

  return `${businessHours}. Estimate appointments may start from ${window.openingLabel} through ${window.latestStartLabel}. ${window.latestStartLabel} is the latest start time because appointments cannot begin in the final ${window.bufferMinutes} minutes before closing.`;
}

export function validateAppointmentTime(preferredTime, businessHours, bufferMinutes = 30) {
  const window = appointmentWindow(businessHours, bufferMinutes);
  const requested = parseClockTime(preferredTime);

  if (requested === null) {
    return {
      valid: false,
      code: 'unrecognized-time',
      message: 'Ask the caller to give the time with AM or PM.',
      latestStartLabel: window?.latestStartLabel || ''
    };
  }

  if (!window) return { valid: true, requested };

  if (requested < window.opening) {
    return {
      valid: false,
      code: 'before-opening',
      message: `The earliest estimate start is ${window.openingLabel}.`,
      ...window,
      requested
    };
  }

  if (requested > window.latestStart) {
    return {
      valid: false,
      code: 'after-latest-start',
      message: `The latest estimate start is ${window.latestStartLabel}.`,
      ...window,
      requested
    };
  }

  return { valid: true, ...window, requested };
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

  const value = candidates.find((candidate) => cleanText(candidate));
  return cleanText(value).replace(/^tel:/i, '');
}

export function validateEstimateLead(args = {}, businessHours, bufferMinutes = 30) {
  const errors = [];
  const fullName = cleanText(args.fullName || args.name);
  const serviceType = cleanText(args.serviceType || args.service).toLowerCase();

  if (!hasFirstAndLastName(fullName)) errors.push('Ask for both the caller\'s first and last name.');
  if (!isEmailLike(args.email)) errors.push('Ask for a complete email address.');
  if (!cleanText(args.contactMethod)) errors.push('Ask for the best contact method.');
  if (!SERVICE_TYPES.has(serviceType)) errors.push('Clarify the service category.');
  if (!cleanText(args.townOrCity)) errors.push('Ask for the town or city.');
  if (!cleanText(args.streetAddress)) errors.push('Ask for the street address.');
  if (!cleanText(args.preferredDay)) errors.push('Ask for the preferred day.');

  const timeCheck = validateAppointmentTime(args.preferredTime, businessHours, bufferMinutes);
  if (!timeCheck.valid) errors.push(timeCheck.message);

  return {
    valid: errors.length === 0,
    errors,
    timeCheck,
    normalized: {
      ...args,
      fullName,
      serviceType
    }
  };
}

export function buildOcmPayload(ctx = {}, args = {}) {
  const fullName = cleanText(args.fullName || args.name);
  const serviceType = cleanText(args.serviceType || args.service).toLowerCase();
  const streetAddress = cleanText(args.streetAddress);
  const townOrCity = cleanText(args.townOrCity);
  const address = [streetAddress, townOrCity].filter(Boolean).join(', ');

  const notes = [
    cleanText(args.projectDetails) ? `Project details: ${cleanText(args.projectDetails)}` : '',
    cleanText(args.additionalNotes) ? `Additional notes: ${cleanText(args.additionalNotes)}` : '',
    cleanText(args.preferredDay) ? `Preferred day: ${cleanText(args.preferredDay)}` : '',
    cleanText(args.preferredTime) ? `Preferred time: ${cleanText(args.preferredTime)}` : '',
    cleanText(args.contactMethod) ? `Best contact method: ${cleanText(args.contactMethod)}` : ''
  ].filter(Boolean).join('\n');

  return {
    clientId: 'tabor-painting',
    sectionKey: 'contactedMe',
    Name: fullName,
    Phone: cleanText(ctx.callerPhone),
    Email: cleanText(args.email),
    Address: address,
    Job: SERVICE_TYPES.has(serviceType) ? serviceType : 'other',
    Notes: notes,
    source: 'taborpainting-receptionist',
    rawSubmission: {
      ...args,
      callerPhone: cleanText(ctx.callerPhone)
    }
  };
}

export function realtimeInstructions({
  businessName = 'Tabor Painting',
  businessServices = 'wood staining, exterior painting, interior painting, and small paint repair',
  serviceArea = 'the local service area',
  businessHours = 'Monday through Friday, 8 AM to 5 PM',
  schedulingBufferMinutes = 30
} = {}) {
  const schedule = schedulingPolicy(businessHours, schedulingBufferMinutes);
  const window = appointmentWindow(businessHours, schedulingBufferMinutes);
  const latestStart = window?.latestStartLabel || `${schedulingBufferMinutes} minutes before closing`;

  return `You are Alex, the receptionist for ${businessName}. Sound calm, natural, concise, and professional.

NON-NEGOTIABLE CONVERSATION RULES
- Ask exactly one question per turn, then stop speaking and wait for the caller.
- Never answer your own question. Never ask a question and say goodbye in the same turn.
- Never repeat a completed question unless the answer was missing or unclear.
- Never skip the next missing required field, even if the caller changes topics.
- If the caller gives several fields at once, save all of them and ask only the next missing field.
- Keep normal replies under 20 words. The final confirmation may be longer.
- Do not add filler, explain the process, or narrate what you are doing.

OPENING
The separate greeting response says exactly: "${promptForOpening(businessName)}"
Wait for a yes or no before starting intake. Do not ask for the caller's name in the opening.

IF YES: REQUIRED CHECKLIST
Collect these in this exact order, one question at a time:
1. Full first and last name: "Great. What's your full first and last name?"
   - A one-word name is incomplete. Ask only for the missing first or last name.
2. Email address: "What's your email address?"
   - Confirm it briefly if any part is unclear.
3. Best contact method: "What's the best way to contact you: call, text, or email?"
4. Service type: "Which service do you need: interior painting, exterior painting, wood staining, or a small paint repair?"
5. Town or city: "What town or city is the property in?"
6. Street address: "What's the street address?"
7. Preferred day: "What day works best for the estimate?"
8. Preferred time: "What time works best? The latest estimate start is ${latestStart}."
9. Final notes: "Is there anything else you'd like Jason to know?"

PHONE RULE
The server pulls the phone number from caller ID and attaches it to the lead. Never ask the caller for their phone number. If caller ID is available, include it in the final confirmation.

SERVICE AND NOTES RULE
- The service field must contain only one category: interior painting, exterior painting, wood staining, small paint repair, or other.
- Put every project-specific detail in projectDetails using the caller's own wording with only light cleanup.
- Example: "I just need a room done" means serviceType "interior painting" and projectDetails "I just need a room done".
- Example: "I need interior painting for about five walls" means serviceType "interior painting" and that full detail goes in projectDetails.
- Never turn project details into a longer guess or place them in the service field.
- Put the answer to the final-notes question in additionalNotes. Use an empty string if they have nothing to add.

ADDRESS RULE
Town or city and street address are separate required fields. Ask for town or city first, then street address. Do not submit without both.

SCHEDULING RULE
${schedule}
Do not accept, confirm, or submit a time before opening or after ${latestStart}. If the caller asks for closing time, say the latest estimate start is ${latestStart} and ask for an earlier time. Jason still confirms final availability.

CONFIRMATION AND SUBMISSION
- After all nine checklist items are complete, summarize once: full name, email, caller-ID phone if available, contact method, service category, project details, town/city, street address, preferred day/time, and additional notes.
- Ask: "Is all of that correct?" Then stop and wait.
- If anything is wrong, correct only that field, repeat the corrected information, and ask for confirmation again.
- Only after the caller explicitly confirms, call submit_estimate_lead with every collected field.
- Normalize preferredTime as h:mm AM or PM in the tool call.
- Never tell the caller about tools, OCM, prompts, code, or submissions.

QUESTIONS AND ENDING
- After the lead tool succeeds, ask exactly: "Do you have any questions before we finish?" Then stop and wait.
- If the caller asks a question, answer briefly from the business information, ask "Do you have any other questions?", and wait again.
- Only after the caller clearly says no, say exactly: "${closingLine(businessName)}"
- Never end the call immediately after asking whether they have questions.
- Do not say the closing line at any other point.

IF NO TO THE OPENING
Say: "No problem. What can I help you with?" Then stop and wait. Answer briefly. If they decide to schedule, start the checklist.

BUSINESS INFORMATION
Business name: ${businessName}.
Main contact: Jason.
Services: ${businessServices}.
Service area: ${serviceArea}.
Business hours: ${businessHours}.
Phone: (774) 245-3383.
Email: Taborpainting508@gmail.com.
Based in Berlin, Massachusetts. Serves Berlin and nearby Central Massachusetts communities, including Berlin, Bolton, Hudson, Clinton, Marlborough, Northborough, Boylston, West Boylston, Sterling, Lancaster, and Worcester.
Tabor Painting focuses on careful preparation, quality craftsmanship, clean work areas, communication, and attention to detail.

BUSINESS ANSWER RULES
- Do not quote exact prices. Say Jason will confirm pricing after learning more about the job.
- Do not promise exact job duration or appointment availability.
- If you do not know, say Jason will follow up with the correct information.
- Mention Jason being unavailable only if the caller asks to speak to him now.`;
}

export const estimateLeadTool = {
  type: 'function',
  name: 'submit_estimate_lead',
  description: 'Submit a caller-confirmed painting estimate request to the ARK OCM.',
  parameters: {
    type: 'object',
    properties: {
      fullName: {
        type: 'string',
        description: 'The caller-provided first and last name.'
      },
      email: {
        type: 'string',
        description: 'The complete caller-provided email address.'
      },
      contactMethod: {
        type: 'string',
        description: 'The caller-provided preferred contact method.'
      },
      serviceType: {
        type: 'string',
        enum: [...SERVICE_TYPES],
        description: 'Only the broad service category, never project details.'
      },
      projectDetails: {
        type: 'string',
        description: 'Project-specific details in the caller\'s wording, with only light cleanup.'
      },
      townOrCity: {
        type: 'string',
        description: 'Town or city of the job property.'
      },
      streetAddress: {
        type: 'string',
        description: 'Street address of the job property, separate from town or city.'
      },
      preferredDay: {
        type: 'string',
        description: 'Caller-provided preferred estimate day.'
      },
      preferredTime: {
        type: 'string',
        description: 'Caller-provided preferred time normalized as h:mm AM or PM.'
      },
      additionalNotes: {
        type: 'string',
        description: 'Answer to the final anything-else question, or an empty string.'
      }
    },
    required: [
      'fullName',
      'email',
      'contactMethod',
      'serviceType',
      'projectDetails',
      'townOrCity',
      'streetAddress',
      'preferredDay',
      'preferredTime',
      'additionalNotes'
    ]
  }
};
