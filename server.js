import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';
import { Resend } from 'resend';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio is only being used here to generate standard TwiML XML.
// Google Voice cannot call this webhook directly. Use Google Voice call forwarding
// to forward the Google Voice number into a webhook-capable phone provider.
const VoiceResponse = twilio.twiml.VoiceResponse;

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const OWNER_EMAIL = process.env.OWNER_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || 'AI Receptionist <onboarding@resend.dev>';
const PHONE_PROVIDER = process.env.PHONE_PROVIDER || 'Google Voice forwarding + webhook voice provider';
const GOOGLE_VOICE_NUMBER = process.env.GOOGLE_VOICE_NUMBER || '';

// Do NOT create OpenAI/Resend clients at startup.
// If a variable is missing, this lets the server still boot so we can debug Railway.
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

function sayAndGather(res, message) {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    action: '/handle-speech',
    method: 'POST',
    speechTimeout: 'auto',
    timeout: 6
  });

  gather.say(
    {
      voice: 'Polly.Joanna-Neural',
      language: 'en-US'
    },
    message
  );

  twiml.redirect({ method: 'POST' }, '/voice');
  res.type('text/xml').send(twiml.toString());
}

function endCall(res, message) {
  const twiml = new VoiceResponse();
  twiml.say(
    {
      voice: 'Polly.Joanna-Neural',
      language: 'en-US'
    },
    message
  );
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
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

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI receptionist backend is running.',
    phoneProvider: PHONE_PROVIDER,
    googleVoiceNumber: GOOGLE_VOICE_NUMBER || null,
    voiceWebhook: `${PUBLIC_URL}/voice`,
    callStatusWebhook: `${PUBLIC_URL}/call-status`,
    googleVoiceSetupUrl: `${PUBLIC_URL}/google-voice`,
    debugEnvUrl: `${PUBLIC_URL}/debug-env`
  });
});

app.get('/google-voice', (req, res) => {
  res.json({
    important: 'Google Voice does not provide an incoming-call webhook for this app to answer calls directly.',
    howToUseGoogleVoice: [
      'Keep your Google Voice number as the public business number.',
      'In Google Voice, forward calls from that number to a webhook-capable phone provider number.',
      'In that webhook-capable provider, point incoming calls to this Railway URL: ' + `${PUBLIC_URL}/voice`,
      'Set the optional status callback to: ' + `${PUBLIC_URL}/call-status`
    ],
    note: 'This app is ready for Google Voice as the front number, but Google Voice must forward calls to a provider that can hit the webhook.'
  });
});

app.get('/debug-env', (req, res) => {
  // This does NOT show your secret keys. It only says whether Railway can see them.
  res.json({
    OPENAI_API_KEY: hasValue(process.env.OPENAI_API_KEY),
    RESEND_API_KEY: hasValue(process.env.RESEND_API_KEY),
    OWNER_EMAIL: hasValue(process.env.OWNER_EMAIL),
    PUBLIC_URL: hasValue(process.env.PUBLIC_URL),
    BUSINESS_NAME: process.env.BUSINESS_NAME || businessProfile.name,
    PHONE_PROVIDER,
    GOOGLE_VOICE_NUMBER: hasValue(process.env.GOOGLE_VOICE_NUMBER),
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    nodeEnv: process.env.NODE_ENV || null,
    port: PORT
  });
});

app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || req.body.call_id || 'local-test-call';
  const callState = getCall(callSid);

  if (callState.messages.length === 0) {
    return sayAndGather(
      res,
      `Thanks for calling ${businessProfile.name}. This is the virtual receptionist. How can I help you today?`
    );
  }

  return sayAndGather(res, 'Sorry, I did not catch that. Could you say that again?');
});

app.post('/handle-speech', async (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || req.body.call_id || 'local-test-call';
  const callerNumber = req.body.From || req.body.from || req.body.caller || '';
  const speech = req.body.SpeechResult || req.body.speech || req.body.transcript || '';
  const callState = getCall(callSid);

  if (!speech.trim()) {
    return sayAndGather(res, 'Sorry, I did not hear anything. How can I help you today?');
  }

  try {
    const ai = await getAiResponse(callState, speech, callerNumber);

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

app.post('/call-status', async (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || req.body.call_id;
  const callStatus = req.body.CallStatus || req.body.callStatus || req.body.status;
  const callState = calls.get(callSid);

  if (callState && callStatus === 'completed') {
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
  console.log(`Voice webhook: ${PUBLIC_URL}/voice`);
  console.log(`Google Voice setup info: ${PUBLIC_URL}/google-voice`);
  console.log(`Debug env page: ${PUBLIC_URL}/debug-env`);
});
