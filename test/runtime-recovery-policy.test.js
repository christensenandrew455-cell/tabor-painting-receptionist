import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_HANDOFF_PARAM,
  RUNTIME_HANDOFF_TTL_MS,
  appendRuntimeHandoff,
  callEnvelopeFromTelnyxBody,
  decodeRuntimeHandoff,
  encodeRuntimeHandoff,
  runtimeDataFromOcmResponse,
} from '../runtime-recovery-policy.js';

const secret = 'test-runtime-secret';
const runtimeData = {
  clientId: 'tabor-painting',
  calledPhone: '+15551234567',
  profile: {
    businessName: 'Tabor Painting',
    receptionistName: 'Alex',
    services: { 'interior painting': 'Interior painting.' },
  },
  intakeUrl: 'https://example.com/api/intake?key=private',
  usageUrl: 'https://example.com/api/receptionist/call-usage?key=private',
};

test('encrypts and restores a matched call runtime without exposing profile text', () => {
  const now = 1_000_000;
  const token = encodeRuntimeHandoff({
    callControlId: 'call-123',
    metadata: {
      runtimeData,
      callerPhone: '+15557654321',
      calledPhone: '+15551234567',
    },
  }, secret, now);

  assert.equal(token.includes('Tabor'), false);
  const restored = decodeRuntimeHandoff(token, secret, now + 1000);
  assert.equal(restored.callControlId, 'call-123');
  assert.equal(restored.metadata.runtimeData.clientId, 'tabor-painting');
  assert.equal(restored.metadata.callerPhone, '+15557654321');
});

test('rejects expired or tampered handoff tokens', () => {
  const now = 2_000_000;
  const token = encodeRuntimeHandoff({
    callControlId: 'call-456',
    metadata: { runtimeData },
  }, secret, now);

  assert.throws(
    () => decodeRuntimeHandoff(token, secret, now + RUNTIME_HANDOFF_TTL_MS + 1),
    /expired or incomplete/i,
  );
  assert.throws(() => decodeRuntimeHandoff(`${token.slice(0, -1)}x`, secret, now), /authenticate|invalid|expired/i);
});

test('adds the encrypted handoff and call ID to the media stream URL', () => {
  const result = new URL(appendRuntimeHandoff('wss://example.com/media-stream', {
    callControlId: 'call-789',
    token: 'encrypted-token',
  }));
  assert.equal(result.searchParams.get('callControlId'), 'call-789');
  assert.equal(result.searchParams.get(RUNTIME_HANDOFF_PARAM), 'encrypted-token');
});

test('extracts call identity and phone numbers from a signed Telnyx event body', () => {
  const result = callEnvelopeFromTelnyxBody(JSON.stringify({
    data: {
      event_type: 'call.initiated',
      payload: {
        call_control_id: 'v3:call-control-id',
        from: { phone_number: '+15557654321' },
        to: [{ phone_number: '+15551234567' }],
      },
    },
  }));
  assert.deepEqual(result, {
    callControlId: 'v3:call-control-id',
    callerPhone: '+15557654321',
    calledPhone: '+15551234567',
  });
});

test('normalizes only complete successful ARK OCM runtime responses', () => {
  assert.deepEqual(runtimeDataFromOcmResponse({ ok: true, ...runtimeData }), runtimeData);
  assert.equal(runtimeDataFromOcmResponse({ ok: false, ...runtimeData }), null);
  assert.equal(runtimeDataFromOcmResponse({ ok: true, clientId: 'missing-profile' }), null);
});
