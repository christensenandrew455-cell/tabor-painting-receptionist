# Tabor Painting AI Receptionist

This is a basic AI receptionist backend using:

- Google Voice as the public business phone number
- A webhook-capable voice provider to connect phone calls to this app
- OpenAI for the AI brain
- Resend for lead summary emails
- Railway or Render for hosting

Important: Google Voice is simple for owning a business number, calls, voicemail, and texts. But Google Voice does not provide the kind of incoming-call webhook this app needs to answer a live call by itself.

So the setup is:

```text
Customer calls Google Voice number
        ↓
Google Voice forwards the call
        ↓
Webhook-capable phone provider answers the call
        ↓
Provider sends the call to this Railway app at /voice
        ↓
AI receptionist talks to the caller and emails the lead
```

The backend still uses TwiML XML for the live call flow. That means the forwarding destination has to be a voice provider that can use TwiML-style webhooks or an equivalent adapter.

## What it does

When someone calls the connected business number, the app:

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
  "message": "AI receptionist backend is running."
}
```

## Environment variables

Create a `.env` file locally or add these as Railway variables:

```text
PORT=3000
PUBLIC_URL=https://your-railway-app.up.railway.app
PHONE_PROVIDER=Google Voice forwarding + webhook voice provider
GOOGLE_VOICE_NUMBER=your_google_voice_number
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
2. Create a new project
3. Deploy from GitHub repo
4. Select this repo
5. Add the environment variables above
6. Deploy
7. Copy your Railway public URL
8. Set `PUBLIC_URL` to that Railway public URL

## Google Voice setup

Google Voice can be used as the number customers call.

In Google Voice:

1. Keep your Google Voice number as the business number
2. Add a forwarding number
3. Forward calls to the webhook-capable voice provider number
4. Test by calling the Google Voice number from a different phone

Then, in the webhook-capable voice provider, point incoming calls to:

```text
Webhook URL: https://your-railway-app.up.railway.app/voice
Method: POST
```

Optional call status callback:

```text
Webhook URL: https://your-railway-app.up.railway.app/call-status
Method: POST
```

You can also open this route after deploy to see setup info:

```text
https://your-railway-app.up.railway.app/google-voice
```

## Important note

This repo is now set up for Google Voice as the front-facing number, but Google Voice alone cannot replace a live-call webhook provider. If you only use Google Voice by itself, calls can ring your browser/app/phone and go to voicemail, but this Node app cannot automatically answer the call.

Later upgrades can include:

- Google Sheets lead storage
- A dashboard
- Better voices
- Full real-time voice
- Client-specific business profiles
- Your CRM system
