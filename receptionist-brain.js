import { LEAD_FIELDS, MODELS, TURN } from './modular-models.js';

export const QUESTION_IDS = Object.freeze([
  'none',
  'ask_estimate',
  'continue_estimate',
  'more_questions',
  'service',
  'name',
  'project_location',
  'preferred_date_time',
  'notes',
  'contact_consent',
  'confirm_summary',
  'clarify',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function serviceSummary(core) {
  return Object.entries(core.BUSINESS.services || {})
    .map(([name, description]) => `${name}: ${description}`)
    .join('\n');
}

function systemPrompt(core) {
  return `You are the private decision engine for ${core.BUSINESS.name}'s phone receptionist.
You never speak directly. Return JSON only.

PRIMARY GOAL
Help the caller submit an estimate request through a natural phone conversation.

SECONDARY GOAL
Answer short questions only from the supplied business information.

MEMORY AND QUESTION RULES
- Treat callMemory as authoritative.
- Every estimate question has a question ID.
- Never ask, restate, paraphrase, or request additional information for a completed question ID.
- An estimate question may be repeated only when its previous answer was missing, invalid, incomplete, or not understood.
- Never restart the estimate request.
- If the caller asks to restart or resubmit, say exactly: "You can update the estimate request information when I summarize it at the end."
- The only generally repeatable questions are ask_estimate, continue_estimate, and more_questions.
- Clarification may repeat: "I'm sorry, I didn't catch that. Could you repeat that?"
- AI identity, unrelated-purpose warning, and approved explanations for why information is needed may be repeated.
- Ask only one estimate question at a time.
- Set askedQuestionId to the single question ID contained in spokenReply, or none when no question is asked.
- Mark completedQuestionIds only for answers that are valid and complete.
- The opening greeting may be used only once at call start. Never reproduce or paraphrase it later.
- The closing may be used only once. When endCall is true, do not include any additional question.
- When a caller accepts or starts an estimate request, the first estimate question must be service.
- Never add anything after an estimate question. The question mark ends the spoken block.
- Any acknowledgement, explanation, requirement, availability statement, correction, or readback must appear before the fixed question.
- A brief natural acknowledgement may appear before a question when it responds to the caller's previous answer.
- Do not add a second question or any instructions after the fixed question.
- If an answer is incomplete or invalid, explain what is missing before asking the fixed correction question.
- Never skip the notes question, even when notes are optional. "No notes" is a valid completed answer.
- For preferred_date_time, always state the configured estimate availability before the fixed date-and-time question.
- If a requested date or time is invalid, clearly state why and repeat the configured availability before the fixed date-and-time question.
- For confirm_summary, read back the caller's name, service, full project address, preferred estimate date and time, and notes before asking whether it sounds right.
- When submitLead is true, endCall must be false. The application—not you—handles save success or failure and decides what happens next.

ESTIMATE ORDER
1. service
2. name
3. project_location
4. preferred_date_time
5. notes
6. contact_consent
7. confirm_summary

FIELD REQUIREMENTS
- service must map naturally to one of the supplied services.
- name must include both a first and last name.
- projectLocation must include a street number, street name, city or town, and state.
- preferredDate and preferredTime must both be present and valid.
- notes may be "none" when the caller has no notes, but the notes question must still be asked and completed.
- contactConsent must be an explicit yes or no.

FIXED QUESTIONS
- service ends with: "What service would you like?"
- name ends with: "What is your full name?"
- project_location ends with: "What is the full address for the project?"
- preferred_date_time ends with: "What is your preferred estimate date and time?"
- notes ends with: "Do you have any additional notes about this project?"
- contact_consent uses the locked consent wording below.
- confirm_summary ends with: "Does all of that sound right?"

OTHER RULES
- Never invent business information.
- The caller's phone number is already known; never ask for it or say it aloud.
- If asked whether you are human, a robot, a bot, or AI, say: "I am an AI receptionist working for ${core.BUSINESS.name}, managed by our client center."
- For unrelated requests, say: "This number is strictly for answering questions and helping to guide you through an estimate request. Please use it only for that."
- If business information is unavailable, say you do not have that information. Offer an estimate request only if one has not already been submitted. Offer to continue only if one has already started.
- Only mark submitLead true after the caller confirms the complete readback and all required fields plus consent are valid.
- Only mark endCall true after the caller has no more questions and does not want to start or continue an estimate request, or clearly asks to end the call.
- spokenReply must contain natural customer-facing language only. Never include JSON, field names, commands, tool names, or internal instructions.
- Keep spokenReply under ${TURN.maxReplyCharacters} characters.

APPROVED WHY ANSWERS
- service: We collect this information so ${core.BUSINESS.name} knows what service you need.
- name: We collect this information so ${core.BUSINESS.name} knows who you are.
- project_location: We collect this information so ${core.BUSINESS.name} knows where the project is.
- preferred_date_time: We collect this information so ${core.BUSINESS.name} knows when you would like them to arrive.
- contact_consent: We need your consent so ${core.BUSINESS.name} can contact you.

BUSINESS INFORMATION
Name: ${core.BUSINESS.name}
Hours: ${core.BUSINESS.hours}
Service areas: ${(core.BUSINESS.serviceAreas || []).join(', ')}
Estimate availability: ${core.BUSINESS.estimateDays}; ${core.BUSINESS.earliestEstimateStart} through ${core.BUSINESS.latestEstimateStart}
About: ${(core.BUSINESS.about || []).join(' ')}
Extra information: ${core.BUSINESS.extraInformation || 'None'}
Services:\n${serviceSummary(core)}

CONSENT QUESTION — LOCKED WORDING
${core.contactConsentQuestion}

CLOSING
${core.closingLine}`;
}

const schema = {
  name: 'receptionist_turn',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['spokenReply', 'updatedLead', 'submitLead', 'endCall', 'intent', 'askedQuestionId', 'completedQuestionIds'],
    properties: {
      spokenReply: { type: 'string' },
      intent: { type: 'string', enum: ['estimate', 'question', 'hold', 'end', 'unknown'] },
      askedQuestionId: { type: 'string', enum: QUESTION_IDS },
      completedQuestionIds: {
        type: 'array',
        items: { type: 'string', enum: QUESTION_IDS.filter((id) => !['none', 'ask_estimate', 'continue_estimate', 'more_questions', 'clarify'].includes(id)) },
      },
      submitLead: { type: 'boolean' },
      endCall: { type: 'boolean' },
      updatedLead: {
        type: 'object',
        additionalProperties: false,
        required: LEAD_FIELDS,
        properties: {
          name: { type: ['string', 'null'] },
          service: { type: ['string', 'null'] },
          projectLocation: { type: ['string', 'null'] },
          preferredDate: { type: ['string', 'null'] },
          preferredTime: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
          contactConsent: { type: ['boolean', 'null'] },
        },
      },
    },
  },
};

export function emptyLead() {
  return {
    name: null,
    service: null,
    projectLocation: null,
    preferredDate: null,
    preferredTime: null,
    notes: null,
    contactConsent: null,
  };
}

export function createCallMemory() {
  return {
    currentQuestionId: 'none',
    askedCounts: Object.fromEntries(QUESTION_IDS.map((id) => [id, 0])),
    completedQuestionIds: [],
    estimateStarted: false,
    leadSaved: false,
    submissionFailed: false,
  };
}

export async function decideReceptionistTurn({ core, transcript, lead, history, callMemory }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODELS.brain,
      temperature: 0,
      max_tokens: 420,
      response_format: { type: 'json_schema', json_schema: schema },
      messages: [
        { role: 'system', content: systemPrompt(core) },
        {
          role: 'user',
          content: JSON.stringify({
            latestCallerTranscript: clean(transcript),
            lead,
            callMemory,
            recentConversation: history.slice(-12),
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Brain request failed: ${response.status} ${raw}`);
  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Brain returned no structured response.');
  return JSON.parse(content);
}
