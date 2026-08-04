import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntakeRequestId, deliverIntake } from '../ocm-delivery.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

const delivery = Object.freeze({
  url: 'https://ocm.example.com/intake',
  token: 'temporary-token',
  clientId: 'Client:Exact_01',
  callSessionId: 'call-123',
  payload: { clientId: 'Client:Exact_01', Name: 'Taylor Morgan' },
  timeoutMs: 1000,
});

test('intake request IDs are stable for the same confirmed call and payload', () => {
  const first = createIntakeRequestId(delivery);
  const second = createIntakeRequestId(delivery);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('successful delivery preserves exact identity and authorization', async () => {
  let request;
  const result = await deliverIntake({
    ...delivery,
    fetchImpl: async (_url, init) => {
      request = init;
      return response(200, { ok: true, clientId: 'Client:Exact_01', intakeId: 'lead-1' });
    },
  });
  const body = JSON.parse(request.body);
  assert.equal(request.headers.Authorization, 'Bearer temporary-token');
  assert.equal(request.headers['Idempotency-Key'], result.intakeRequestId);
  assert.equal(body.clientId, 'Client:Exact_01');
  assert.equal(body.callSessionId, 'call-123');
  assert.equal(body.intakeRequestId, result.intakeRequestId);
  assert.equal(result.data.intakeId, 'lead-1');
});

test('semantic failure and non-JSON success are never marked successful or retried', async () => {
  let semanticAttempts = 0;
  await assert.rejects(
    deliverIntake({
      ...delivery,
      fetchImpl: async () => {
        semanticAttempts += 1;
        return response(200, { ok: false, error: 'rejected' });
      },
    }),
    /rejected/,
  );
  assert.equal(semanticAttempts, 1);

  let invalidAttempts = 0;
  await assert.rejects(
    deliverIntake({
      ...delivery,
      fetchImpl: async () => {
        invalidAttempts += 1;
        return response(200, 'not-json');
      },
    }),
    /non-JSON/,
  );
  assert.equal(invalidAttempts, 1);
});

test('transient failures retry with the same idempotency key', async () => {
  const keys = [];
  let attempt = 0;
  const result = await deliverIntake({
    ...delivery,
    fetchImpl: async (_url, init) => {
      attempt += 1;
      keys.push(init.headers['Idempotency-Key']);
      if (attempt === 1) return response(503, { ok: false, error: 'temporary' });
      return response(200, { ok: true, clientId: 'Client:Exact_01', intakeId: 'lead-2' });
    },
  });
  assert.equal(attempt, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(result.data.intakeId, 'lead-2');
});

test('a mismatched client confirmation fails closed', async () => {
  await assert.rejects(
    deliverIntake({
      ...delivery,
      fetchImpl: async () => response(200, {
        ok: true,
        clientId: 'DifferentClient',
        intakeId: 'lead-3',
      }),
    }),
    /different client/,
  );
});
