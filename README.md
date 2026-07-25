# ARK AI Receptionist Bridge

This Railway service answers Telnyx calls, runs the fixed estimate-intake workflow through OpenAI Realtime, and saves caller-confirmed leads into ARK OCM.

## Call flow

1. A customer calls a Telnyx number.
2. Telnyx sends the signed call event to Railway.
3. Railway forwards that signed event to ARK OCM.
4. ARK OCM verifies the Telnyx signature and matches the dialed number to the correct business account.
5. ARK OCM returns that account's business information, services, schedule, AI voice settings, and private lead destination.
6. Railway starts the receptionist using those settings for that call.
7. A confirmed lead is saved into the matched business workspace.

The receptionist script and model remain hard-coded in this repository. Business-specific information is never required as a Railway variable.

## Railway variables

Railway needs only:

```text
OPENAI_API_KEY
TELNYX_API_KEY
```

`PUBLIC_URL` is optional when Railway supplies `RAILWAY_PUBLIC_DOMAIN`. Railway supplies `PORT` automatically.

Do not add these old per-business variables:

```text
AI_SILENCE_MS
AI_SPEECH_SPEED
AI_VOICE
BUSINESS_INFO
OCM_CLIENT_ID
OCM_CONNECTION_KEY
RECEPTIONIST_SCRIPT
```

ARK OCM now supplies those settings per call by matching the dialed Telnyx phone number.

## Settings managed in ARK OCM

Each connected account stores:

- Connected receptionist phone number
- Business name and owner name
- Business phone and email
- Business hours and time zone
- Estimate days and time range
- Service areas and services
- About and additional business information
- Opening and closing lines
- AI voice, speech speed, and silence timing

The connected phone number must be unique and must match the number receiving the Telnyx call.

## Fixed receptionist workflow

The hard-coded workflow:

1. Delivers the business's configured opening line.
2. Collects name, optional email, service, city, street address, contact method, estimate day, estimate time, and additional notes.
3. Confirms the completed information once.
4. Asks for permission to be contacted before saving.
5. Saves only after the caller agrees.
6. Never reads or repeats the caller-ID phone number.
7. Never quotes pricing or promises appointment availability.

## Telnyx

Point the Voice API application webhook to:

```text
https://YOUR-RAILWAY-DOMAIN/voice-api-webhook
```

The media stream is:

```text
wss://YOUR-RAILWAY-DOMAIN/media-stream
```

## Validation

```bash
npm install
npm run check
npm test
npm start
```

Never commit real provider credentials or private ARK connection values.
