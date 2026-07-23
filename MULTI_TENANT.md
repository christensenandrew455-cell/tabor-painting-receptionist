# Multi-tenant Railway deployment

This branch changes the receptionist from one Railway clone per business to one shared Railway service.

## Required Railway variables

```text
OPENAI_API_KEY
TELNYX_API_KEY
PUBLIC_URL
RECEPTIONIST_CONFIG_URL
RECEPTIONIST_CONFIG_SECRET
```

`RECEPTIONIST_CONFIG_URL` should point to the ARK Client Center server route:

```text
https://YOUR-VERCEL-DOMAIN/api/receptionist/config
```

`RECEPTIONIST_CONFIG_SECRET` must be the same long random secret on Railway and Vercel. It protects the server-to-server profile lookup. Do not expose it in browser code.

Optional:

```text
RECEPTIONIST_CONFIG_CACHE_MS=60000
```

## Telnyx setup

Every Telnyx number can use the same webhook:

```text
https://YOUR-RAILWAY-DOMAIN/voice-api-webhook
```

For each client, save the destination phone number and Telnyx connection ID in the ARK receptionist profile. The shared service reads those values from the inbound call, securely fetches the matching client configuration, and starts the call with that business's script, voice, pacing, business information, client ID, and private connection key.

## Qualified leads

A call becomes a qualified lead only when the `submit_estimate_lead` tool validates the required caller information and ARK successfully saves it. Call usage records include both `leadSaved` and `qualifiedLead` so billing can charge only successful qualified leads.

## Migration

1. Deploy the matching ARK Client Center branch and set `RECEPTIONIST_CONFIG_SECRET` on Vercel.
2. Open `/receptionists` as the administrator and configure one client profile.
3. Set the five Railway variables above on a test Railway service.
4. Point one Telnyx number to the shared Railway webhook and place test calls.
5. Verify the lead enters the correct client account and usage is recorded with the correct client ID.
6. Move remaining Telnyx numbers to the shared webhook after the pilot succeeds.

The old single-client files remain in the repository during migration, but `npm start` uses `multi-tenant-server.js` on this branch.
