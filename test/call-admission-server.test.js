import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import test from 'node:test';

// Exercise the actual HTTP webhook handler with provider requests intercepted.
// No Telnyx command, OpenAI request, or Admin notification leaves this process.
process.env.PORT = '0';
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.TELNYX_API_KEY = 'test-only';
process.env.OPENAI_API_KEY = 'test-only';
process.env.RECEPTIONIST_CONFIG_URL = 'https://runtime.example.test';
process.env.DEMO_PHONE_NUMBER = '+17742316164';
const originalFetch = globalThis.fetch;
const commands = [];
const runtimeRequests = [];
const commandEvents = new EventEmitter();
globalThis.fetch = async (url, options) => {
  if (String(url) === process.env.RECEPTIONIST_CONFIG_URL) {
    const event = JSON.parse(options.body.toString());
    runtimeRequests.push({ event, headers: options.headers });
    const payload = event.data.payload;
    const id = payload.call_control_id;
    if (id.startsWith('blocked')) return Response.json({ ok: false, code: 'CALLER_COOLDOWN', retryAfterSeconds: 899 }, { status: 429 });
    if (id === 'outage') throw new Error('Runtime unavailable');
    if (id === 'old-runtime') return Response.json({ ok: true, demo: true });
    return Response.json({ ok: true, demo: payload.to === '+17742316164', callAdmission: { allowed: true }, profile: { businessName: 'Regular Business', services: { painting: 'Painting' } } });
  }
  if (String(url).startsWith('https://api.telnyx.com/v2/calls/')) {
    const parts = new URL(url).pathname.split('/');
    commands.push({ id: decodeURIComponent(parts[3]), action: parts[5], body: JSON.parse(options.body) });
    commandEvents.emit('command');
    return Response.json({ data: { result: 'ok' } });
  }
  throw new Error(`Unexpected external fetch: ${new URL(url).origin}`);
};
const { server } = await import('../server.js');
if (!server.listening) await once(server, 'listening');
const webhookUrl = `http://127.0.0.1:${server.address().port}/voice-api-webhook`;
async function webhook(id, to, type = 'call.initiated') {
  const response = await originalFetch(webhookUrl, { method: 'POST', headers: {
    'content-type': 'application/json', 'telnyx-signature-ed25519': 'test-signature', 'telnyx-timestamp': '1789128000',
  }, body: JSON.stringify({ data: { event_type: type, payload: { call_control_id: id, direction: 'incoming', from: '+15085550123', to } } }) });
  assert.equal(response.status, 200);
}
async function waitForCommand(id, action) {
  while (!commands.some((command) => command.id === id && command.action === action)) {
    await once(commandEvents, 'command', { signal: AbortSignal.timeout(2000) });
  }
}
test('both numbers require admission before answer; declined calls never start streaming', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
  });
  for (const [label, phone] of [['demo', '+17742316164'], ['regular', '+15085550999']]) {
    const id = `first-${label}`;
    await webhook(id, phone);
    await waitForCommand(id, 'streaming_start');
    assert.deepEqual(commands.filter((item) => item.id === id).map((item) => item.action), ['answer', 'streaming_start']);
    await webhook(id, phone); // redelivered provider event, still the same call
    assert.equal(runtimeRequests.filter((item) => item.event.data.payload.call_control_id === id).length, 1);
    const blocked = `blocked-${label}`;
    await webhook(blocked, phone);
    await waitForCommand(blocked, 'reject');
    assert.deepEqual(commands.filter((item) => item.id === blocked).map((item) => item.action), ['reject']);
    assert.equal(commands.find((item) => item.id === blocked).body.cause, 'CALL_REJECTED');
    await webhook(id, phone, 'call.hangup');
  }
  for (const id of ['outage', 'old-runtime']) {
    await webhook(id, '+17742316164');
    await waitForCommand(id, 'reject');
    assert.deepEqual(commands.filter((item) => item.id === id).map((item) => item.action), ['reject']);
  }
  assert.equal(runtimeRequests[0].headers['telnyx-signature-ed25519'], 'test-signature');
  assert.ok(commands.every((item) => item.body.command_id));
});
