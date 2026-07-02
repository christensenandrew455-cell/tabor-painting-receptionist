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

function say(text) {
  return `<Say voice="${esc(VOICE)}" language="en-US">${esc(text)}</Say>`;
}

function gather(text) {
  return `<Gather input="speech" action="${esc(PUBLIC_URL + '/handle-speech')}" timeout="6" speechTimeout="2">${say(text)}</Gather><Redirect method="POST">${esc(PUBLIC_URL + '/voice')}</Redirect>`;
}

function xml(res, body) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function state(callId) {
  if (!sessions.has(callId)) sessions.set(callId, []);
  return sessions.get(callId);
}

async function reply(callId, text) {
  if (!process.env.OPENAI_API_KEY) return `I heard: ${text}. What is your name?`;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const history = state(callId);
  const messages = [
    { role: 'system', content: `You are a brief virtual receptionist for ${BUSINESS_NAME}. Ask one question at a time. Collect name, job needed, location, and preferred time. Keep replies under two sentences.` },
    ...history,
    { role: 'user', content: text }
  ];
  const r = await client.chat.completions.create({ model: MODEL, messages, temperature: 0.3, max_tokens: 90 });
  const answer = r.choices[0]?.message?.content || 'Got it. Can you tell me a little more?';
  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: answer });
  return answer;
}

app.get('/', (req, res) => res.json({ ok: true, mode: 'gather', voice: PUBLIC_URL + '/voice', speech: PUBLIC_URL + '/handle-speech' }));

app.get('/debug-env', (req, res) => res.json({ OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY), PUBLIC_URL, BUSINESS_NAME, MODEL, PORT }));

app.all('/voice', (req, res) => {
  const callId = id(req);
  console.log(`[CALL ${callId}] voice`, { method: req.method });
  xml(res, gather(`Thanks for calling ${BUSINESS_NAME}. This is the virtual receptionist. How can I help you today?`));
});

app.all('/handle-speech', async (req, res) => {
  const callId = id(req);
  const text = String(speech(req)).trim();
  console.log(`[CALL ${callId}] speech`, { method: req.method, text, bodyKeys: Object.keys(req.body || {}).join(',') });
  if (!text) return xml(res, gather('Sorry, I did not hear that clearly. Can you say it again?'));
  try {
    const answer = await reply(callId, text);
    console.log(`[CALL ${callId}] answer`, { answer });
    return xml(res, gather(answer));
  } catch (e) {
    console.error(`[CALL ${callId}] error`, e);
    return xml(res, gather('Sorry, I had a small issue. Can you say that again?'));
  }
});

app.all('/call-status', (req, res) => {
  const callId = id(req);
  console.log(`[CALL ${callId}] status`, { status: val(req, 'CallStatus', 'status', 'event_type') });
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI receptionist running on ${PORT}`);
  console.log(`Mode gather`);
});