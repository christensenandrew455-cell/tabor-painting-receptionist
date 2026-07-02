import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { Resend } from 'resend';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tabor-painting-receptionist-production.up.railway.app').replace(/\/$/, '');
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Tabor Painting';

// This server uses Telnyx TeXML <Gather>/<Say>. Telnyx handles the live speech-to-text
// and voice playback. OpenAI is only used as a fallback when fast logic cannot classify
// what the caller said, or when the caller asks a free-form question.
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const VOICE = process.env.TTS_VOICE || 'Polly.Joanna-Neural';
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'AI Receptionist <onboarding@resend.dev>';
const BUSINESS_SERVICES = process.env.BUSINESS_SERVICES || 'interior painting, exterior painting, staining, cabinet painting, drywall patching, and small paint repairs';
const SERVICE_AREA = process.env.SERVICE_AREA || 'the local service area';
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Monday through Friday, 8 AM to 5 PM';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const sessions = new Map();

function esc(x = '') {
  return String(x)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function val(req, ...keys) {
  for (const k of keys) {
    if (req.body?.[k] !== undefined) return req.body[k];
    if (req.query?.[k] !== undefined) return req.query[k];
  }
  return '';
}

function id(req) {
  return val(req, 'CallSid', 'callSid', 'call_id', 'CallControlId') || `local-${Date.now()}`;
}

function speech(req) {
  return val(req, 'SpeechResult', 'speech_result', 'speech', 'transcript', 'SpeechTranscript') || '';
}

function callerPhone(req) {
  return val(req, 'From', 'from', 'Caller', 'caller_id_number') || '';
}

function today() {
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

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function freshState() {
  return {
    step: 'yesNo',
    missed: 0,
    leadSent: false,
    transcript: [],
    lead: {
      name: '',
      phone: '',
      service: '',
      streetAddress: '',
      city: '',
      preferredDay: '',
      preferredTime: '',
      notes: '',
      question: '',
      complete: false
    }
  };
}

function state(callId) {
  if (!sessions.has(callId)) sessions.set(callId, freshState());
  return sessions.get(callId);
}

function promptFor(step) {
  return {
    yesNo: `Thanks for calling ${BUSINESS_NAME}. This is the AI receptionist. Are you calling to schedule an estimate? Please answer yes or no.`,
    name: 'Perfect. Can I have your name? Please say just your name.',
    service: 'What service do you need: interior painting, exterior painting, or staining?',
    streetAddress: 'What is the street address for the estimate? Please say the number and street name.',
    city: 'What city is that in?',
    preferredDay: 'What day works best for Jason to come take a look?',
    preferredTime: 'What time works best for the estimate?',
    notes: 'Briefly describe the room, wall, exterior area, or project that needs painting.',
    questions: 'Do you have any quick questions before I send this to Jason? Please answer yes or no.',
    questionDetail: 'Go ahead and ask your question.'
  }[step] || 'Perfect. Jason will follow up when he gets the chance to confirm the estimate. Thanks for calling. Goodbye.';
}

function nextStep(lead) {
  if (!lead.name) return 'name';
  if (!lead.service) return 'service';
  if (!lead.streetAddress) return 'streetAddress';
  if (!lead.city) return 'city';
  if (!lead.preferredDay) return 'preferredDay';
  if (!lead.preferredTime) return 'preferredTime';
  if (!lead.notes) return 'notes';
  return 'questions';
}

function timing(step, missed) {
  // Let people actually finish talking. Short menu answers stay snappy; address/notes get longer.
  const base = {
    yesNo: { timeout: 4, speechTimeout: 2 },
    name: { timeout: 5, speechTimeout: 2 },
    service: { timeout: 5, speechTimeout: 2 },
    streetAddress: { timeout: 7, speechTimeout: 3 },
    city: { timeout: 5, speechTimeout: 2 },
    preferredDay: { timeout: 6, speechTimeout: 2 },
    preferredTime: { timeout: 6, speechTimeout: 2 },
    notes: { timeout: 8, speechTimeout: 4 },
    questions: { timeout: 5, speechTimeout: 2 },
    questionDetail: { timeout: 8, speechTimeout: 4 }
  }[step] || { timeout: 6, speechTimeout: 2 };

  const bump = Math.min(Number(missed || 0), 2);
  return { timeout: String(base.timeout + bump), speechTimeout: String(base.speechTimeout + bump) };
}

function gather(text, s, step = s.step) {
  s.step = step;
  const tm = timing(step, s.missed);
  console.log('[GATHER]', { step, missed: s.missed, ...tm, text });
  return `<Gather input="speech" action="${esc(PUBLIC_URL + '/handle-speech')}" timeout="${esc(tm.timeout)}" speechTimeout="${esc(tm.speechTimeout)}">${say(text)}</Gather><Redirect method="POST">${esc(PUBLIC_URL + '/voice')}</Redirect>`;
}

function detectYesNo(text) {
  const t = normalize(text);
  const no = /\b(no|nope|nah|not right now|not today|don't|do not|just calling|wrong number)\b/.test(t);
  const yes = /\b(yes|yeah|yep|yup|sure|correct|that's right|that is right|i am|i do|please|schedule|estimate|appointment)\b/.test(t);
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return '';
}

function detectService(text) {
  const t = normalize(text);
  if (/\b(interior|inside|indoor|room|bedroom|bathroom|kitchen|living room|wall|walls|ceiling|trim|baseboard|cabinet|cabinets)\b/.test(t)) return 'interior painting';
  if (/\b(exterior|outside|outdoor|siding|house outside|garage|fence|porch|deck|shutters|front door)\b/.test(t)) return 'exterior painting';
  if (/\b(stain|staining|deck stain|wood stain|fence stain)\b/.test(t)) return 'staining';
  if (/\b(drywall|patch|repair|hole|holes)\b/.test(t)) return 'drywall patching and painting';
  if (/\b(paint|painting|painted|painter)\b/.test(t)) return 'painting estimate';
  return '';
}

function extractStreetAddress(text) {
  const raw = String(text).trim().replace(/\s+/g, ' ');
  const suffix = '(street|st|road|rd|drive|dr|lane|ln|avenue|ave|circle|cir|court|ct|way|boulevard|blvd|terrace|ter|place|pl|highway|hwy|parkway|pkwy)';
  const match = raw.match(new RegExp(`\\b\\d{1,6}\\s+[A-Za-z0-9 .'-]{2,60}\\s+${suffix}\\b`, 'i'));
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function cleanShortAnswer(text) {
  return String(text)
    .replace(/^(my name is|name is|it's|it is|this is|i am|i'm)\s+/i, '')
    .trim();
}

function applyFastLogic(step, text, s) {
  const lead = s.lead;
  const t = String(text).trim();
  const n = normalize(t);

  if (step === 'yesNo') {
    const yn = detectYesNo(t);
    if (yn === 'yes') return { handled: true, reply: promptFor('name'), next: 'name' };
    if (yn === 'no') return { handled: true, done: true, reply: `No problem. Thanks for calling ${BUSINESS_NAME}. Goodbye.` };
    return { handled: false };
  }

  if (step === 'name') {
    const name = cleanShortAnswer(t);
    if (name && name.split(' ').length <= 5 && !/\d/.test(name)) {
      lead.name = name;
      const next = nextStep(lead);
      return { handled: true, reply: promptFor(next), next };
    }
    return { handled: false };
  }

  if (step === 'service') {
    const service = detectService(t);
    if (service) {
      lead.service = service;
      const next = nextStep(lead);
      return { handled: true, reply: promptFor(next), next };
    }
    return { handled: false };
  }

  if (step === 'streetAddress') {
    const address = extractStreetAddress(t);
    if (address) {
      lead.streetAddress = address;
      const next = nextStep(lead);
      return { handled: true, reply: promptFor(next), next };
    }
    return { handled: false };
  }

  if (step === 'city') {
    const city = cleanShortAnswer(t);
    if (city && city.length >= 2 && city.length <= 50 && !/\d/.test(city)) {
      lead.city = city;
      const next = nextStep(lead);
      return { handled: true, reply: promptFor(next), next };
    }
    return { handled: false };
  }

  if (step === 'preferredDay') {
    if (/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|weekend|\d{1,2}[/-]\d{1,2})\b/.test(n)) {
      lead.preferredDay = t;
      const next = nextStep(lead);
      return { handled: true, reply: promptFor(next), next };
    }
    return { handled: false };
  }

  if (step === 'preferredTime') {
    if (/\b(\d{1,2}(:\d{2})?\s*(am|pm)?|morning|afternoon|evening|noon|anytime|after|before)\b/.test(n)) {
      lead.preferredTime = t;
      const next = nextStep(lead);
      return { handled: true, reply: promptFor(next), next };
    }
    return { handled: false };
  }

  if (step === 'notes') {
    if (t.length >= 3) {
      lead.notes = t;
      const next = nextStep(lead);
      return { handled: true, reply: promptFor(next), next };
    }
    return { handled: false };
  }

  if (step === 'questions') {
    const yn = detectYesNo(t);
    if (yn === 'no') return { handled: true, complete: true, reply: finalMessage() };
    if (yn === 'yes') return { handled: true, reply: promptFor('questionDetail'), next: 'questionDetail' };
    if (t.length > 8) return { handled: false, question: t };
    return { handled: false };
  }

  return { handled: false };
}

function jsonOnly(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  return a >= 0 && b >= 0 ? text.slice(a, b + 1) : '{}';
}

async function aiExtract(step, text, s) {
  if (!openai) return null;
  const response = await openai.chat.completions.create({
    model: FALLBACK_MODEL,
    temperature: 0,
    max_tokens: 180,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You extract one field for a painting estimate phone call. Today is ${today()} in Massachusetts. Current step: ${step}. Return only JSON: {"value":"", "service":"", "isQuestion":false, "question":""}. Services are interior painting, exterior painting, staining, drywall patching, cabinet painting. If the caller is asking a business question, set isQuestion true.`
      },
      { role: 'user', content: text }
    ]
  });

  try {
    return JSON.parse(jsonOnly(response.choices[0]?.message?.content || '{}'));
  } catch {
    return null;
  }
}

async function answerQuestion(question) {
  const fallback = `It depends on the size and condition of the area, but Jason will take a look and give you the time and price. ${promptFor('questions')}`;
  if (!openai) return fallback;

  const response = await openai.chat.completions.create({
    model: FALLBACK_MODEL,
    temperature: 0.2,
    max_tokens: 110,
    messages: [
      {
        role: 'system',
        content: `You are the receptionist for ${BUSINESS_NAME}. Keep the answer brief and practical. Do not quote exact prices. Do not promise appointment availability. Business services: ${BUSINESS_SERVICES}. Service area: ${SERVICE_AREA}. Hours: ${BUSINESS_HOURS}. Always steer back to Jason confirming after he reviews the estimate request.`
      },
      { role: 'user', content: question }
    ]
  });

  const answer = response.choices[0]?.message?.content?.trim() || fallback;
  return `${answer} ${promptFor('questions')}`;
}

async function fallbackLogic(step, text, s) {
  if (step === 'questionDetail') {
    s.lead.question = [s.lead.question, text].filter(Boolean).join(' | ');
    return { reply: await answerQuestion(text), next: 'questions' };
  }

  const extracted = await aiExtract(step, text, s);
  if (!extracted) return { reply: `Sorry, I did not catch that. ${promptFor(step)}`, next: step };

  if (extracted.isQuestion || extracted.question) {
    const q = extracted.question || text;
    s.lead.question = [s.lead.question, q].filter(Boolean).join(' | ');
    return { reply: await answerQuestion(q), next: 'questions' };
  }

  const value = String(extracted.value || extracted.service || '').trim();
  if (!value) return { reply: `Sorry, I did not catch that. ${promptFor(step)}`, next: step };

  if (step === 'name') s.lead.name = value;
  if (step === 'service') s.lead.service = extracted.service || value;
  if (step === 'streetAddress') s.lead.streetAddress = value;
  if (step === 'city') s.lead.city = value;
  if (step === 'preferredDay') s.lead.preferredDay = value;
  if (step === 'preferredTime') s.lead.preferredTime = value;
  if (step === 'notes') s.lead.notes = value;

  const next = nextStep(s.lead);
  return { reply: promptFor(next), next };
}

function finalMessage() {
  return 'Perfect. Jason will follow up when he gets the chance to confirm the estimate. Thanks for calling. Goodbye.';
}

function leadEmailText(s) {
  const lead = s.lead;
  return [
    `New ${BUSINESS_NAME} estimate request`,
    '',
    `Name: ${lead.name || 'Not provided'}`,
    `Phone: ${lead.phone || 'Not provided'}`,
    `Service: ${lead.service || 'Not provided'}`,
    `Street address: ${lead.streetAddress || 'Not provided'}`,
    `City: ${lead.city || 'Not provided'}`,
    `Preferred day: ${lead.preferredDay || 'Not provided'}`,
    `Preferred time: ${lead.preferredTime || 'Not provided'}`,
    `Notes: ${lead.notes || 'Not provided'}`,
    `Questions: ${lead.question || 'None'}`,
    '',
    'Transcript:',
    ...s.transcript.map((x) => `${x.role}: ${x.text}`)
  ].join('\n');
}

async function sendLead(s) {
  if (s.leadSent) return;
  s.leadSent = true;

  if (!resend || !OWNER_EMAIL) {
    console.log('[LEAD complete - email not configured]', s.lead);
    return;
  }

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: OWNER_EMAIL,
      subject: `New ${BUSINESS_NAME} estimate request: ${s.lead.name || 'Caller'}`,
      text: leadEmailText(s)
    });
    console.log('[LEAD email sent]', s.lead);
  } catch (e) {
    console.error('[LEAD email failed]', e);
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    mode: 'fast-scripted-gather',
    today: today(),
    fallbackModel: FALLBACK_MODEL,
    voice: VOICE
  });
});

app.get('/debug-env', (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    hasOwnerEmail: Boolean(OWNER_EMAIL),
    publicUrl: PUBLIC_URL,
    businessName: BUSINESS_NAME,
    fallbackModel: FALLBACK_MODEL,
    voice: VOICE
  });
});

app.get('/telnyx', (req, res) => {
  res.json({
    voiceWebhook: `${PUBLIC_URL}/voice`,
    speechWebhook: `${PUBLIC_URL}/handle-speech`,
    statusWebhook: `${PUBLIC_URL}/call-status`,
    method: 'POST'
  });
});

app.all('/voice', (req, res) => {
  const call = id(req);
  const s = state(call);
  if (!s.lead.phone) s.lead.phone = callerPhone(req);

  console.log(`[CALL ${call}] voice`, { step: s.step, missed: s.missed });

  if (s.transcript.length === 0) {
    return xml(res, gather(promptFor('yesNo'), s, 'yesNo'));
  }

  s.missed += 1;
  return xml(res, gather(`Sorry, I did not hear that clearly. I will give you a little more time. ${promptFor(s.step)}`, s, s.step));
});

app.all('/handle-speech', async (req, res) => {
  const call = id(req);
  const s = state(call);
  if (!s.lead.phone) s.lead.phone = callerPhone(req);

  const text = String(speech(req)).trim();
  console.log(`[CALL ${call}] speech`, { text, step: s.step });

  if (!text) {
    s.missed += 1;
    return xml(res, gather(`Sorry, I did not hear that clearly. I will give you a little more time. ${promptFor(s.step)}`, s, s.step));
  }

  s.missed = 0;
  s.transcript.push({ role: 'caller', text });

  try {
    const fast = applyFastLogic(s.step, text, s);

    if (fast.handled) {
      if (fast.done || fast.complete) {
        s.lead.complete = true;
        s.transcript.push({ role: 'assistant', text: fast.reply });
        await sendLead(s);
        return xml(res, `${say(fast.reply)}<Hangup />`);
      }

      s.transcript.push({ role: 'assistant', text: fast.reply });
      return xml(res, gather(fast.reply, s, fast.next));
    }

    const fallback = await fallbackLogic(s.step, text, s);
    s.transcript.push({ role: 'assistant', text: fallback.reply });

    if (nextStep(s.lead) === 'questions' && fallback.next === 'questions') {
      return xml(res, gather(fallback.reply, s, 'questions'));
    }

    return xml(res, gather(fallback.reply, s, fallback.next || s.step));
  } catch (e) {
    console.error(`[CALL ${call}] error`, e);
    s.missed += 1;
    return xml(res, gather(`Sorry, I had a small issue. ${promptFor(s.step)}`, s, s.step));
  }
});

app.all('/call-status', (req, res) => {
  const call = id(req);
  const status = val(req, 'CallStatus', 'status', 'event_type');
  console.log(`[CALL ${call}] status`, { status });
  if (String(status).toLowerCase().includes('hangup') || String(status).toLowerCase().includes('complete')) sessions.delete(call);
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => console.log(`AI receptionist fast-scripted-gather running on ${PORT}`));
