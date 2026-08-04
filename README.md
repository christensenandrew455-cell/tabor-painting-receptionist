# Transport Shell

This repository intentionally contains only the bidirectional connection shell:

- Railway process boot and environment wiring
- Telnyx inbound call webhook
- Telnyx bidirectional media WebSocket
- ARC runtime lookup
- ARC outbound data endpoint
- Optional ARC media WebSocket relay

There is no AI model, receptionist prompt, controller, intake flow, business logic, logging layer, or test suite in this reset.

## Required environment

```text
TELNYX_API_KEY
PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN
RECEPTIONIST_CONFIG_URL or ARC_RUNTIME_URL
```

## Optional environment

```text
RECEPTIONIST_CONFIG_SECRET or ARC_RUNTIME_SECRET
ARC_INTAKE_URL
ARC_INTAKE_TOKEN
ARC_MEDIA_WEBSOCKET_URL
PORT
```

## Endpoints

```text
GET  /
GET  /health
POST /voice-api-webhook
POST /arc/send
WS   /media-stream
```
