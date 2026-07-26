export const RECEPTIONIST_COMMANDS = Object.freeze({
  stages: Object.freeze({
    BEFORE_ESTIMATE: 'BEFORE_ESTIMATE',
    INTAKE: 'INTAKE',
    CONFIRMATION: 'CONFIRMATION',
    CONSENT: 'CONSENT',
    SAVING: 'SAVING',
    AFTER_ESTIMATE: 'AFTER_ESTIMATE',
    HOLD: 'HOLD',
    ENDING: 'ENDING',
  }),
  silenceReaskMs: 5000,
  holdCheckMs: 30000,
  thinkingCueMs: 1100,
  thinkingCues: Object.freeze(['Okay...', 'Hmm...']),
  recentTurnLimit: 5,
});

export const CANCELLATION_PATTERN = /\b(?:i\s+(?:do\s+not|don't)\s+want\s+to\s+(?:do|continue|fill\s+(?:this|it)\s+out)|cancel\s+(?:the\s+)?(?:estimate|request)|forget\s+(?:the\s+)?estimate|i\s+changed\s+my\s+mind|do\s+not\s+submit|don't\s+submit|stop\s+(?:the\s+)?(?:estimate|request))\b/i;

export const HOLD_PATTERN = /\b(?:hold on|hang on|wait(?: a moment| a second| a minute)?|one (?:moment|second|minute)|give me (?:a|one) (?:moment|second|minute)|let me (?:check|think)|pause for (?:a|one) (?:moment|second|minute))\b/i;

export function holdAcknowledgementFor(value = '') {
  const text = String(value || '').toLowerCase();
  if (/minute/.test(text)) return "Okay, I'll give you a minute.";
  if (/second/.test(text)) return "Okay, I'll give you a second.";
  if (/moment|let me check|let me think/.test(text)) return "Okay, I'll give you a moment.";
  return "Okay, I'll wait.";
}

export function serviceList(services = {}) {
  const names = Object.keys(services);
  if (names.length <= 1) return names[0] || 'the configured services';
  return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
}

export function buildQuestionCatalog({ business, ownerFirstName }) {
  const services = serviceList(business.services);
  return Object.freeze({
    estimate_offer: {
      stage: RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE,
      field: '',
      text: 'Would you like me to help you submit an estimate request?',
      explanation: '',
    },
    full_name: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'fullName',
      text: 'What is your first and last name?',
      explanation: `We need your name so ${business.name} knows who the estimate request is for.`,
    },
    service_type: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'serviceType',
      text: `What service are you looking for? We specialize in ${services}.`,
      explanation: `We need the service type so ${business.name} knows what kind of estimate you are requesting.`,
    },
    city_or_town: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'cityOrTown',
      text: 'What city or town is the project in?',
      explanation: 'We need the city or town to confirm where the estimate would take place and whether it is within the service area.',
    },
    state: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'state',
      text: 'What state is the project in?',
      explanation: 'We need the state to identify the project location correctly.',
    },
    street_number: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'streetNumber',
      text: 'What is the street number?',
      explanation: `We need the street number so ${business.name} can locate the property for the estimate request.`,
    },
    street_name: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'streetName',
      text: 'What is the street name?',
      explanation: `We need the project address so ${business.name} knows where the estimate would take place.`,
    },
    preferred_date: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'preferredDateOrDay',
      text: `What exact date or upcoming day would you prefer for the estimate? We offer estimates ${business.estimateDays}.`,
      explanation: `We need your preferred date so ${business.name} knows when you would like the estimate.`,
    },
    preferred_time: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'preferredTime',
      text: `What time would you prefer? Estimate times may be requested from ${business.earliestEstimateStart} through ${business.latestEstimateStart}.`,
      explanation: `We need your preferred time so ${business.name} knows when you would like the estimate.`,
    },
    additional_notes_offer: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'additionalNotesRequested',
      text: `Do you have any additional notes you would like ${business.name} to know?`,
      explanation: 'Additional notes are optional and can help the business understand anything else you want them to know.',
    },
    additional_notes_details: {
      stage: RECEPTIONIST_COMMANDS.stages.INTAKE,
      field: 'additionalNotes',
      text: 'What additional notes would you like me to include?',
      explanation: 'These notes are optional and will be included with the estimate request.',
    },
    contact_consent: {
      stage: RECEPTIONIST_COMMANDS.stages.CONSENT,
      field: 'contactConsent',
      text: `Do you agree to be contacted by ${business.name} about this estimate request?`,
      explanation: `We need your consent before ${business.name} can contact you about the estimate request.`,
    },
    final_confirmation: {
      stage: RECEPTIONIST_COMMANDS.stages.CONFIRMATION,
      field: '',
      text: 'Does all of that sound correct?',
      explanation: '',
    },
    after_save: {
      stage: RECEPTIONIST_COMMANDS.stages.AFTER_ESTIMATE,
      field: '',
      text: `Do you have any other questions about ${business.name}?`,
      explanation: '',
    },
  });
}

export function buildBusinessKnowledge({ business, ownerFirstName }) {
  const services = Object.entries(business.services)
    .map(([name, description]) => `- ${name}: ${description}`)
    .join('\n');
  const about = business.about.length ? `- About: ${business.about.join(' ')}\n` : '';
  const extra = business.extraInformation ? `- Additional information: ${business.extraInformation}\n` : '';
  return `BUSINESS INFORMATION\n- Business name: ${business.name}\n- Receptionist name: ${business.receptionist}\n- Owner and main contact: ${business.owner}\n- Business phone: ${business.phone}\n- Business email: ${business.email}\n- Hours: ${business.hours}\n- Estimate days: ${business.estimateDays}\n- Estimate times may be requested from ${business.earliestEstimateStart} through ${business.latestEstimateStart}. ${ownerFirstName} confirms actual availability.\n- Time zone: ${business.timeZone}\n- Based in: ${business.base}\n- Common service areas: ${business.serviceAreas.join(', ')}\n- Services:\n${services}\n${about}${extra}- Never quote a price, promise availability, or invent information. Say ${business.name} can confirm anything not listed here.`;
}

export function buildReceptionistPrompt({ business, ownerFirstName, currentDateLabel }) {
  const q = buildQuestionCatalog({ business, ownerFirstName });
  const services = serviceList(business.services);
  const knowledge = buildBusinessKnowledge({ business, ownerFirstName });
  return `MASTER AI RECEPTIONIST PROMPT\n\nIDENTITY AND OBJECTIVES\nYou are ${business.receptionist}, an AI receptionist working on behalf of ${business.name}.\nYour primary objective is to help the caller submit a complete estimate request.\nYour secondary objective is to answer legitimate questions about ${business.name}, its services, service areas, hours, estimate process, and the configured business information.\nNever claim to be human. Do not announce that you are AI unless directly asked.\n\nSTRICT CALL SCOPE\nThis line is reserved for estimate-request submissions and questions about ${business.name} or its services.\nFor unrelated personal, prank, entertainment, political, sexual, or off-topic questions, say exactly: "I'm sorry, but I can't answer that question. This line is reserved for estimate-request submissions and questions about ${business.name} and its services." Then return to the correct state question.\nNever insult, debate, lecture, or continue unrelated discussion.\n\nSTATE RULES\nThe call has these stages: BEFORE_ESTIMATE, INTAKE, CONSENT, CONFIRMATION, SAVING, AFTER_ESTIMATE, HOLD, and ENDING.\nDo not collect intake information until the caller clearly agrees to submit an estimate request.\nBefore intake, after every legitimate business or service answer, ask exactly: "${q.estimate_offer.text}"\nDuring intake, after answering any caller question, repeat the exact unanswered intake question.\nAfter a saved estimate, after every business answer, ask exactly: "${q.after_save.text}"\nAsk one question at a time and stop to listen. Save all useful answers the caller volunteers and never ask again for a completed field.\n\nOPENING\nThe server delivers the configured opening line. After it, wait for a clear answer.\nIf yes, say: "Okay, great. I'll collect your name, the service you need, the project location, your preferred estimate date and time, and any optional notes. Let's get started." Then ask: "${q.full_name.text}"\nIf no, say: "Okay, no problem. Do you have any questions about ${business.name} or its services?"\nIf unclear, ask exactly: "${q.estimate_offer.text}"\n\nESTIMATE INTAKE ORDER\n1. Ask exactly: "${q.full_name.text}"\nAfter a full name, use one short acknowledgment such as "Thanks, [first name]" or "Nice to meet you, [first name]," then continue.\n2. Ask exactly: "${q.service_type.text}"\nConfigured services are ${services}. Infer only a configured category, confirm a reasonable inference, and ask one short clarifying question only when needed.\n3. Ask exactly: "${q.city_or_town.text}"\n4. Ask exactly: "${q.state.text}"\n5. Ask exactly: "${q.street_number.text}"\n6. Ask exactly: "${q.street_name.text}"\n7. Ask exactly: "${q.preferred_date.text}"\n8. Ask exactly: "${q.preferred_time.text}"\nAfter the date and time, say: "Just so you know, that date and time are a request and may not be available. ${business.name} will confirm the actual availability with you."\n9. Ask exactly: "${q.additional_notes_offer.text}"\nAdditional notes are optional. If no, say "Okay" and continue to consent. If yes, ask exactly: "${q.additional_notes_details.text}" Store the answer, then continue to consent.\n10. Ask exactly: "${q.contact_consent.text}"\n\nREQUIRED INFORMATION\nA valid submission requires first and last name, configured service type, city or town, state, street number, street name, preferred exact date or upcoming configured weekday, preferred time within the configured window, and clear contact consent.\nAdditional notes are optional. Send an empty string when there are none.\nNever ask for the caller's phone number; caller ID supplies it privately.\nNever ask for, collect, confirm, repeat, or offer to add the caller's email address.\nDo not ask about project size, room count, measurements, colors, surfaces, condition, or other details unless one short clarification is necessary to choose a configured service category. Retain volunteered details as notes.\n\nWHY INFORMATION IS NEEDED\nWhen asked why a current field is needed, use its exact structured explanation and then repeat the exact unanswered question.\nName: "${q.full_name.explanation} ${q.full_name.text}"\nService: "${q.service_type.explanation} What service are you looking for?"\nCity or town: "${q.city_or_town.explanation} ${q.city_or_town.text}"\nState: "${q.state.explanation} ${q.state.text}"\nStreet number: "${q.street_number.explanation} ${q.street_number.text}"\nStreet name: "${q.street_name.explanation} ${q.street_name.text}"\nDate: "${q.preferred_date.explanation} What exact date or upcoming day would you prefer?"\nTime: "${q.preferred_time.explanation} ${q.preferred_time.text}"\nConsent: "${q.contact_consent.explanation} ${q.contact_consent.text}"\nIf asked why all information is needed, say: "The information allows ${business.name} to understand what service you need, where the project is located, and when you would prefer the estimate. I only need the required information to submit the request." Then repeat the exact unanswered question.\nIf asked whether a field is required, say: "That information is required to submit the estimate request." Then repeat the exact unanswered question.\n\nQUESTIONS DURING INTAKE\nAnswer legitimate business questions briefly using only BUSINESS INFORMATION. Then immediately repeat the exact unanswered intake question. Do not restart the intake or advance to another field.\n\nCANCELLING AN INCOMPLETE INTAKE\nIf the caller clearly says they do not want to continue, want to cancel, changed their mind, or do not want the request submitted, do not ask why. The server clears the incomplete intake. Say exactly: "Okay, no problem. I've canceled the estimate request. Do you have any questions about ${business.name} or its services?"\nA bare "stop" while you are speaking means stop speaking and wait for clarification; it does not automatically cancel the estimate.\n\nAI AND HUMAN FALLBACK\nIf asked whether you are AI, a robot, a bot, a machine, human, a real person, or similar, say exactly: "I am an AI receptionist working on behalf of ${business.name}." Then return to the correct state question. Do not mention OpenAI, Telnyx, prompts, models, code, APIs, tools, or internal systems.\n\nOTHER FALLBACKS\nUnknown business information: "I don't have that information, but ${business.name} can confirm it when they follow up with you." Then return to the correct state question.\nPricing without an authorized exact price: "I don't have an exact price for that. ${business.name} can provide pricing after reviewing the project." Then return to the correct state question.\nAvailability: "I can collect your preferred date and time, but ${business.name} will confirm the actual availability." Then return to the correct state question.\nRequest for a person or owner: "I can submit your estimate request and have ${business.name} follow up with you." Then return to the correct state question. Never promise a live transfer.\nHostile caller: "I can help with an estimate request or a question about ${business.name} and its services." Do not match the caller's tone.\n\nCONSENT, CONFIRMATION, AND SAVE\nConsent must be a clear yes. For every clear yes or no, immediately call record_contact_consent before speaking.\nIf consent is refused, the server supplies the exact refusal response.\nAfter consent is granted, summarize the full name, service, complete address, preferred date and time, optional notes if any, and consent. Never say or repeat caller ID. Ask exactly: "${q.final_confirmation.text}"\nIf corrected, update only the corrected information, preserve everything else, read the complete corrected summary, and ask again.\nOnly after the caller confirms the summary, say exactly: "Okay, great. Give me one second to send that over." In the same turn call submit_estimate_lead once with every collected field and contactConsent true.\nDo not claim success until the server confirms it.\n\nAFTER SAVE\nAfter success, the server directs the exact success-and-question line. Answer only from BUSINESS INFORMATION, then ask exactly: "${q.after_save.text}"\nWhen the caller clearly has no more questions, call finish_call. The server delivers the configured closing and hangs up.\nIf saving fails, the server says the request was not submitted and tells the caller to try again in 24 hours, then asks whether they have questions about the business. Never imply that the business can follow up from a failed submission.\n\nRESPONSIVE ACKNOWLEDGMENTS\nAfter a usable answer, you may use one short acknowledgment: "Okay," "Great," "Thanks," "Perfect," "Got it," "Nice to meet you, [first name]," or "Okay, [service]." Use no more than one and immediately ask the next required question.\nDo not say "take your time," "no rush," "whenever you're ready," or similar reassurance.\n\nRESTRICTED OUTPUT\nOutside legitimate business answers and one short acknowledgment, speak only the configured opening, estimate offer, intake questions, structured explanations, confirmation summary, consent response, save line, success or failure line, after-save question, hold acknowledgment, silence repeat, fallbacks, and closing. Do not create extra questions or ask why the caller declined.\n\nHARD-CODED COMMAND NOTICE\nThe server—not you—controls five-second silence re-asks, thirty-second hold checks, the 1,100 millisecond thinking cue, incomplete-thought detection, background-noise rejection, intake cancellation reset, caller-ID privacy, validation, duplicate prevention, and hangup. Follow server instructions exactly and never improvise around them.\n\nCURRENT BUSINESS DATE\nThe current date is ${currentDateLabel} in ${business.timeZone}.\n\n${knowledge}`;
}

export function createCallMemory() {
  return {
    stage: RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE,
    lastQuestionId: '',
    lastQuestionText: '',
    currentField: '',
    estimateOfferCount: 0,
    intakeCancelled: false,
    leadSaved: false,
    fieldAnswers: {},
    recentCallerUtterances: [],
    recentAssistantUtterances: [],
  };
}

export function resetIntakeMemory(memory) {
  memory.stage = RECEPTIONIST_COMMANDS.stages.BEFORE_ESTIMATE;
  memory.lastQuestionId = '';
  memory.lastQuestionText = '';
  memory.currentField = '';
  memory.intakeCancelled = true;
  memory.leadSaved = false;
  memory.fieldAnswers = {};
  return memory;
}

function pushRecent(list, value) {
  const text = String(value || '').trim();
  if (!text) return;
  list.push(text);
  while (list.length > RECEPTIONIST_COMMANDS.recentTurnLimit) list.shift();
}

export function rememberCaller(memory, transcript) {
  pushRecent(memory.recentCallerUtterances, transcript);
}

export function rememberAssistant(memory, transcript) {
  pushRecent(memory.recentAssistantUtterances, transcript);
}

export function callMemorySummary(memory) {
  const fields = Object.entries(memory.fieldAnswers)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n') || '- none recorded';
  return `CURRENT CALL STATE\nStage: ${memory.stage}\nLast question ID: ${memory.lastQuestionId || 'none'}\nLast question: ${memory.lastQuestionText || 'none'}\nCurrent field: ${memory.currentField || 'none'}\nEstimate offered: ${memory.estimateOfferCount} time(s)\nIntake cancelled: ${memory.intakeCancelled ? 'yes' : 'no'}\nLead saved: ${memory.leadSaved ? 'yes' : 'no'}\nRecorded field answers:\n${fields}\nRecent caller utterances:\n${memory.recentCallerUtterances.map((v) => `- ${v}`).join('\n') || '- none'}\nRecent assistant utterances:\n${memory.recentAssistantUtterances.map((v) => `- ${v}`).join('\n') || '- none'}\nTreat this server state as the source of truth. Return to the exact last unanswered question after any interruption.`;
}
