function clean(value) {
  return String(value ?? '').trim();
}

export function buildArcRuntimeForward({
  event,
  rawBody,
  telnyxSignature,
  telnyxTimestamp,
} = {}) {
  const body = Buffer.isBuffer(rawBody)
    ? Buffer.from(rawBody)
    : Buffer.from(
      typeof rawBody === 'string' && rawBody.length
        ? rawBody
        : JSON.stringify(event ?? {}),
      'utf8',
    );
  const signature = clean(telnyxSignature);
  const timestamp = clean(telnyxTimestamp);

  return Object.freeze({
    body,
    headers: Object.freeze({
      'Content-Type': 'application/json',
      ...(signature ? { 'telnyx-signature-ed25519': signature } : {}),
      ...(timestamp ? { 'telnyx-timestamp': timestamp } : {}),
    }),
  });
}
