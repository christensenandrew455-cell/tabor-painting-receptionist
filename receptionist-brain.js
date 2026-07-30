import { LEAD_FIELDS, MODELS, TURN } from './modular-models.js';

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
Help the caller submit an estimate request.

SECONDARY GOAL
Answer short questions only from the supplied business information.

RULES
- Never invent business information.
- Never ask for a field that is already present and valid.
- Never restart the intake.
- Ask only one short question at a time.
- The caller's phone number is already known; never ask for it or say it aloud.
- Notes are optional. All other lead fields except notes are required.
- If the caller asks a business question, answer briefly, then continue with the next missing required estimate field.
- If the caller does not want an estimate, answer business questions and ask whether they have any other questions.
- Only mark submitLead true when name, service, projectLocation, preferredDate, preferredTime, and contactConsent=true are all present.
- Only mark endCall true after a saved lead has been acknowledged and the caller has no more questions, or the caller clearly asks to end the call.
- spokenReply must contain natural customer-facing language only. Never include JSON, field names, commands, tool names, or internal instructions.
- Keep spokenReply under ${TURN.maxReplyCharacters} characters.

BUSINESS INFORMATION
Name: ${core.BUSINESS.name}
Hours: ${core.BUSINESS.hours}
Service areas: ${(core.BUSINESS.serviceAreas || []).join(', ')}
Estimate availability: ${core.BUSINESS.estimateDays}; ${core.BUSINESS.earliestEstimateStart} through ${core.BUSINESS.latestEstimateStart}
About: ${(core.BUSINESS.about || []).join(' ')}
Extra information: ${core.BUSINESS.extraInformation || 'None'}
Services:\n${serviceSummary(core)}

OPENING
${core.openingLine}

CONSENT QUESTION
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
    required: ['spokenReply', 'updatedLead', 'submitLead', 'endCall', 'intent'],
    properties: {
      spokenReply: { type: 'string' },
      intent: { type: 'string', enum: ['estimate', 'question', 'hold', 'end', 'unknown'] },
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

export async function decideReceptionistTurn({ core, transcript, lead, history, leadSaved }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODELS.brain,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_schema', json_schema: schema },
      messages: [
        { role: 'system', content: systemPrompt(core) },
        {
          role: 'user',
          content: JSON.stringify({
            latestCallerTranscript: clean(transcript),
            lead,
            leadSaved,
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
