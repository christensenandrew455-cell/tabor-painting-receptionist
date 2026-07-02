# Tabor Painting AI Receptionist

This is a fast AI receptionist backend using:

- Telnyx TeXML for the live phone call webhook
- Telnyx speech gathering for the caller's spoken answers
- Fast scripted JavaScript logic for normal appointment booking answers
- OpenAI only as a fallback for unclear answers and quick customer questions
- Resend for lead summary emails
- Railway for hosting

The app is set up for this Railway domain:

```text
https://tabor-painting-receptionist-production.up.railway.app
```

## Main idea

The receptionist should not send every single caller answer to AI.

For normal appointment booking, the server now uses simple logic first:

```text
Caller says yes/no
        ↓
JavaScript checks for yes/no keywords
        ↓
Server instantly returns the next scripted line
```

The AI fallback only runs when the logic cannot confidently understand the caller, or when the caller asks a free-form question like:

```text
How long does interior painting usually take?
```

That keeps the call more snappy and avoids the slow speech-to-text → AI → text-to-speech delay on every turn.

## Call flow

```text
Customer calls Telnyx number
        ↓
Telnyx TeXML Application requests this Railway app at /voice
        ↓
Receptionist asks if they want to schedule an estimate
        ↓
Fast logic collects the lead one field at a time
        ↓
OpenAI fallback handles unclear answers or customer questions
        ↓
When the lead is complete, the app emails the owner
        ↓
Receptionist politely ends the call and hangs up
```

## What it collects

The app collects:

- caller name
- caller phone number when provided by Telnyx
- service needed
- street address
- city
- preferred day
- preferred time
- project notes
- optional customer question

## Fast service detection

The service question intentionally gives the caller choices:

```text
What service do you need: interior painting, exterior painting, or staining?
```

The logic can quickly classify common answers, for example:

- "interior painting"
- "I need a room painted"
- "bedroom walls"
- "outside of the house"
- "deck staining"
- "drywall patching"

## Files

```text
server.js       Main backend server
package.json    Node dependencies and start command
.env.example    Example environment variables
.gitignore      Keeps private files out of GitHub
```

## Local setup

Install Node.js 20 or newer.

Then run:

```bash
npm install
cp .env.example .env
npm run dev
```

Open this in your browser:

```text
http://localhost:3000
```

You should see JSON showing the app is running in `fast-scripted-gather` mode.

## Railway environment variables

Add these as Railway variables:

```text
PORT=3000
PUBLIC_URL=https://tabor-painting-receptionist-production.up.railway.app
PHONE_PROVIDER=Telnyx TeXML
TELNYX_NUMBER=your_telnyx_number
TELNYX_VOICE_WEBHOOK_PATH=/voice
TELNYX_SPEECH_WEBHOOK_PATH=/handle-speech
TELNYX_STATUS_WEBHOOK_PATH=/call-status
TTS_VOICE=Polly.Joanna-Neural
OPENAI_API_KEY=your_openai_api_key
OPENAI_FALLBACK_MODEL=gpt-4.1-nano
RESEND_API_KEY=your_resend_api_key
OWNER_EMAIL=your_email@example.com
FROM_EMAIL=AI Receptionist <onboarding@resend.dev>
BUSINESS_NAME=Tabor Painting
BUSINESS_SERVICES=interior painting, exterior painting, cabinet painting, drywall patching, staining, and small paint repairs
SERVICE_AREA=your local service area
BUSINESS_HOURS=Monday through Friday, 8 AM to 5 PM
```

Important: do not put your real `.env` file into GitHub.

## Model notes

This app is not using a full OpenAI realtime audio session.

Current architecture:

```text
Telnyx speech gather
        ↓
server-side JavaScript logic
        ↓
OpenAI fallback only when needed
        ↓
Telnyx Say voice response
```

Recommended fallback model:

```text
gpt-4.1-nano
```

Reason: the fallback is only doing simple extraction or quick customer Q&A, so it does not need a large reasoning model.

For true live interruption handling, streaming audio, and more natural back-and-forth, the next major version would use OpenAI Realtime or a Telnyx media stream. This repo currently uses TeXML, which is simpler and easier to deploy, but not as fluid as a true realtime voice socket.

## Deploy on Railway

1. Go to Railway
2. Create or open the project connected to this GitHub repo
3. Add the environment variables above
4. Deploy
5. Open this URL to confirm the server is running:

```text
https://tabor-painting-receptionist-production.up.railway.app/
```

6. Open this URL to confirm Railway can see the required variables:

```text
https://tabor-painting-receptionist-production.up.railway.app/debug-env
```

## Telnyx setup

In Telnyx:

1. Buy or use a Telnyx phone number
2. Create a TeXML Application
3. Set the TeXML Application voice webhook to:

```text
Webhook URL: https://tabor-painting-receptionist-production.up.railway.app/voice
Method: POST
```

4. Optional status callback:

```text
Webhook URL: https://tabor-painting-receptionist-production.up.railway.app/call-status
Method: POST
```

5. Assign the Telnyx phone number to that TeXML Application
6. Call the Telnyx number from another phone to test it

You can also open this route after deploy to see setup info:

```text
https://tabor-painting-receptionist-production.up.railway.app/telnyx
```

## Notes

This app uses Telnyx TeXML. Telnyx TeXML supports TwiML-style verbs like `<Gather>`, `<Say>`, `<Redirect>`, and `<Hangup>`, so the app can return XML call instructions directly from Express.

Later upgrades can include:

- pre-recorded audio files for the most common scripted responses
- Google Sheets lead storage
- a dashboard
- full realtime voice with interruption handling
- client-specific business profiles
- CRM integration
