# Tabor Painting AI Receptionist

This is a basic AI receptionist backend using:

- Twilio for the phone number and calls
- OpenAI for the AI brain
- Resend for lead summary emails
- Railway or Render for hosting

This first version is intentionally simple. It uses Twilio speech gathering instead of full real-time audio streaming. That makes it easier to test and deploy.

## What it does

When someone calls your Twilio number, the app:

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

## Connect Twilio

In Twilio, go to your phone number settings.

For incoming calls, set:

```text
Webhook URL: https://your-railway-app.up.railway.app/voice
Method: POST
```

Optional call status callback:

```text
Webhook URL: https://your-railway-app.up.railway.app/call-status
Method: POST
```

Then call your Twilio number.

## Important note

This is the basic version. Later upgrades can include:

- Google Sheets lead storage
- A dashboard
- Better voices
- Full real-time voice using Twilio Media Streams
- Client-specific business profiles
- Your OCM system
