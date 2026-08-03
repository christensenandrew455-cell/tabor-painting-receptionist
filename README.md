# ARK AI Receptionist Bridge

This Railway service answers Telnyx calls, runs one deterministic estimate-intake workflow, and saves caller-confirmed leads into the matched ARK OCM workspace.

## Call flow

1. Telnyx sends a signed call event to Railway.
2. Railway forwards the signed event to ARK OCM.
3. ARK OCM verifies the signature and matches the dialed number to one business account.
4. ARK OCM returns that business's facts, services, estimate schedule, voice settings, and private lead endpoints.
5. Railway starts one modular OpenAI Realtime voice pipeline for the call.
6. The controller chooses fixed phrase keys and fixed question order.
7. A lead is saved only after validation, consent, and final caller confirmation.

Caller-facing wording, workflow rules, and model selection stay in this repository. Business facts and voice settings are supplied per call by ARK OCM.

## Railway variables

Required:

```text
OPENAI_API_KEY
TELNYX_API_KEY
```

`PUBLIC_URL` is optional when Railway supplies `RAILWAY_PUBLIC_DOMAIN`. Railway supplies `PORT` automatically.

Do not configure old per-business Railway variables. ARK OCM supplies the temporary per-call business environment internally.

## Deterministic intake order

1. Service
2. Full name
3. Full project address
4. Requested estimate date and time
5. Additional notes
6. Permission to be contacted
7. Final readback and confirmation

The controller—not the model—owns the question order and spoken wording. The Realtime model is limited to transcription, structured interpretation, and exact speech playback.

## Runtime structure

```text
server-modular.js             Telnyx webhook, media stream, call limits, usage reporting
runtime-loader.js              Signed ARK OCM business lookup and runtime cache
receptionist-core.js           Business validation, date/time rules, lead validation, OCM payload
voice-pipeline-controller.js   Deterministic call state and question progression
receptionist-phrases.js        Single caller-facing phrase catalog
modular-intake-logic.js        Field extraction and intake completion rules
realtime-turn-interpreter.js   Structured caller interpretation only
openai-voice.js                Realtime audio, transcription, interpretation, and speech requests
ordered-log.js                 One numbered stdout stream for readable event ordering
```

There is no legacy server or runtime guard chain. `npm start` has one supported production path.

## Ordered logs

Every `console` message is written to stdout with a six-digit sequence number, ISO timestamp, and level:

```text
[000123] 2026-08-03T14:00:00.000Z INFO [Modular receptionist debug] {...}
```

This keeps Railway logs in emission order even when the original call used `console.warn` or `console.error`.

## Telnyx

Voice API webhook:

```text
https://YOUR-RAILWAY-DOMAIN/voice-api-webhook
```

Media stream:

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

Never commit provider credentials or private ARK connection values.
