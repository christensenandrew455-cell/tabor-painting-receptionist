import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { Resend } from 'resend';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tabor-painting-receptionist-production.up.railway.app').replace(/\/$/, '');
const OWNER_EMAIL = process.env.OWNER_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || 'AI Receptionist <onboarding@resend.dev>';
const PHONE_PROVIDER = process.env.PHONE_PROVIDER || 'Telnyx TeXML';
const TELNYX_NUMBER = process.env.TELNYX_NUMBER || '';
const TELNYX_VOICE_WEBHOOK_PATH = process.env.TELNYX_VOICE_WEBHOOK_PATH || '/voice';
const TELNYX_SPEECH_WEBHOOK_PATH = process.env.TELNYX_SPEECH_WEBHOOK_PATH || '/handle-speech';
const TELNYX_STATUS_WEBHOOK_PATH = process.env.TELNYX_STATUS_WEBHOOK_PATH || '/call-status';
const TTS_VOICE = process.env.TTS_VOICE || 'Polly.Joanna-Neural';

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing. Railway is not passing it to this running service.');
  }

  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is missing. Railway is not passing it to this running service.');
  }

  return new Resend(process.env.RESEND_API_KEY);
}

function hasValue(value) {
  return Boolean(value && String(value).trim().length > 0);
}

// This is a simple in-memory store. It is okay for testing.
// Later, replace this with Google Sheets, Airtable, Supabase, or your CRM.
const calls = new Map();

const businessProfile = {
  name: process.env.BUSINESS_NAME || 'Tabor Painting',
  services:
    process.env.BUSINESS_SERVICES ||
    'interior painting, exterior painting, cabinet painting, drywall patching, staining, and small paint repairs',
  serviceArea: process.env.SERVICE_AREA || 'the local service area',
  hours: process.env.BUSINESS_HOURS || 'Monday through Friday, 8 AM to 5 PM',
  bookingRule:
    process.env.BOOKING_RULE ||
    'Collect the caller name, phone number, service needed, location, and preferred time. Do not promise an exact appointment. Say the owner will follow up to confirm.'
};

function getCall(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      messages: [],
      lead: {
        name: '',
        phone: '',
        service: '',
        location: '',
        preferredTime: '',
        summary: '',
        complete: false
      },
      emailed: false
    });
  }
  return calls.get(callSid);
}

function absoluteUrl(path) {
  return `${PUBLIC_URL}${path}`;
}

function xmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sendTexml(res, body) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`);
}

function sayTag(message) {
  return `<Say voice="${xmlEscape(TTS_VOICE)}" language="en-US">${xmlEscape(message)}</Say>`;
}

function sayAndGather(res, message) {
  sendTexml(
    res,
    `<Gather input="speech" action="${xmlEscape(absoluteUrl(TELNYX_SPEECH_WEBHOOK_PATH))}" speechTimeout="auto" timeout="6">${sayTag(
      message
    )}</Gather><Redirect method="POST">${xmlEscape(absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH))}</Redirect>`
  );
}

function endCall(res, message) {
  sendTexml(res, `${sayTag(message)}<Hangup />`);
}

function buildSystemPrompt() {
  return `You are the phone receptionist for ${businessProfile.name}.

Business info:
- Services: ${businessProfile.services}
- Service area: ${businessProfile.serviceArea}
- Hours: ${businessProfile.hours}
- Booking rule: ${businessProfile.bookingRule}

Your job:
1. Answer basic questions.
2. Collect lead details.
3. Keep replies short because this is a phone call.
4. Be friendly and natural.
5. Do not make up prices.
6. Do not promise exact availability.
7. If the caller asks for pricing, say the owner can give the best estimate after seeing the job details.
8. Once you have name, phone, service needed, location, and preferred time, politely end the call.

Return ONLY valid JSON in this exact shape:
{
  "reply": "what the receptionist should say next",
  "lead": {
    "name": "",
    "phone": "",
    "service": "",
    "location": "",
    "preferredTime": "",
    "summary": "",
    "complete": false
  },
  "shouldEndCall": false
}`;
}

async function getAiResponse(callState, userText, callerNumber) {
  const openai = getOpenAIClient();

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...callState.messages,
    {
      role: 'user',
      content: `Caller phone number from ${PHONE_PROVIDER}: ${callerNumber || 'unknown'}\nCaller said: ${userText}`
    }
  ];

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages,
    temperature: 0.4,
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);

  callState.messages.push({ role: 'user', content: userText });
  callState.messages.push({ role: 'assistant', content: parsed.reply });

  callState.lead = {
    ...callState.lead,
    ...parsed.lead
  };

  if (!callState.lead.phone && callerNumber) {
    callState.lead.phone = callerNumber;
  }

  return parsed;
}

async function sendLeadEmail(callSid, callState) {
  if (!OWNER_EMAIL || callState.emailed) return;

  const resend = getResendClient();
  const lead = callState.lead;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: OWNER_EMAIL,
    subject: `New AI receptionist lead - ${businessProfile.name}`,
    text: `New lead from ${businessProfile.name}\n\nName: ${lead.name || 'Not collected'}\nPhone: ${lead.phone || 'Not collected'}\nService: ${lead.service || 'Not collected'}\nLocation: ${lead.location || 'Not collected'}\nPreferred time: ${lead.preferredTime || 'Not collected'}\n\nSummary:\n${lead.summary || 'No summary'}\n\nCall ID: ${callSid}`
  });

  callState.emailed = true;
}

function getRequestValue(req, ...keys) {
  for (const key of keys) {
    if (req.body?.[key] !== undefined) return req.body[key];
    if (req.query?.[key] !== undefined) return req.query[key];
  }
  return '';
}

function getCallSid(req) {
  return (
    getRequestValue(req, 'CallSid', 'call_sid', 'callSid', 'call_control_id', 'call_id') ||
    `local-test-call-${Date.now()}`
  );
}

function getCallerNumber(req) {
  return getRequestValue(req, 'From', 'from', 'caller', 'caller_id_number', 'Caller') || '';
}

function getSpeech(req) {
  return getRequestValue(req, 'SpeechResult', 'speech_result', 'speech', 'transcript') || '';
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI receptionist backend is running on Telnyx TeXML.',
    phoneProvider: PHONE_PROVIDER,
    telnyxNumber: TELNYX_NUMBER || null,
    telnyxSetupUrl: absoluteUrl('/telnyx'),
    voiceWebhook: absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH),
    speechWebhook: absoluteUrl(TELNYX_SPEECH_WEBHOOK_PATH),
    callStatusWebhook: absoluteUrl(TELNYX_STATUS_WEBHOOK_PATH),
    debugEnvUrl: absoluteUrl('/debug-env')
  });
});

app.get('/telnyx', (req, res) => {
  res.json({
    provider: 'Telnyx TeXML',
    setup: [
      'Buy or use a Telnyx phone number.',
      'Create a Telnyx TeXML Application.',
      `Set the TeXML Application voice webhook URL to ${absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH)} with method POST.`,
      `Set the optional status callback URL to ${absoluteUrl(TELNYX_STATUS_WEBHOOK_PATH)} with method POST.`,
      'Assign the Telnyx number to that TeXML Application.',
      'Call the Telnyx number from another phone to test the receptionist.'
    ],
    voiceWebhook: absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH),
    speechWebhook: absoluteUrl(TELNYX_SPEECH_WEBHOOK_PATH),
    callStatusWebhook: absoluteUrl(TELNYX_STATUS_WEBHOOK_PATH)
  });
});

app.get('/debug-env', (req, res) => {
  // This does NOT show your secret keys. It only says whether Railway can see them.
  res.json({
    OPENAI_API_KEY: hasValue(process.env.OPENAI_API_KEY),
    RESEND_API_KEY: hasValue(process.env.RESEND_API_KEY),
    OWNER_EMAIL: hasValue(process.env.OWNER_EMAIL),
    PUBLIC_URL: PUBLIC_URL,
    BUSINESS_NAME: process.env.BUSINESS_NAME || businessProfile.name,
    PHONE_PROVIDER,
    TELNYX_NUMBER: hasValue(process.env.TELNYX_NUMBER),
    TTS_VOICE,
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    nodeEnv: process.env.NODE_ENV || null,
    port: PORT
  });
});

app.all(TELNYX_VOICE_WEBHOOK_PATH, (req, res) => {
  const callSid = getCallSid(req);
  const callState = getCall(callSid);

  if (callState.messages.length === 0) {
    return sayAndGather(
      res,
      `Thanks for calling ${businessProfile.name}. This is the virtual receptionist. How can I help you today?`
    );
  }

  return sayAndGather(res, 'Sorry, I did not catch that. Could you say that again?');
});

app.all(TELNYX_SPEECH_WEBHOOK_PATH, async (req, res) => {
  const callSid = getCallSid(req);
  const callerNumber = getCallerNumber(req);
  const speech = getSpeech(req);
  const callState = getCall(callSid);

  if (!String(speech).trim()) {
    return sayAndGather(res, 'Sorry, I did not hear anything. How can I help you today?');
  }

  try {
    const ai = await getAiResponse(callState, String(speech), callerNumber);

    if (callState.lead.complete || ai.shouldEndCall) {
      await sendLeadEmail(callSid, callState);
      return endCall(
        res,
        ai.reply ||
          'Perfect, I have what I need. I will pass this along and someone will follow up with you soon. Thanks for calling.'
      );
    }

    return sayAndGather(res, ai.reply || 'Got it. Could you tell me a little more?');
  } catch (error) {
    console.error('AI receptionist error:', error);
    return sayAndGather(
      res,
      'Sorry, I had a small issue on my end. Could you repeat that one more time?'
    );
  }
});

app.all(TELNYX_STATUS_WEBHOOK_PATH, async (req, res) => {
  const callSid = getCallSid(req);
  const callStatus = String(
    getRequestValue(req, 'CallStatus', 'call_status', 'callStatus', 'status', 'event_type') || ''
  ).toLowerCase();
  const callState = calls.get(callSid);

  if (callState && ['completed', 'hangup', 'call.hangup', 'done'].includes(callStatus)) {
    try {
      await sendLeadEmail(callSid, callState);
    } catch (error) {
      console.error('Failed to send end-of-call email:', error);
    }

    // Clean up memory after the call is done.
    calls.delete(callSid);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`AI receptionist server running on port ${PORT}`);
  console.log(`Telnyx voice webhook: ${absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH)}`);
  console.log(`Telnyx setup info: ${absoluteUrl('/telnyx')}`);
  console.log(`Debug env page: ${absoluteUrl('/debug-env')}`);
});
