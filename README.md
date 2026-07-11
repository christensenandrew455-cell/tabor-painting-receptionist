# Tabor Painting AI Receptionist

Real-time phone receptionist for Tabor Painting, deployed on Railway.

## Architecture

```text
Incoming call
    -> Telnyx Voice API webhook
    -> bidirectional Telnyx media stream
    -> OpenAI Realtime voice session
    -> confirmed lead sent to ARK OCM
```

The server uses OpenAI server VAD to detect each completed caller turn. Server VAD owns the audio commit and response creation so a caller turn is not processed twice.

## Call flow

Alex asks one question at a time and collects:

1. Full first and last name
2. Email address
3. Best contact method
4. Service category
5. Town or city
6. Street address
7. Preferred estimate day
8. Preferred estimate time
9. Project notes

The caller phone number comes from the Telnyx `call.initiated` webhook and is attached to the OCM lead automatically.

Project details stay separate from the service category. For example, “interior painting for five walls” produces:

```text
Job: interior painting
Notes: Project details: interior painting for five walls
```

After the caller confirms the summary, the lead is sent to OCM. Alex then asks whether the caller has questions and waits for an answer before ending the call.

## Scheduling cutoff

`SCHEDULING_BUFFER_MINUTES` defaults to `30`. The server parses `BUSINESS_HOURS` and rejects preferred times inside the final 30 minutes of the workday.

For example:

```text
BUSINESS_HOURS=Monday through Friday, 9 AM to 5 PM
SCHEDULING_BUFFER_MINUTES=30
```

The latest accepted estimate start is `4:30 PM`; `5:00 PM` is rejected.

## Local setup

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm test
npm run dev
```

The health endpoint is available at:

```text
http://localhost:3000/
```

## Railway variables

```text
PORT=3000
PUBLIC_URL=https://tabor-painting-receptionist-production.up.railway.app

TELNYX_API_KEY=your_telnyx_api_key
TELNYX_STREAM_TRACK=inbound_track
TELNYX_STREAM_CODEC=PCMU

OPENAI_API_KEY=your_openai_api_key
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=alloy
VAD_SILENCE_MS=700

OCM_WEBHOOK_URL=https://ark-websites-ocm.vercel.app/api/intake

BUSINESS_NAME=Tabor Painting
BUSINESS_SERVICES=interior painting, exterior painting, wood staining, and small paint repair
SERVICE_AREA=your local service area
BUSINESS_HOURS=Monday through Friday, 8 AM to 5 PM
SCHEDULING_BUFFER_MINUTES=30
```

Do not commit a real `.env` file.

## Telnyx setup

Configure the Telnyx Voice API application to send POST webhooks to:

```text
https://tabor-painting-receptionist-production.up.railway.app/voice-api-webhook
```

The app answers the call and starts the bidirectional media stream itself. The WebSocket endpoint is:

```text
wss://tabor-painting-receptionist-production.up.railway.app/media-stream
```

## Files

```text
server.js                  Telnyx/OpenAI/OCM runtime
receptionist.js            Prompt, validation, scheduling, and lead mapping
test/receptionist.test.js  Behavioral unit tests
.env.example               Deployment variable template
```
