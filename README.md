# Tabor Painting AI Receptionist

This is a basic AI receptionist backend using:

- Telnyx TeXML for the live phone call webhook
- OpenAI for the AI brain
- Resend for lead summary emails
- Railway for hosting

The app is set up for this Railway domain:

```text
https://tabor-painting-receptionist-production.up.railway.app
```

## Call flow

```text
Customer calls Telnyx number
        ↓
Telnyx TeXML Application requests this Railway app at /voice
        ↓
AI receptionist answers, listens, and responds
        ↓
When the lead is complete, the app emails the owner
```

## What it does

When someone calls the connected Telnyx number, the app:

1. Answers the phone
2. Asks how it can help
3. Uses OpenAI to respond
4. Collects lead info:
   - name
   - phone number
   - service needed
   - location
   - preferred time
5. Emails the lead summary to the owner using Resend

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

You should see:

```json
{
  "status": "ok",
  "message": "AI receptionist backend is running on Telnyx TeXML."
}
```

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
OPENAI_MODEL=gpt-4o-mini
RESEND_API_KEY=your_resend_api_key
OWNER_EMAIL=your_email@example.com
FROM_EMAIL=AI Receptionist <onboarding@resend.dev>
BUSINESS_NAME=Tabor Painting
BUSINESS_SERVICES=interior painting, exterior painting, cabinet painting, drywall patching, staining, and small paint repairs
SERVICE_AREA=your local service area
BUSINESS_HOURS=Monday through Friday, 8 AM to 5 PM
BOOKING_RULE=Collect the caller name, phone number, service needed, location, and preferred time. Do not promise an exact appointment. Say the owner will follow up to confirm.
```

Important: do not put your real `.env` file into GitHub.

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

- Google Sheets lead storage
- A dashboard
- Better voices
- Full real-time voice
- Client-specific business profiles
- Your CRM system
