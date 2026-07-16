# Tabor Painting AI Receptionist

Real-time phone receptionist deployed on Railway. It answers Telnyx calls, runs the conversation through OpenAI Realtime, and sends confirmed leads to ARK OCM.

## Architecture

```text
Incoming call
    -> Telnyx Voice API webhook
    -> bidirectional Telnyx media stream
    -> OpenAI Realtime voice session
    -> confirmed lead sent to the production ARK OCM webhook
```

## Required Railway variables

```text
PORT=3000
PUBLIC_URL=https://tabor-painting-receptionist-production.up.railway.app

TELNYX_API_KEY=your_telnyx_api_key
OPENAI_API_KEY=your_openai_api_key

OCM_WEBHOOK_URL=https://ark-websites-ocm.vercel.app/api/intake
OCM_CONNECTION_KEY=the_private_connection_key_for_this_business
OCM_CLIENT_ID=tabor-painting
OCM_SOURCE=tabor-painting-receptionist

BUSINESS_INFO={"name":"Tabor Painting","receptionist":"Alex","owner":"Jason Beirne"}
```

`OCM_WEBHOOK_URL` must point to the production OCM deployment. The retired protected Vercel preview URL is automatically replaced with the production URL during startup.

`OCM_CONNECTION_KEY` is required and is attached to every OCM submission. The OCM intake route validates it against that business's connection record.

`OCM_CLIENT_ID` selects the business data path in OCM. `OCM_SOURCE` labels where the lead came from.

## BUSINESS_INFO variable

`BUSINESS_INFO` is the portable configuration for the AI receptionist. It accepts either:

- A JSON object for full customization.
- Plain text that should be added to the receptionist's business knowledge.

Supported JSON fields:

```json
{
  "name": "Tabor Painting",
  "receptionist": "Alex",
  "owner": "Jason Beirne",
  "phone": "(774) 245-3383",
  "email": "Taborpainting508@gmail.com",
  "hours": "Monday through Friday, 8 AM to 5 PM",
  "estimateDays": "Monday through Friday",
  "estimateWeekdays": ["monday", "tuesday", "wednesday", "thursday", "friday"],
  "earliestEstimateStart": "9:00 AM",
  "latestEstimateStart": "4:30 PM",
  "base": "Berlin, Massachusetts",
  "serviceAreas": ["Berlin", "Bolton", "Hudson"],
  "services": {
    "interior painting": "Indoor walls, ceilings, trim, and doors.",
    "exterior painting": "Exterior surfaces and trim."
  },
  "about": ["Short business description."],
  "extraInformation": "Anything else the AI may safely tell callers."
}
```

The configured services automatically become the valid service options in the OpenAI tool. The configured business name, owner, hours, estimate window, service areas, and information are inserted into the receptionist instructions.

## Startup verification

Railway logs now print a safe OCM configuration summary:

```text
[OCM configuration] {
  endpoint: 'https://ark-websites-ocm.vercel.app/api/intake',
  clientId: 'tabor-painting',
  source: 'tabor-painting-receptionist',
  hasConnectionKey: true,
  hasBusinessInfo: true
}
```

The connection-key value is never printed.

## Call flow

The receptionist collects:

1. Full first and last name
2. Email address
3. Service category
4. Town or city
5. Street address
6. Best contact method
7. Preferred estimate day
8. Preferred estimate time
9. Additional notes

The caller's phone number comes from Telnyx caller ID. After the caller confirms the summary, the receptionist submits the lead to OCM's `contactedMe` collection.

## Telnyx setup

Configure the Telnyx Voice API application to send POST webhooks to:

```text
https://tabor-painting-receptionist-production.up.railway.app/voice-api-webhook
```

The WebSocket media endpoint is:

```text
wss://tabor-painting-receptionist-production.up.railway.app/media-stream
```

## Local setup

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm test
npm run dev
```

Do not commit a real `.env` file or a real OCM connection key.

## Main files

```text
server.js                  Telnyx, OpenAI, and OCM runtime
ocm-bootstrap.js           Production webhook and connection setup
receptionist-core.js       Business configuration, prompt, validation, and lead mapping
test/receptionist.test.js  Behavioral unit tests
.env.example               Deployment-variable template
```
