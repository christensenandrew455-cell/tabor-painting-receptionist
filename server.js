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

function id(req) {
  return val(req, 'CallSid', 'callSid', 'call_id') || `local-${Date.now()}`;
}

function speech(req) {
  return val(req, 'SpeechResult', 'speech_result', 'speech', 'transcript', 'SpeechTranscript') || '';
}

function today() {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
}

function say(text) {
  return `<Say voice="${esc(VOICE)}" language="en-US">${esc(text)}</Say>`;
}

function xml(res, body) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function freshState() {
  return { history: [], missed: 0, lastField: 'yesNo', lead: { name: '', service: '', streetAddress: '', city: '', preferredDay: '', preferredTime: '', notes: '', complete: false } };
}

function state(callId) {
  if (!sessions.has(callId)) sessions.set(callId, freshState());
  return sessions.get(callId);
}

function missing(lead) {
  if (!lead.name) return 'name';
  if (!lead.service) return 'service';
  if (!lead.streetAddress) return 'streetAddress';
  if (!lead.city) return 'city';
  if (!lead.preferredDay) return 'preferredDay';
  if (!lead.preferredTime) return 'preferredTime';
  if (!lead.notes) return 'notes';
  return '';
}

function promptFor(field) {
  return {
    yesNo: 'Are you calling to schedule an estimate? Please answer yes or no.',
    name: 'Can I have your name? Please say just your name.',
    service: 'What painting work do you need an estimate for?',
    streetAddress: 'What is the street address for the estimate? Please say just the street address.',
    city: 'What city is that in? Please say just the city.',
    preferredDay: 'What day works best for Jason to come take a look?',
    preferredTime: 'What time works best for the estimate? Please say just the time.',
    notes: 'Briefly describe the room or area that needs painting.'
  }[field] || 'Perfect, Jason will follow up to confirm the estimate appointment.';
}

function detectField(text, s) {
  const t = String(text).toLowerCase();
  if (t.includes('yes or no') || t.includes('schedule an estimate')) return 'yesNo';
  if (t.includes('your name')) return 'name';
  if (t.includes('street address')) return 'streetAddress';
  if (t.includes('what city')) return 'city';
  if (t.includes('what day')) return 'preferredDay';
  if (t.includes('what time')) return 'preferredTime';
  if (t.includes('describe') || t.includes('room or area')) return 'notes';
  if (t.includes('painting work') || t.includes('estimate for')) return 'service';
  return missing(s.lead) || 'notes';
}

function timing(field, missed) {
  const speechTimeout = field === 'service' || field === 'notes' ? 2 : 1;
  const bump = Math.min(Number(missed || 0), 2);
  return { timeout: String(2 + bump), speechTimeout: String(speechTimeout + bump) };
}

function gather(text, s, field = '') {
  const f = field || detectField(text, s);
  s.lastField = f;
  const tm = timing(f, s.missed);
  console.log('[GATHER timing]', { field: f, missed: s.missed, ...tm, text });
  return `<Gather input="speech" action="${esc(PUBLIC_URL + '/handle-speech')}" timeout="${esc(tm.timeout)}" speechTimeout="${esc(tm.speechTimeout)}">${say(text)}</Gather><Redirect method="POST">${esc(PUBLIC_URL + '/voice')}</Redirect>`;
}

function jsonOnly(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  return a >= 0 && b >= 0 ? text.slice(a, b + 1) : '{}';
}

function system(s) {
  return `You are the virtual receptionist for ${BUSINESS_NAME}. Today is ${today()} in Massachusetts. You are booking an estimate appointment for Jason to look at a painting job. Collect in order: name, service, streetAddress, city, preferredDay, preferredTime, notes. Ask one question at a time. Use the words street address and city. Never ask where a living room is located. Interpret relative dates using today's date. Keep replies under two sentences. Current lead: ${JSON.stringify(s.lead)}. Return only JSON with reply and lead.`;
}

async function getReply(callId, text) {
  const s = state(callId);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const r = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: system(s) }, ...s.history, { role: 'user', content: text }],
    temperature: 0.2,
    max_tokens: 160,
    response_format: { type: 'json_object' }
  });
  let parsed;
  try { parsed = JSON.parse(jsonOnly(r.choices[0]?.message?.content || '{}')); } catch { parsed = { reply: promptFor(missing(s.lead)), lead: s.lead }; }
  s.lead = { ...s.lead, ...(parsed.lead || {}) };
  if (!missing(s.lead)) s.lead.complete = true;
  const answer = parsed.reply || promptFor(missing(s.lead));
  s.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
  console.log(`[CALL ${callId}] lead`, s.lead);
  return answer;
}

app.get('/', (req, res) => res.json({ ok: true, mode: 'fast-gather', today: today() }));

app.all('/voice', (req, res) => {
  const call = id(req);
  const s = state(call);
  console.log(`[CALL ${call}] voice`, { missed: s.missed });
  if (s.history.length === 0) return xml(res, gather(`Thanks for calling ${BUSINESS_NAME}. This is the AI receptionist. It may take a moment for me to respond after you finish speaking. Are you calling to schedule an estimate? Please answer yes or no.`, s, 'yesNo'));
  s.missed += 1;
  return xml(res, gather('Sorry, I did not hear that clearly. I will give you a little more time. ' + promptFor(missing(s.lead) || s.lastField), s, missing(s.lead) || s.lastField));
});

app.all('/handle-speech', async (req, res) => {
  const call = id(req);
  const s = state(call);
  const text = String(speech(req)).trim();
  console.log(`[CALL ${call}] speech`, { text, lastField: s.lastField });
  if (!text) {
    s.missed += 1;
    return xml(res, gather('Sorry, I did not hear that clearly. I will give you a little more time. ' + promptFor(missing(s.lead) || s.lastField), s, missing(s.lead) || s.lastField));
  }
  s.missed = 0;
  try {
    const answer = await getReply(call, text);
    if (s.lead.complete) return xml(res, `${say(answer)}<Hangup />`);
    return xml(res, gather(answer, s, missing(s.lead) || detectField(answer, s)));
  } catch (e) {
    console.error(`[CALL ${call}] error`, e);
    s.missed += 1;
    return xml(res, gather('Sorry, I had a small issue. I will give you a little more time. ' + promptFor(missing(s.lead) || s.lastField), s, missing(s.lead) || s.lastField));
  }
});

app.all('/call-status', (req, res) => {
  const call = id(req);
  const status = val(req, 'CallStatus', 'status', 'event_type');
  console.log(`[CALL ${call}] status`, { status });
  if (String(status).toLowerCase().includes('hangup') || String(status).toLowerCase().includes('complete')) sessions.delete(call);
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => console.log(`AI receptionist fast-gather running on ${PORT}`));