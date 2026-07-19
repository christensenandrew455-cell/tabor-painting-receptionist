# Clone-Ready AI Receptionist

This Railway service answers Telnyx calls, runs the conversation through OpenAI Realtime, and sends caller-confirmed leads to the correct ARK Client Center account.

The ARK app is shared. Only the receptionist service is cloned for each business.

## Exact Railway variables

Every clone must contain all eleven variables below:

```text
AI_MODEL
AI_SILENCE_MS
AI_SPEECH_SPEED
AI_VOICE
BUSINESS_INFO
OCM_CLIENT_ID
OCM_CONNECTION_KEY
OPENAI_API_KEY
PUBLIC_URL
RECEPTIONIST_SCRIPT
TELNYX_API_KEY
```

The service now refuses to start when any one of these variables is blank or missing. There is no built-in business-information fallback and no built-in receptionist-script fallback.

Railway supplies `PORT` automatically. Do not add it manually.

## What each variable controls

- `AI_MODEL`: OpenAI Realtime model.
- `AI_SILENCE_MS`: caller-pause detection time, from 300 through 3000 milliseconds.
- `AI_SPEECH_SPEED`: voice speed, from 0.25 through 1.5.
- `AI_VOICE`: OpenAI Realtime voice.
- `BUSINESS_INFO`: one JSON object containing every business-specific fact.
- `OCM_CLIENT_ID`: the exact ARK Client Center business ID.
- `OCM_CONNECTION_KEY`: the private ARK connection value for that business.
- `OPENAI_API_KEY`: the OpenAI key used by this clone. Use a separate key when usage must be separated by customer.
- `PUBLIC_URL`: this Railway service's public HTTPS address.
- `RECEPTIONIST_SCRIPT`: the full business-specific call flow and wording.
- `TELNYX_API_KEY`: the Telnyx credential used to answer and control calls.

## BUSINESS_INFO

`BUSINESS_INFO` must be valid JSON and must provide:

```json
{
  "name": "Example Business",
  "receptionist": "Alex",
  "owner": "Example Owner",
  "phone": "(555) 555-0100",
  "email": "hello@example.com",
  "hours": "Monday through Friday, 8 AM to 5 PM",
  "timeZone": "America/New_York",
  "estimateDays": "Monday through Friday",
  "estimateWeekdays": ["monday", "tuesday", "wednesday", "thursday", "friday"],
  "earliestEstimateStart": "9:00 AM",
  "latestEstimateStart": "4:30 PM",
  "base": "Example City",
  "serviceAreas": ["Example State"],
  "services": {
    "example service": "Description of the service."
  },
  "about": ["Short business description."],
  "openingLine": "Hi, this is {{receptionist_name}} with {{business_name}}. Can I set you up with an estimate today?",
  "closingLine": "{{owner_first_name}} will follow up with you shortly. Thanks for calling {{business_name}}. Goodbye.",
  "extraInformation": "Additional facts the receptionist may tell callers."
}
```

The configured services become the only service categories accepted by the lead-saving tool. Estimate days, times, time zone, names, opening, closing, service area, and all business answers also come from this variable.

## RECEPTIONIST_SCRIPT

`RECEPTIONIST_SCRIPT` is required and must contain the full call flow for that business. The code does not supply a default script.

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
{{opening_line}}
{{closing_line}}
```

Shared safety and infrastructure behavior stays hardcoded around the variable script. This includes caller-ID privacy, one-question-at-a-time handling, confirmed-lead saving, OCM routing, retries, Telnyx streaming, interruption handling, and server-controlled hangup behavior.

## Shared routing

The production ARK intake endpoint is hardcoded because every clone sends into the same app. The source label is derived automatically from `OCM_CLIENT_ID`:

```text
OCM_CLIENT_ID-receptionist
```

Do not add these old variables:

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

No Resend variable or Resend package is used.

## Clone process

1. Duplicate the Railway receptionist service or repository.
2. Give the new service its own public Railway domain.
3. Add all eleven required variables.
4. Replace `BUSINESS_INFO` with the new business's facts.
5. Replace `RECEPTIONIST_SCRIPT` with the new business's call flow.
6. Use the correct `OCM_CLIENT_ID` and `OCM_CONNECTION_KEY`.
7. Use a separate `OPENAI_API_KEY` when customer usage must be isolated.
8. In Telnyx, attach the new telephone number to a Voice API application using:

```text
https://YOUR-RAILWAY-DOMAIN/voice-api-webhook
```

The media stream is:

```text
wss://YOUR-RAILWAY-DOMAIN/media-stream
```

The telephone number is configured in Telnyx, not as a Railway variable.

## Validation

```bash
npm install
npm run check
npm test
npm start
```

Never commit real provider credentials or an ARK connection value.
