import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createOpenAiReceptionist,
  isAddressGroundedInCallerEvidence,
  shouldIgnoreConfirmationTranscript,
} from '../openai-receptionist.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  clientId: 'client-123',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '09:00',
  latestEstimateStart: '16:00',
  services: [{ name: 'Interior Painting', description: 'Walls and ceilings' }],
  knowledgeJson: '{"businessHours":"Monday through Friday"}',
});

class FakeWebSocket extends EventEmitter {
  static instance = null;

  constructor() {
    super();
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

function caller(socket, text, itemId) {
  socket.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: text,
    item_id: itemId,
  });
}

function toolCall(socket, name, callId, args) {
  socket.receive({
    type: 'response.done',
    response: {
      id: `${callId}-response`,
      output: [{
        type: 'function_call',
        name,
        call_id: callId,
        arguments: JSON.stringify(args),
      }],
    },
  });
}

test('grounds a project address across multiple caller turns without inventing a city', () => {
  const callerTranscripts = [
    'That would be 197 Lancaster Road.',
    'Berlin, Massachusetts.',
  ];

  assert.equal(
    isAddressGroundedInCallerEvidence(
      '197 Lancaster Road, Berlin, Massachusetts',
      callerTranscripts,
    ),
    true,
  );
  assert.equal(
    isAddressGroundedInCallerEvidence(
      '197 Lancaster Road, Burlington, Massachusetts',
      callerTranscripts,
    ),
    false,
  );
});

test('treats filler and non-English transcription artifacts as non-answers', () => {
  assert.equal(shouldIgnoreConfirmationTranscript('Um...'), true);
  assert.equal(shouldIgnoreConfirmationTranscript('uh'), true);
  assert.equal(shouldIgnoreConfirmationTranscript('음.'), true);
  assert.equal(shouldIgnoreConfirmationTranscript('어?'), true);
  assert.equal(shouldIgnoreConfirmationTranscript('Yes.'), false);
  assert.equal(shouldIgnoreConfirmationTranscript('No.'), false);
});

test('filler does not consume consent or final-summary confirmation', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const deliveries = [];
  const errors = [];

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-regression',
      callerPhone: '+15555550123',
      deliver: async (payload, options) => {
        deliveries.push({ payload, options });
        return { ok: true };
      },
      onAudio: () => {},
      onClear: () => {},
      onSubmitted: () => {},
      onReady: () => {},
      onTranscript: () => {},
      onError: (error) => { errors.push(error); },
      WebSocketClass: FakeWebSocket,
    });

    await nextTurn();
    const socket = FakeWebSocket.instance;
    socket.receive({ type: 'session.updated', session: {} });

    caller(socket, 'That would be 197 Lancaster Road.', 'address-street');
    caller(socket, 'Berlin, Massachusetts.', 'address-city-state');

    socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'consent-response',
      item_id: 'consent-item',
      transcript: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
    });
    caller(socket, 'Um...', 'consent-filler');
    caller(socket, 'Yes.', 'consent-yes');

    toolCall(socket, 'prepare_estimate_summary', 'prepare-call', {
      service: 'Interior Painting',
      name: 'Jordan Smith',
      address: '197 Lancaster Road, Berlin, Massachusetts',
      preferred_date: '2099-08-12',
      preferred_time: '1:00 PM',
      additional_notes: '',
      additional_notes_asked: true,
      consent_to_contact: true,
      consent_asked_separately: true,
    });
    await nextTurn();

    const prepareOutput = socket.sent.find(
      (event) => event.type === 'conversation.item.create'
        && event.item.call_id === 'prepare-call',
    );
    assert.equal(JSON.parse(prepareOutput.item.output).status, 'ready_for_confirmation');

    socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'summary-response',
      item_id: 'summary-item',
      transcript: 'Jordan Smith is requesting Interior Painting at 197 Lancaster Road, Berlin, Massachusetts. The preferred date and time is Wednesday, August 12, 2099 at 1:00 PM. Does that all sound right?',
    });
    caller(socket, '음.', 'summary-filler');

    toolCall(socket, 'submit_estimate_request', 'submit-before-yes', {
      caller_confirmed: true,
    });
    await nextTurn();

    assert.equal(deliveries.length, 0);
    const blockedSubmit = socket.sent.find(
      (event) => event.type === 'conversation.item.create'
        && event.item.call_id === 'submit-before-yes',
    );
    assert.equal(JSON.parse(blockedSubmit.item.output).ok, false);

    caller(socket, 'Yes.', 'summary-yes');
    toolCall(socket, 'submit_estimate_request', 'submit-after-yes', {
      caller_confirmed: true,
    });
    await nextTurn();

    assert.equal(errors.length, 0);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.Address, '197 Lancaster Road, Berlin, Massachusetts');
    assert.equal(receptionist.snapshot().submitted, true);
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
