import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArcRuntimeForward } from '../arc-runtime.js';

test('forwards the exact Telnyx body and signature headers to ARK', () => {
  const rawBody = Buffer.from('{"data":{"event_type":"call.initiated"}}', 'utf8');
  const forwarded = buildArcRuntimeForward({
    event: { ignored: true },
    rawBody,
    telnyxSignature: 'signed-value',
    telnyxTimestamp: '1785888000',
  });

  assert.notEqual(forwarded.body, rawBody);
  assert.deepEqual(forwarded.body, rawBody);
  assert.deepEqual(forwarded.headers, {
    'Content-Type': 'application/json',
    'telnyx-signature-ed25519': 'signed-value',
    'telnyx-timestamp': '1785888000',
  });
});

test('falls back to the parsed event when no raw body is available', () => {
  const event = { data: { event_type: 'call.initiated' } };
  const forwarded = buildArcRuntimeForward({ event });

  assert.equal(forwarded.body.toString('utf8'), JSON.stringify(event));
  assert.deepEqual(forwarded.headers, { 'Content-Type': 'application/json' });
});
