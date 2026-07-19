# Tabor Painting AI Receptionist

A clone-ready phone receptionist deployed on Railway. It answers Telnyx calls, runs the conversation through OpenAI Realtime, and sends caller-confirmed estimate requests into the correct ARK Client Center account.

## What is cloned

The receptionist service is cloned once per business.

The ARK Client Center app is **not** cloned. Every receptionist clone sends leads to the same production app, using that business's own `OCM_CLIENT_ID` and `OCM_CONNECTION_KEY`.

```text
Incoming Telnyx number
    -> this Railway receptionist clone
    -> OpenAI Realtime conversation
    -> production ARK Client Center intake webhook
    -> the correct business account
```

## Exact Railway variables

These are the only manually managed receptionist variables.

### Required

```text
PUBLIC_URL
TELNYX_API_KEY
OPENAI_API_KEY
OCM_CLIENT_ID
OCM_CONNECTION_KEY
BUSINESS_INFO
```

### Optional behavior overrides

```text
RECEPTIONIST_SCRIPT
AI_MODEL
AI_VOICE
AI_SPEECH_SPEED
AI_SILENCE_MS
```

Railway provides `PORT` and `RAILWAY_PUBLIC_DOMAIN` automatically. The shared production OCM webhook and OCM source label are hardcoded or derived by the application.

### Delete old variables

The runtime no longer reads these old variables. Remove them from Railway if they are present:

```text
OCM_WEBHOOK_URL
OCM_SOURCE
OPENAI_REALTIME_MODEL
OPENAI_REALTIME_VOICE
OPENAI_REALTIME_SPEED
VAD_SILENCE_DURATION_MS
TRANSCRIPT_WAIT_MS
BUSINESS_TIME_ZONE
```

No Resend variable or Resend package is used by this receptionist.

## BUSINESS_INFO

`BUSINESS_INFO` is one JSON variable containing every business-specific fact. The same object controls:

- The business, receptionist, and owner names.
- The opening and closing lines.
- Business phone, email, hours, location, and time zone.
- Estimate days and accepted time window.
- Service areas and valid service categories.
- Business descriptions and extra information.
- The service options accepted by the OpenAI lead-saving tool.

Example:

```json
{
  "name": "Tabor Painting",
  "receptionist": "Alex",
  "owner": "Jason Beirne",
  "phone": "(774) 245-3383",
  "email": "Taborpainting508@gmail.com",
  "hours": "Monday through Friday, 8 AM to 5 PM",
  "timeZone": "America/New_York",
  "estimateDays": "Monday through Friday",
  "estimateWeekdays": ["monday", "tuesday", "wednesday", "thursday", "friday"],
  "earliestEstimateStart": "9:00 AM",
  "latestEstimateStart": "4:30 PM",
  "base": "Berlin, Massachusetts",
  "serviceAreas": ["Berlin", "Bolton", "Hudson"],
  "services": {
    "interior painting": "Indoor walls, ceilings, trim, doors, and repainting.",
    "exterior painting": "Exterior surfaces, preparation, and trim.",
    "small paint repair": "Small touch-ups and minor paint or patch repairs.",
    "wood staining": "Staining decks, fences, trim, and other wood surfaces."
  },
  "about": [
    "Tabor Painting is a residential painting company based in Berlin, Massachusetts."
  ],
  "openingLine": "Hi, this is {{receptionist_name}} with {{business_name}}. Can I set you up with an estimate today?",
  "closingLine": "{{owner_first_name}} will follow up with you shortly. Thanks for calling {{business_name}}. Goodbye.",
  "extraInformation": ""
}
```

Supported placeholders:

```text
{{business_name}}
{{receptionist_name}}
{{owner_name}}
{{owner_first_name}}
{{services}}
{{estimate_days}}
{{earliest_estimate_time}}
{{latest_estimate_time}}
```

Older field aliases such as `businessName`, `receptionistName`, `ownerName`, `businessHours`, and `location` remain accepted, so the existing Tabor configuration does not need an immediate rewrite.

## RECEPTIONIST_SCRIPT

The tested Tabor intake flow remains built in. Leave `RECEPTIONIST_SCRIPT` empty to keep that behavior.

Set `RECEPTIONIST_SCRIPT` only when a cloned receptionist needs different wording, question order, or workflow. It can use the same placeholders as `BUSINESS_INFO`.

Hardcoded operating safeguards remain outside the variable script. A custom script cannot remove caller-ID privacy, one-question-at-a-time behavior, confirmed-lead saving, OCM routing, or the server-controlled hangup process.

## AI behavior variables

```text
AI_MODEL=gpt-realtime-mini
AI_VOICE=alloy
AI_SPEECH_SPEED=0.94
AI_SILENCE_MS=1200
```

- `AI_MODEL` selects the OpenAI Realtime model.
- `AI_VOICE` selects the Realtime voice.
- `AI_SPEECH_SPEED` controls spoken pacing from `0.25` through `1.5`.
- `AI_SILENCE_MS` controls how long the caller can pause before a turn is considered complete, from `300` through `3000` milliseconds.

The audio codec, Telnyx stream settings, barge-in handling, hold behavior, retries, validation, tool definitions, and OCM webhook endpoint remain hardcoded because they are shared runtime logic rather than client configuration.

## Clone process

1. Duplicate the Railway receptionist service.
2. Give the clone its own public Railway domain.
3. Add the exact variables from `.env.example`.
4. Use the new business's OpenAI API key when usage needs separate billing.
5. Set the new business's `OCM_CLIENT_ID` and private `OCM_CONNECTION_KEY`.
6. Replace `BUSINESS_INFO`.
7. Optionally replace `RECEPTIONIST_SCRIPT`, voice, speed, silence timing, or model.
8. In Telnyx, assign the new phone number to a Voice API application whose POST webhook is:

```text
https://YOUR-RAILWAY-DOMAIN/voice-api-webhook
```

The WebSocket media endpoint is created automatically:

```text
wss://YOUR-RAILWAY-DOMAIN/media-stream
```

The phone number itself is configured in Telnyx. It is not a Railway variable because the runtime never needs to read it.

## Current call flow

The default script collects:

1. Full first and last name.
2. Optional email address.
3. Service category.
4. Town or city.
5. Street address.
6. Best available contact method.
7. Preferred estimate day.
8. Preferred estimate time.
9. Additional notes.

The caller's phone number comes from Telnyx caller ID and is never spoken back to the caller. After the caller confirms the summary, the receptionist saves the lead to the business's `contactedMe` section.

## Local checks

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm run check
npm test
npm run dev
```

Never commit real API keys or a real OCM connection key.
