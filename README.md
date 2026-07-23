# Tabor Painting AI Receptionist

This Railway service answers Telnyx calls, runs a fixed estimate-intake workflow through OpenAI Realtime, and sends caller-confirmed leads to ARK OCM.

The intake script and model are hard-coded in the receptionist. Business-specific wording is filled from `BUSINESS_INFO`.

## Railway variables

Railway must contain these nine variables:

```text
AI_SILENCE_MS
AI_SPEECH_SPEED
AI_VOICE
BUSINESS_INFO
OCM_CLIENT_ID
OCM_CONNECTION_KEY
OPENAI_API_KEY
PUBLIC_URL
TELNYX_API_KEY
```

Railway supplies `PORT` automatically.

Do not add `AI_MODEL` or `RECEPTIONIST_SCRIPT`. The model is fixed to `gpt-realtime-mini`, and the full intake script is stored in `receptionist-script.js`.

## Voice settings

- `AI_VOICE`: the Realtime voice used for the call.
- `AI_SPEECH_SPEED`: output speed from `0.25` through `1.5`.
- `AI_SILENCE_MS`: pause detection from `300` through `3000` milliseconds.

Suggested baseline values:

```text
AI_VOICE=alloy
AI_SPEECH_SPEED=1
AI_SILENCE_MS=900
```

## BUSINESS_INFO

`BUSINESS_INFO` must be one JSON object with these fields:

```json
{
  "name": "Example Business",
  "receptionist": "Alex",
  "owner": "Example Owner",
  "phone": "(555) 555-0100",
  "email": "hello@example.com",
  "hours": "Monday through Friday. Holiday schedules may affect availability.",
  "timeZone": "America/New_York",
  "estimateDays": "Monday through Friday",
  "estimateWeekdays": [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday"
  ],
  "earliestEstimateStart": "9:00 AM",
  "latestEstimateStart": "4:30 PM",
  "base": "Example City, Massachusetts",
  "serviceAreas": [
    "Massachusetts"
  ],
  "services": {
    "interior painting": "Interior painting for walls, ceilings, trim, doors, rooms, and other indoor surfaces.",
    "exterior painting": "Exterior painting for homes, buildings, trim, and other outdoor surfaces."
  },
  "about": [
    "Short business description."
  ],
  "openingLine": "Hi, this is {{receptionist_name}} with {{business_name}}. Can I set you up with an estimate today?",
  "closingLine": "{{owner_first_name}} will follow up with you shortly. Thanks for calling {{business_name}}. Goodbye.",
  "extraInformation": "Additional facts, policies, scheduling details, and answers the receptionist may provide."
}
```

The fixed script automatically fills:

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

Configured services become the only service categories accepted by the lead-saving tool. Estimate weekdays and estimate times are validated before a lead can be saved.

## Call behavior

The hard-coded workflow:

1. Delivers the configured opening line.
2. Collects name, optional email, service, city, street address, contact method, estimate day, estimate time, and additional notes.
3. Confirms the completed information once.
4. Saves only after the caller confirms it is correct.
5. Never reads or repeats the caller-ID phone number.
6. Never quotes pricing or promises appointment availability.

## ARK routing

The production intake endpoint is shared. The receptionist sends the configured `OCM_CLIENT_ID` and `OCM_CONNECTION_KEY`, and derives its source as:

```text
OCM_CLIENT_ID-receptionist
```

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

Never commit real provider credentials or a private ARK connection value.
