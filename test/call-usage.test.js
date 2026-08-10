import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCallUsageRecord, reportCallUsage } from '../call-usage.js';

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

test('call usage records a completed submitted lead without caller information', () => {
  const record = buildCallUsageRecord({
    callId: 'call-123',
    startedAt: '2026-08-10T12:00:00.000Z',
    endedAt: '2026-08-10T12:02:00.000Z',
    leadSaved: true,
    endReason: 'completed',
    timeZone: 'America/New_York',
    callerPhone: '+15551234567',
  });
  assert.deepEqual(record, {
    action: 'record',
    callId: 'call-123',
    startedAt: '2026-08-10T12:00:00.000Z',
    endedAt: '2026-08-10T12:02:00.000Z',
    durationSeconds: 120,
    leadSaved: true,
    outcome: 'lead-saved',
    endReason: 'completed',
    timeZone: 'America/New_York',
  });
  assert.equal('callerPhone' in record, false);
});

test('duration-limit calls without a lead use the supported outcome', () => {
  const record = buildCallUsageRecord({
    callId: 'call-456',
    startedAt: '2026-08-10T12:00:00.000Z',
    endedAt: '2026-08-10T12:08:00.000Z',
    endReason: 'duration-limit',
  });
  assert.equal(record.durationSeconds, 480);
  assert.equal(record.outcome, 'max-duration-no-lead');
});

test('usage reporting retries a temporary ARK failure', async () => {
  let calls = 0;
  const result = await reportCallUsage({
    usageUrl: 'https://example.test/call-usage',
    record: buildCallUsageRecord({ callId: 'call-789' }),
    retryDelayMs: 0,
    fetchImpl: async (_url, options) => {
      calls += 1;
      const sent = JSON.parse(options.body);
      assert.equal(sent.callId, 'call-789');
      return calls === 1 ? response(503, { error: 'try again' }) : response(200, { ok: true });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test('usage reporting sends the private connection credential only in a header', async () => {
  await reportCallUsage({
    usageUrl: 'https://example.test/call-usage?clientId=business-one',
    usageKey: 'private-connection-key',
    record: buildCallUsageRecord({ callId: 'call-header' }),
    fetchImpl: async (url, options) => {
      assert.equal(url.includes('private-connection-key'), false);
      assert.equal(options.headers['x-ark-connection-key'], 'private-connection-key');
      return response(200, { ok: true });
    },
  });
});

test('usage reporting is skipped when ARK supplied no endpoint', async () => {
  let called = false;
  const result = await reportCallUsage({
    usageUrl: '',
    record: buildCallUsageRecord({ callId: 'call-skip' }),
    fetchImpl: async () => { called = true; },
  });
  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(called, false);
});
