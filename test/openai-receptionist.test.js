import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildReceptionistInstructions,
  buildSessionUpdate,
  createOpenAiReceptionist,
  ESTIMATE_TOOLS,
} from '../openai-receptionist.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  receptionistName: 'Alex',
  timeZone: 'America/New_York',
  voice: 'marin',
  clientId: 'client-123',
  services: [{ name: 'Interior Painting', description: 'Walls and ceilings' }],
  knowledgeJson: '{"businessHours":"Monday through Friday"}',
});

test('configures PCMU audio and the two-step estimate tools', () => {
  const event = buildSessionUpdate(CONTEXT);
  assert.equal(event.type, 'session.update');
  assert.equal(event.session.model, 'gpt-realtime-2.1-mini');
  assert.equal(event.session.audio.input.format.type, 'audio/pcmu');
  assert.equal(event.session.audio.output.format.type, 'audio/pcmu');
  assert.equal(event.session.max_output_tokens, 800);
  assert.equal(event.session.truncation.token_limits.post_instructions, 2_500);
  assert.equal(event.session.truncation.retention_ratio, 0.7);
  assert.deepEqual(
    event.session.tools.map((tool) => tool.name),
    ['prepare_estimate_summary', 'submit_estimate_request'],
  );
  assert.equal(ESTIMATE_TOOLS[0].parameters.additionalProperties, false);
});

test('removes estimate tools after a successful submission', () => {
  const event = buildSessionUpdate(CONTEXT, { submitted: true });
  assert.deepEqual(event.session.tools, []);
  assert.match(event.session.instructions, /only remaining job is to answer/i);
  assert.match(event.session.instructions, /Do not collect, prepare, edit, restart, or submit/i);
});

test('prompt separates consent from final submission confirmation', () => {
  const prompt = buildReceptionistInstructions(CONTEXT);
  assert.match(prompt, /A yes to contact permission is not a yes to submit/);
  assert.match(prompt, /Read back every field returned by the tool/);
  assert.match(prompt, /relative date such as "Tuesday,"/);
  assert.match(prompt, /256 output tokens as your normal response ceiling/);
});

class FakeWebSocket extends EventEmitter {
  static instance = null;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 1;
    this.sent = [];
    FakeWebSocket.instance = this;
    queueMicrotask(() => this.emit('open'));
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  receive(value) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }

  close() {
    this.readyState = 3;
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('runs prepare then submit and switches the live session to questions only', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const deliveries = [];
  let submittedSnapshot = null;

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-123',
      callerPhone: '+15555550123',
      deliver: async (payload, options) => {
        deliveries.push({ payload, options });
        return { ok: true };
      },
      onAudio: () => {},
      onClear: () => {},
      onSubmitted: (snapshot) => { submittedSnapshot = snapshot; },
      onReady: () => {},
      onError: (error) => assert.fail(error.message),
      WebSocketClass: FakeWebSocket,
    });

    await nextTurn();
    const socket = FakeWebSocket.instance;
    assert.equal(socket.sent[0].type, 'session.update');
    assert.equal(socket.sent[0].session.tools.length, 2);

    socket.receive({ type: 'session.updated', session: {} });
    assert.ok(socket.sent.some((event) => event.type === 'response.create'));

    socket.receive({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call',
          name: 'prepare_estimate_summary',
          call_id: 'prepare-call',
          arguments: JSON.stringify({
            service: 'Interior Painting',
            name: 'Jordan Smith',
            address: '123 Main Street, Albany, NY 12207',
            preferred_date: '2099-08-12',
            preferred_time: '3:30 PM',
            additional_notes: '',
            consent_to_contact: true,
          }),
        }],
      },
    });
    await nextTurn();

    const prepareOutput = socket.sent.find(
      (event) => event.type === 'conversation.item.create'
        && event.item.call_id === 'prepare-call',
    );
    assert.equal(JSON.parse(prepareOutput.item.output).status, 'ready_for_confirmation');
    assert.equal(deliveries.length, 0);

    socket.receive({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call',
          name: 'submit_estimate_request',
          call_id: 'submit-call',
          arguments: JSON.stringify({ caller_confirmed: true }),
        }],
      },
    });
    await nextTurn();

    assert.equal(deliveries.length, 1);
    assert.equal(submittedSnapshot.phase, 'submitted');
    const postSubmissionUpdate = socket.sent
      .filter((event) => event.type === 'session.update')
      .at(-1);
    assert.deepEqual(postSubmissionUpdate.session.tools, []);
    assert.match(postSubmissionUpdate.session.instructions, /answer the caller's business questions/);
    assert.equal(receptionist.snapshot().submitted, true);
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test('signals the server when the per-call response ceiling is exceeded', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousLimit = process.env.OPENAI_MAX_RESPONSES_PER_CALL;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MAX_RESPONSES_PER_CALL = '10';
  let limitEvent = null;

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-response-limit',
      callerPhone: '+15555550123',
      deliver: async () => ({ ok: true }),
      onAudio: () => {},
      onClear: () => {},
      onSubmitted: () => {},
      onReady: () => {},
      onCostLimit: (event) => { limitEvent = event; },
      onError: (error) => assert.fail(error.message),
      WebSocketClass: FakeWebSocket,
    });
    await nextTurn();

    const socket = FakeWebSocket.instance;
    socket.receive({ type: 'session.updated', session: {} });
    for (let count = 0; count < 10; count += 1) {
      socket.receive({ type: 'response.created', response: { id: `response-${count}` } });
    }

    assert.equal(limitEvent.reason, 'response-limit');
    assert.equal(limitEvent.maximumResponses, 10);
    assert.equal(receptionist.snapshot().responseCount, 10);
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousLimit === undefined) delete process.env.OPENAI_MAX_RESPONSES_PER_CALL;
    else process.env.OPENAI_MAX_RESPONSES_PER_CALL = previousLimit;
  }
});
