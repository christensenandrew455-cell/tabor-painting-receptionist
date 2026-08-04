# ARK AI Receptionist Bridge

This Railway service answers Telnyx calls, runs one deterministic estimate-intake workflow, and saves caller-confirmed leads into the matched ARK OCM workspace.

## Runtime flow

1. Telnyx sends a signed `call.initiated` event.
2. The bridge forwards the unmodified body and signature to ARK OCM.
3. OCM verifies the Telnyx signature and matches the dialed number to exactly one client.
4. OCM returns the exact client ID, business profile, intake endpoint, usage endpoint, and optional expiring endpoint tokens.
5. The bridge validates the profile and constructs one tenant-isolated core object. It never changes global environment variables.
6. The bridge answers the call and gives Telnyx an HMAC-signed, expiring media URL.
7. One call session collects and validates fields in a fixed order.
8. After explicit consent and final confirmation, the bridge submits one idempotent intake request.
9. The lead is marked saved only after OCM returns valid JSON confirming success for the same client.

Client IDs are opaque values. They are validated and preserved exactly; they are never lowercased or converted to slugs.

## Intake script

1. Estimate offer
2. Configured service
3. Full name
4. Callback phone, only when Telnyx did not provide a valid caller number
5. Full project address
6. Preferred estimate date
7. Preferred estimate time
8. Additional notes
9. Permission to be contacted
10. Full readback and explicit submission confirmation

A caller who declines contact permission is told that the request will not be submitted, and the call closes normally.

## Validation

- **Service:** must resolve uniquely to a configured service.
- **Name:** requires at least two Unicode name tokens; accents, apostrophes, hyphens, initials, and suffixes are allowed.
- **Phone:** must normalize to E.164. The Telnyx caller number is reused when valid.
- **Address:** requires street number, street name, city or town, and a valid US state. Unit and ZIP are optional and retained.
- **Date:** stored once as `YYYY-MM-DD`, interpreted in the tenant IANA time zone, strictly after the tenant's current date, and restricted to configured estimate weekdays.
- **Time:** normalized inside the configured inclusive estimate window.
- **Notes:** optional, with `none` used for a clear negative response.
- **Consent:** must be an explicit yes.
- **Confirmation:** applies only to the current lead revision; any correction clears the prior confirmation.
- **OCM response:** must be successful JSON and must not identify a different client.

Service-area eligibility is not inferred from free-form text. It should be enforced only when OCM supplies a structured eligibility rule.

## Intake delivery contract

Every confirmed lead receives a stable SHA-256 intake request ID derived from the call session and confirmed payload.

The bridge sends:

```text
Authorization: Bearer <intakeToken>       # when OCM supplies one
Idempotency-Key: <intakeRequestId>
Content-Type: application/json
```

Retries reuse the same idempotency key. HTTP 429 and 5xx responses may be retried; semantic failures, client mismatches, and invalid 2xx response bodies are not retried.

For complete identity binding, OCM should derive the client from the intake token and use the idempotency key when persisting the lead.

## Structure

```text
server-modular.js             Telnyx webhook, authenticated media stream, call lifecycle
runtime-loader.js              Signed OCM runtime lookup and endpoint validation
receptionist-core.js           Per-tenant core factory and OCM payload mapping
intake-schema.js               Canonical name, phone, address, service, date, and time rules
ocm-delivery.js                Idempotent, verified intake delivery
voice-pipeline-controller.js   Deterministic call state and question progression
receptionist-phrases.js        Single caller-facing phrase catalog
modular-intake-logic.js        Field capture and completion rules
realtime-turn-interpreter.js   Bounded structured caller interpretation
openai-voice.js                Realtime audio transport, transcription, and speech
ordered-log.js                 Ordered stdout logging
```

Routine debug events record state transitions and field names, not raw caller transcripts or complete leads.

## Configuration

Required:

```text
OPENAI_API_KEY
TELNYX_API_KEY
```

One public URL source is also required:

```text
PUBLIC_URL
# or Railway-provided RAILWAY_PUBLIC_DOMAIN
```

Optional for an approved staging control plane:

```text
OCM_RUNTIME_ENDPOINT
```

Do not configure per-business Railway variables. OCM supplies the business profile and exact client routing for each call.

## Endpoints

```text
POST /voice-api-webhook
GET  /health
WS   /media-stream             # signed URLs only
```

## Verification

```bash
npm install
npm run check
npm test
npm start
```

Never commit provider credentials, OCM tokens, caller transcripts, or private lead data.
