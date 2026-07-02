import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
const TELNYX_NUMBER = process.env.TELNYX_NUMBER || '17742316164';
const TELNYX_VOICE_WEBHOOK_PATH = process.env.TELNYX_VOICE_WEBHOOK_PATH || '/voice';
const TELNYX_SPEECH_WEBHOOK_PATH = process.env.TELNYX_SPEECH_WEBHOOK_PATH || '/handle-speech';
const TELNYX_RECORDING_WEBHOOK_PATH = process.env.TELNYX_RECORDING_WEBHOOK_PATH || '/handle-recording';
const TELNYX_STATUS_WEBHOOK_PATH = process.env.TELNYX_STATUS_WEBHOOK_PATH || '/call-status';
const TTS_VOICE = process.env.TTS_VOICE || 'Polly.Joanna-Neural';
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const OPENAI_CHAT_TIMEOUT_MS = Number(process.env.OPENAI_CHAT_TIMEOUT_MS || 12000);
const OPENAI_TRANSCRIPTION_TIMEOUT_MS = Number(process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS || 12000);
const RECORDING_MAX_LENGTH = process.env.RECORDING_MAX_LENGTH || '8';
const RECORDING_TIMEOUT = process.env.RECORDING_TIMEOUT || '2';

function logStep(callSid, step, details = {}) {
  const safeDetails = Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (value === undefined || value === null) return [key, value];
      const stringValue = String(value);
      return [key, stringValue.length > 500 ? `${stringValue.slice(0, 500)}...` : stringValue];
    })
  );

  console.log(`[CALL ${callSid}] ${step}`, safeDetails);
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

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
    logStep(callSid, 'Created new call state');
  }
  return calls.get(callSid);
}

function absoluteUrl(pathValue) {
  return `${PUBLIC_URL}${pathValue}`;
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

function sayAndRecord(res, callSid, message) {
  logStep(callSid, 'Sending Say + Record', {
    message,
    recordingAction: absoluteUrl(TELNYX_RECORDING_WEBHOOK_PATH),
    maxLength: RECORDING_MAX_LENGTH,
    timeout: RECORDING_TIMEOUT
  });

  sendTexml(
    res,
    `${sayTag(message)}<Record action="${xmlEscape(absoluteUrl(TELNYX_RECORDING_WEBHOOK_PATH))}" method="POST" maxLength="${xmlEscape(
      RECORDING_MAX_LENGTH
    )}" timeout="${xmlEscape(
      RECORDING_TIMEOUT
    )}" finishOnKey="#" playBeep="false" trim="trim-silence" format="mp3" /><Redirect method="POST">${xmlEscape(
      absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH)
    )}</Redirect>`
  );
}

function endCall(res, callSid, message) {
  logStep(callSid, 'Ending call', { message });
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
8. Ask for only ONE missing detail at a time.
9. Once you have name, phone, service needed, location, and preferred time, politely end the call.

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

async function getAiResponse(callSid, callState, userText, callerNumber) {
  const openai = getOpenAIClient();

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...callState.messages,
    {
      role: 'user',
      content: `Caller phone number from ${PHONE_PROVIDER}: ${callerNumber || 'unknown'}\nCaller said: ${userText}`
    }
  ];

  logStep(callSid, 'Sending transcript to OpenAI chat', {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    transcript: userText,
    messageCount: messages.length
  });

  const completion = await withTimeout(
    openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      temperature: 0.3,
      max_tokens: 180,
      response_format: { type: 'json_object' }
    }),
    OPENAI_CHAT_TIMEOUT_MS,
    'OpenAI chat response'
  );

  const raw = completion.choices[0]?.message?.content || '{}';
  logStep(callSid, 'Received OpenAI chat response', { raw });

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

  logStep(callSid, 'Updated lead state', {
    reply: parsed.reply,
    complete: callState.lead.complete,
    shouldEndCall: parsed.shouldEndCall,
    lead: JSON.stringify(callState.lead)
  });

  return parsed;
}

async function sendLeadEmail(callSid, callState) {
  if (!OWNER_EMAIL) {
    logStep(callSid, 'Skipping lead email because OWNER_EMAIL is missing');
    return;
  }

  if (callState.emailed) {
    logStep(callSid, 'Skipping lead email because it was already sent');
    return;
  }

  logStep(callSid, 'Sending lead email');
  const resend = getResendClient();
  const lead = callState.lead;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: OWNER_EMAIL,
    subject: `New AI receptionist lead - ${businessProfile.name}`,
    text: `New lead from ${businessProfile.name}\n\nName: ${lead.name || 'Not collected'}\nPhone: ${lead.phone || 'Not collected'}\nService: ${lead.service || 'Not collected'}\nLocation: ${lead.location || 'Not collected'}\nPreferred time: ${lead.preferredTime || 'Not collected'}\n\nSummary:\n${lead.summary || 'No summary'}\n\nCall ID: ${callSid}`
  });

  callState.emailed = true;
  logStep(callSid, 'Lead email sent');
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

function getRecordingUrl(req) {
  return getRequestValue(req, 'RecordingUrl', 'recording_url', 'recordingUrl', 'recording_url_mp3', 'RecordingUri') || '';
}

function extensionFromContentType(contentType = '') {
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('mp4')) return '.mp4';
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('ogg')) return '.ogg';
  return '.mp3';
}

async function downloadRecordingToTempFile(callSid, recordingUrl) {
  logStep(callSid, 'Downloading recording', { recordingUrl: recordingUrl ? 'present' : 'missing' });
  const response = await fetch(recordingUrl);

  if (!response.ok) {
    throw new Error(`Could not download recording. HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const filePath = path.join(os.tmpdir(), `caller-audio-${randomUUID()}${extensionFromContentType(contentType)}`);
  const audioBuffer = Buffer.from(await response.arrayBuffer());

  await fs.promises.writeFile(filePath, audioBuffer);
  logStep(callSid, 'Recording downloaded', { contentType, bytes: audioBuffer.length, filePath });
  return filePath;
}

async function transcribeWithOpenAI(callSid, audioFilePath) {
  const openai = getOpenAIClient();

  logStep(callSid, 'Sending recording to OpenAI transcription', { model: OPENAI_TRANSCRIPTION_MODEL });
  const transcription = await withTimeout(
    openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: OPENAI_TRANSCRIPTION_MODEL
    }),
    OPENAI_TRANSCRIPTION_TIMEOUT_MS,
    'OpenAI transcription'
  );

  const text = typeof transcription === 'string' ? transcription : transcription.text || '';
  logStep(callSid, 'Received OpenAI transcription', { text });
  return text;
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI receptionist backend is running on Telnyx TeXML with OpenAI speech-to-text.',
    phoneProvider: PHONE_PROVIDER,
    telnyxNumber: TELNYX_NUMBER || null,
    telnyxSetupUrl: absoluteUrl('/telnyx'),
    voiceWebhook: absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH),
    recordingWebhook: absoluteUrl(TELNYX_RECORDING_WEBHOOK_PATH),
    legacySpeechWebhook: absoluteUrl(TELNYX_SPEECH_WEBHOOK_PATH),
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
      `The app will record caller audio and send it to OpenAI through ${absoluteUrl(TELNYX_RECORDING_WEBHOOK_PATH)}.`,
      `Set the optional status callback URL to ${absoluteUrl(TELNYX_STATUS_WEBHOOK_PATH)} with method POST.`,
      'Assign the Telnyx number to that TeXML Application.',
      'Call the Telnyx number from another phone to test the receptionist.'
    ],
    voiceWebhook: absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH),
    recordingWebhook: absoluteUrl(TELNYX_RECORDING_WEBHOOK_PATH),
    legacySpeechWebhook: absoluteUrl(TELNYX_SPEECH_WEBHOOK_PATH),
    callStatusWebhook: absoluteUrl(TELNYX_STATUS_WEBHOOK_PATH)
  });
});

app.get('/debug-env', (req, res) => {
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
    OPENAI_TRANSCRIPTION_MODEL,
    OPENAI_CHAT_TIMEOUT_MS,
    OPENAI_TRANSCRIPTION_TIMEOUT_MS,
    TELNYX_RECORDING_WEBHOOK_PATH,
    RECORDING_MAX_LENGTH,
    RECORDING_TIMEOUT,
    nodeEnv: process.env.NODE_ENV || null,
    port: PORT
  });
});

app.all(TELNYX_VOICE_WEBHOOK_PATH, (req, res) => {
  const callSid = getCallSid(req);
  const callState = getCall(callSid);
  logStep(callSid, 'Voice webhook hit', { messageCount: callState.messages.length, method: req.method });

  if (callState.messages.length === 0) {
    return sayAndRecord(
      res,
      callSid,
      `Thanks for calling ${businessProfile.name}. This is the virtual receptionist. How can I help you today?`
    );
  }

  return sayAndRecord(res, callSid, 'Sorry, I did not catch that. Could you say that again?');
});

app.all(TELNYX_RECORDING_WEBHOOK_PATH, async (req, res) => {
  const callSid = getCallSid(req);
  const callerNumber = getCallerNumber(req);
  const recordingUrl = getRecordingUrl(req);
  const callState = getCall(callSid);
  let tempAudioPath = '';

  logStep(callSid, 'Recording webhook hit', {
    method: req.method,
    hasRecordingUrl: Boolean(recordingUrl),
    bodyKeys: Object.keys(req.body || {}).join(','),
    queryKeys: Object.keys(req.query || {}).join(',')
  });

  if (!String(recordingUrl).trim()) {
    return sayAndRecord(res, callSid, 'Sorry, I could not get the audio. Could you say that one more time?');
  }

  try {
    tempAudioPath = await downloadRecordingToTempFile(callSid, String(recordingUrl));
    const transcript = String(await transcribeWithOpenAI(callSid, tempAudioPath)).trim();

    if (!transcript) {
      return sayAndRecord(res, callSid, 'Sorry, I did not hear anything clearly. Could you say that one more time?');
    }

    const ai = await getAiResponse(callSid, callState, transcript, callerNumber);

    if (callState.lead.complete || ai.shouldEndCall) {
      await sendLeadEmail(callSid, callState);
      return endCall(
        res,
        callSid,
        ai.reply ||
          'Perfect, I have what I need. I will pass this along and someone will follow up with you soon. Thanks for calling.'
      );
    }

    return sayAndRecord(res, callSid, ai.reply || 'Got it. Could you tell me a little more?');
  } catch (error) {
    logStep(callSid, 'ERROR in recording flow', {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack
    });
    return sayAndRecord(
      res,
      callSid,
      'Sorry, I had a small issue understanding the audio. Could you repeat that one more time?'
    );
  } finally {
    if (tempAudioPath) {
      fs.promises.unlink(tempAudioPath).catch(() => {});
    }
  }
});

app.all(TELNYX_SPEECH_WEBHOOK_PATH, async (req, res) => {
  const callSid = getCallSid(req);
  const callerNumber = getCallerNumber(req);
  const speech = getSpeech(req);
  const callState = getCall(callSid);
  logStep(callSid, 'Legacy speech webhook hit', { speech });

  if (!String(speech).trim()) {
    return sayAndRecord(res, callSid, 'Sorry, I did not hear anything. How can I help you today?');
  }

  try {
    const ai = await getAiResponse(callSid, callState, String(speech), callerNumber);

    if (callState.lead.complete || ai.shouldEndCall) {
      await sendLeadEmail(callSid, callState);
      return endCall(
        res,
        callSid,
        ai.reply ||
          'Perfect, I have what I need. I will pass this along and someone will follow up with you soon. Thanks for calling.'
      );
    }

    return sayAndRecord(res, callSid, ai.reply || 'Got it. Could you tell me a little more?');
  } catch (error) {
    logStep(callSid, 'ERROR in legacy speech flow', {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack
    });
    return sayAndRecord(
      res,
      callSid,
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

  logStep(callSid, 'Status webhook hit', { callStatus, hasCallState: Boolean(callState) });

  if (callState && ['completed', 'hangup', 'call.hangup', 'done'].includes(callStatus)) {
    try {
      await sendLeadEmail(callSid, callState);
    } catch (error) {
      logStep(callSid, 'Failed to send end-of-call email', { errorMessage: error.message });
    }

    calls.delete(callSid);
    logStep(callSid, 'Deleted call state');
  }

  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI receptionist server running on port ${PORT}`);
  console.log(`Telnyx voice webhook: ${absoluteUrl(TELNYX_VOICE_WEBHOOK_PATH)}`);
  console.log(`OpenAI recording webhook: ${absoluteUrl(TELNYX_RECORDING_WEBHOOK_PATH)}`);
  console.log(`Recording max length: ${RECORDING_MAX_LENGTH}s`);
  console.log(`Recording silence timeout: ${RECORDING_TIMEOUT}s`);
  console.log(`Telnyx setup info: ${absoluteUrl('/telnyx')}`);
  console.log(`Debug env page: ${absoluteUrl('/debug-env')}`);
});