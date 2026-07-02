import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tabor-painting-receptionist-production.up.railway.app').replace(/\/$/, '');
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Tabor Painting';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const VOICE = process.env.TTS_VOICE || 'Polly.Joanna-Neural';
const DEFAULT_GATHER_TIMEOUT = process.env.GATHER_TIMEOUT || '4';
const DEFAULT_SPEECH_TIMEOUT = process.env.GATHER_SPEECH_TIMEOUT || '1';

const sessions = new Map();

function esc(x = '') {
  return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function val(req, ...keys) {
  for (const k of keys) {
    if (req.body?.[k] !== undefined) return req.body[k];
    if (req.query?.[k] !== undefined) return req.query[k];
  }
  return '';
}

function callId(req) {
  return val(req, 'CallSid', 'callSid', 'call_id') || `local-${Date.now()}`;
}

function callerNumber(req) {
  return val(req, 'From', 'from', 'caller', 'Caller') || '';
}

function speech(req) {
  return val(req, 'SpeechResult', 'speech_result', 'speech', 'transcript', 'SpeechTranscript') || '';
}

function todayText() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(new Date());
}

function say(text) {
  return `<Say voice="${esc(VOICE)}" language="en-US">${esc(text)}</Say>`;
}

function xml(res, body) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function newSession() {
  return {
    history: [],
    missedCount: 0,
    lastAskedField: '',
    lead: {
      name: '',
      service: '',
      streetAddress: '',
      city: '',
      zip: '',
      preferredDay: '',
      preferredTime: '',
      notes: '',
      complete: false
    }
  };
}

function state(id) {
  if (!sessions.has(id)) sessions.set(id, newSession());
  return sessions.get(id);
}

function missingField(lead) {
  if (!lead.name) return 'name';
  if (!lead.service) return 'service';
  if (!lead.streetAddress) return 'streetAddress';
  if (!lead.city) return 'city';
  if (!lead.preferredDay) return 'preferredDay';
  if (!lead.preferredTime) return 'preferredTime';
  if (!lead.notes) return 'notes';
  return '';
}

function fallbackQuestion(field) {
  const questions = {
    yesNo: 'Are you calling to schedule an estimate? Please answer yes or no.',
    name: 'Can I have your name? Please say just your name.',
    service: 'What painting work do you need an estimate for?',
    streetAddress: 'What is the street address for the estimate? Please say just the street address.',
    city: 'What city is that in? Please say just the city.',
    preferredDay: 'What day works best for Jason to come take a look?',
    preferredTime: 'What time works best for the estimate? Please say just the time.',
    notes: 'Briefly describe the room or area that needs painting.'
  };
  return questions[field] || 'Perfect, I have the details. Jason will follow up to confirm the estimate appointment.';
}

function timingForField(field, missedCount = 0) {
  const base = {
    yesNo: { timeout: 3, speechTimeout: 1 },
    name: { timeout: 4, speechTimeout: 1 },
    streetAddress: { timeout: 5, speechTimeout: 1 },
    city: { timeout: 4, speechTimeout: 1 },
    preferredTime: { timeout: 4, speechTimeout: 1 },
    preferredDay: { timeout: 5, speechTimeout: 1 },
    service: { timeout: 7, speechTimeout: 2 },
    notes: { timeout: 9, speechTimeout: 2 }
  }[field] || { timeout: Number(DEFAULT_GATHER_TIMEOUT), speechTimeout: Number(DEFAULT_SPEECH_TIMEOUT) };

  const bump = Math.min(Number(missedCount || 0), 2);
  return {
    timeout: String(base.timeout + bump * 2),
    speechTimeout: String(base.speechTimeout + bump)
  };
}

function detectAskedField(text, session) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('yes or no') || lower.includes('schedule an estimate')) return 'yesNo';
  if (lower.includes('your name')) return 'name';
  if (lower.includes('street address')) return 'streetAddress';
  if (lower.includes('what city')) return 'city';
  if (lower.includes('what day')) return 'preferredDay';
  if (lower.includes('what time')) return 'preferredTime';
  if (lower.includes('describe') || lower.includes('room or area')) return 'notes';
  if (lower.includes('painting work') || lower.includes('estimate for')) return 'service';
  return missingField(session.lead) || 'notes';
}

function gather(text, session, fieldOverride = '') {
  const field = fieldOverride || detectAskedField(text, session);
  session.lastAskedField = field;
  const timing = timingForField(field, session.missedCount);
  console.log('[GATHER timing]', { field, missedCount: session.missedCount, ...timing, text });
  return `<Gather input="speech" action="${esc(PUBLIC_URL + '/handle-speech')}" timeout="${esc(timing.timeout)}" speechTimeout="${esc(timing.speechTimeout)}">${say(text)}</Gather><Redirect method="POST">${esc(PUBLIC_URL + '/voice')}</Redirect>`;
}

function cleanJson(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1) return '{}';
  return text.slice(first, last + 1);
}

function systemPrompt(session) {
  return `You are the virtual receptionist for ${BUSINESS_NAME}.
Today is ${todayText()} in Massachusetts.

Goal: book an estimate appointment for Jason to come to the customer's house and look at the painting job. Do not act like you are booking the actual painting job.

Collect these exact fields in this order:
1. name
2. service
3. streetAddress
4. city
5. zip, only if caller naturally gives it; do not force zip before moving on
6. preferredDay
7. preferredTime
8. notes

Important wording rules:
- Ask ONE question at a time.
- For short fields, tell callers to answer briefly, like "Please say just your name" or "Please say just the street address".
- Say "street address" or "city". Do NOT say "where is the room located" or "where is your living room located".
- If caller says a room like living room, bedroom, kitchen, or hallway, that is service/notes, not the address.
- If caller gives only a city, keep it as city and still ask for the street address.
- If caller gives a relative day like tomorrow, Saturday, next Tuesday, or the 8th, interpret it using today's date when possible and store the clearest version.
- Keep replies short, natural, and under two sentences.
- If enough details are collected, confirm the details briefly, ask if they have any questions, and say Jason will follow up to confirm the estimate appointment.

Current lead JSON:
${JSON.stringify(session.lead)}

Return ONLY valid JSON:
{
  "reply": "what the receptionist says next",
  "lead": {
    "name": "",
    "service": "",
    "streetAddress": "",
    "city": "",
    "zip": "",
    "preferredDay": "",
    "preferredTime": "",
    "notes": "",
    "complete": false
  }
}`;
}

async function reply(id, text, fromNumber) {
  const s = state(id);

  if (!process.env.OPENAI_API_KEY) {
    const field = missingField(s.lead);
    return fallbackQuestion(field);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const messages = [
    { role: 'system', content: systemPrompt(s) },
    ...s.history,
    { role: 'user', content: `Caller phone from caller ID: ${fromNumber || 'unknown'}\nCaller said: ${text}` }
  ];

  const r = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 180,
    response_format: { type: 'json_object' }
  });

  const raw = r.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(cleanJson(raw));
  } catch {
    const field = missingField(s.lead);
    parsed = { reply: fallbackQuestion(field), lead: s.lead };
  }

  s.lead = { ...s.lead, ...(parsed.lead || {}) };
  if (!s.lead.complete && !missingField(s.lead)) s.lead.complete = true;

  let answer = parsed.reply || fallbackQuestion(missingField(s.lead));

  const nextMissing = missingField(s.lead);
  if (!s.lead.complete && nextMissing && answer.toLowerCase().includes('where is')) {
    answer = fallbackQuestion(nextMissing);
  }

  s.history.push({ role: 'user', content: text });
  s.history.push({ role: 'assistant', content: answer });

  console.log(`[CALL ${id}] lead`, s.lead);
  return answer;
}

app.get('/', (req, res) => res.json({
  ok: true,
  mode: 'gather-checklist-adaptive',
  voice: PUBLIC_URL + '/voice',
  speech: PUBLIC_URL + '/handle-speech',
  today: todayText()
}));

app.get('/debug-env', (req, res) => res.json({
  OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
  PUBLIC_URL,
  BUSINESS_NAME,
  MODEL,
  DEFAULT_GATHER_TIMEOUT,
  DEFAULT_SPEECH_TIMEOUT,
  today: todayText(),
  PORT
}));

app.all('/voice', (req, res) => {
  const id = callId(req);
  const s = state(id);
  console.log(`[CALL ${id}] voice`, { method: req.method, complete: s.lead.complete, missedCount: s.missedCount });

  if (s.history.length === 0) {
    const intro = `Thanks for calling ${BUSINESS_NAME}. This is the AI receptionist. It may take a second after you finish talking. Are you calling to schedule an estimate? Please answer yes or no.`;
    return xml(res, gather(intro, s, 'yesNo'));
  }

  s.missedCount += 1;
  const field = missingField(s.lead) || s.lastAskedField || 'notes';
  return xml(res, gather('Sorry, I did not hear that clearly. I will give you a little more time. ' + fallbackQuestion(field), s, field));
});

app.all('/handle-speech', async (req, res) => {
  const id = callId(req);
  const text = String(speech(req)).trim();
  const from = callerNumber(req);
  const s = state(id);

  console.log(`[CALL ${id}] speech`, {
    method: req.method,
    text,
    lastAskedField: s.lastAskedField,
    bodyKeys: Object.keys(req.body || {}).join(',')
  });

  if (!text) {
    s.missedCount += 1;
    const field = missingField(s.lead) || s.lastAskedField || 'notes';
    return xml(res, gather('Sorry, I did not hear that clearly. I will give you a little more time. ' + fallbackQuestion(field), s, field));
  }

  s.missedCount = 0;

  try {
    const answer = await reply(id, text, from);
    console.log(`[CALL ${id}] answer`, { answer });

    if (state(id).lead.complete) {
      return xml(res, `${say(answer)}<Hangup />`);
    }

    const nextField = missingField(state(id).lead) || detectAskedField(answer, state(id));
    return xml(res, gather(answer, state(id), nextField));
  } catch (e) {
    console.error(`[CALL ${id}] error`, e);
    s.missedCount += 1;
    const field = missingField(s.lead) || s.lastAskedField || 'notes';
    return xml(res, gather('Sorry, I had a small issue. I will give you a little more time. ' + fallbackQuestion(field), s, field));
  }
});

app.all('/call-status', (req, res) => {
  const id = callId(req);
  const status = val(req, 'CallStatus', 'status', 'event_type');
  console.log(`[CALL ${id}] status`, { status });
  if (String(status).toLowerCase().includes('hangup') || String(status).toLowerCase().includes('complete')) sessions.delete(id);
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI receptionist running on ${PORT}`);
  console.log(`Mode: gather-checklist-adaptive`);
  console.log(`Today: ${todayText()}`);
});