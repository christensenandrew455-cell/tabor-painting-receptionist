import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('the receptionist exposes no manual lead-forwarding endpoint', () => {
  assert.equal(serverSource.includes("app.post('/arc/send'"), false);
  assert.ok(serverSource.includes("app.post('/voice-api-webhook'"));
  assert.ok(serverSource.includes("url.pathname !== '/media-stream'"));
});

test('the server does not duplicate full call transcripts into logs', () => {
  assert.equal(serverSource.includes('[Call transcript]'), false);
  assert.equal(serverSource.includes('[Call transcript line]'), false);
  assert.equal(serverSource.includes('onTranscript:'), false);
  assert.equal(serverSource.includes('transcript: []'), false);
});
