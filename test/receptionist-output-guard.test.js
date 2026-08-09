import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createGuardedOpenAiReceptionist,
  repairInstructionForBlockedOutput,
  shouldBlockReceptionistOutput,
} from '../receptionist-output-guard.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  clientId: 'client-123',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '09:00',
  latestEstimateStart: '16:00',
  services: [
    { name: 'Interior Painting', description: 'Walls and ceilings' },
    { name: 'Exterior Painting', description: 'Siding and exterior structures' },
  ],
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
    this.sent.push(JSON.parse(String(value)));
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

function assistantResponse(socket, {
  responseId,
  itemId,
  audio,
  transcript,
}) {
  socket.receive({ type: 'response.created', response: { id: responseId } });
  if (audio) {
    socket.receive({
      type: 'response.output_audio.delta',
      response_id: responseId,
      item_id: itemId,
      delta: audio,
    });
  }
  socket.receive({
    type: 'response.output_audio_transcript.done',
    response_id: responseId,
    item_id: itemId,
    transcript,
  });
  socket.receive({
    type: 'response.done',
    response: {
      id: responseId,
      output: [{
        id: itemId,
        type: 'message',
        content: [{ type: 'audio', transcript }],
      }],
    },
  });
}

test('blocks known process narration and unauthorized address expansion', () => {
  assert.equal(
    shouldBlockReceptionistOutput('Okay, got it. Let me think about the best way to help.'),
    true,
  );
  assert.equal(shouldBlockReceptionistOutput('Let me clarify the missing part of your address.'), true);
  assert.equal(shouldBlockReceptionistOutput('Quick recap so I can confirm everything.'), true);
  assert.equal(
    shouldBlockReceptionistOutput('What’s the full project address, including street, city, state, and ZIP?'),
    true,
  );
  assert.equal(shouldBlockReceptionistOutput('Got it.'), true);

  assert.equal(
    shouldBlockReceptionistOutput('What name should I use for the estimate request?'),
    false,
  );
  assert.equal(shouldBlockReceptionistOutput("What's the full project address?"), false);
  assert.equal(
    shouldBlockReceptionistOutput("Okay, thanks for confirming. I'm sending the estimate request in now."),
    false,
  );
});

test('repairs a blocked response after a usable service answer with the exact name question', () => {
  assert.equal(
    repairInstructionForBlockedOutput({
      answeredField: 'service',
      callerTranscript: 'I need a room painted.',
    }),
    'Say exactly: "What name should I use for the estimate request?" Do not add anything before or after it.',
  );
});

test('does not send blocked narration audio to the caller and repairs after response.done', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const audio = [];
  const transcripts = [];
  const errors = [];

  try {
    const receptionist = createGuardedOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-output-guard',
      callerPhone: '+15555550123',
      deliver: async () => ({ ok: true }),
      onAudio: (payload) => { audio.push(payload); },
      onClear: () => {},
      onSubmitted: () => {},
      onReady: () => {},
      onTranscript: (entry) => { transcripts.push(entry); },
      onGoodbyeComplete: () => {},
      onCostLimit: () => {},
      onUsage: () => {},
      onError: (error) => { errors.push(error); },
      WebSocketClass: FakeWebSocket,
    });

    await nextTurn();
    const socket = FakeWebSocket.instance;
    const sessionUpdate = socket.sent.find((event) => event.type === 'session.update');
    assert.ok(sessionUpdate);
    assert.doesNotMatch(sessionUpdate.session.instructions, /Light acknowledgments.*are encouraged/i);
    assert.match(
      sessionUpdate.session.instructions,
      /Never narrate thinking, planning, field changes, workflow, or internal process/i,
    );

    socket.receive({ type: 'session.updated', session: {} });

    assistantResponse(socket, {
      responseId: 'greeting-response',
      itemId: 'greeting-item',
      audio: 'greeting-audio',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
    });

    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'caller-service',
      transcript: 'Oh, I just kind of need one of my sheds painted out back.',
    });

    socket.receive({ type: 'response.created', response: { id: 'bad-response' } });
    socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'bad-response',
      item_id: 'bad-item',
      delta: 'bad-audio',
    });
    socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'bad-response',
      item_id: 'bad-item',
      transcript: 'Okay, got it. Let me think about the best way to help.',
    });

    assert.deepEqual(audio, ['greeting-audio']);
    assert.equal(
      transcripts.some((entry) => /best way to help/i.test(entry.text)),
      false,
    );

    socket.receive({
      type: 'response.done',
      response: {
        id: 'bad-response',
        output: [{
          id: 'bad-item',
          type: 'message',
          content: [{
            type: 'audio',
            transcript: 'Okay, got it. Let me think about the best way to help.',
          }],
        }],
      },
    });

    const deletion = socket.sent.find(
      (event) => event.type === 'conversation.item.delete' && event.item_id === 'bad-item',
    );
    assert.ok(deletion);

    const repair = socket.sent
      .filter((event) => event.type === 'response.create'
        && /What name should I use for the estimate request/i.test(event.response?.instructions))
      .at(-1);
    assert.ok(repair);
    assert.equal(
      repair.response.instructions,
      'Say exactly: "What name should I use for the estimate request?" Do not add anything before or after it.',
    );

    assistantResponse(socket, {
      responseId: 'repair-response',
      itemId: 'repair-item',
      audio: 'repair-audio',
      transcript: 'What name should I use for the estimate request?',
    });

    assert.deepEqual(audio, ['greeting-audio', 'repair-audio']);
    assert.equal(errors.length, 0);
    assert.equal(
      transcripts.some((entry) => entry.text === 'What name should I use for the estimate request?'),
      true,
    );

    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
