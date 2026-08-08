import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createGuardedOpenAiReceptionist,
  shouldBlockReceptionistOutput,
} from '../receptionist-output-guard.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  clientId: 'client-123',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '09:00',
  latestEstimateStart: '16:00',
  services: [{ name: 'Exterior Painting', description: 'Exterior structures' }],
  knowledgeJson: '{}',
});

const PRE_SUBMIT = "Okay, thanks for confirming. I'm sending the estimate request in now.";
const SUBMIT_FAILURE = "I'm sorry, I can't send the estimate request.";
const CONSENT = 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?';
const SUMMARY = "Okay, here's the summary. Andrew Christensen is requesting Exterior Painting at 197 Lancaster Road, Sterling, Massachusetts. The preferred date and time is Monday, August 10, 2026 at 1:00 PM. There are no additional notes. Does that all sound right?";

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

function caller(socket, text, itemId) {
  socket.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  });
}

function assistantResponse(socket, {
  responseId,
  itemId,
  transcript,
  audio = '',
  extraOutput = [],
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
      output: [
        {
          id: itemId,
          type: 'message',
          content: [{ type: 'audio', transcript }],
        },
        ...extraOutput,
      ],
    },
  });
}

async function createHarness() {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const audio = [];

  const receptionist = createGuardedOpenAiReceptionist({
    context: CONTEXT,
    runtime: { clientId: 'client-123' },
    callControlId: 'call-gates',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    onAudio: (payload) => audio.push(payload),
    onClear: () => {},
    onSubmitted: () => {},
    onReady: () => {},
    onTranscript: () => {},
    onGoodbyeComplete: () => {},
    onCostLimit: () => {},
    onUsage: () => {},
    onError: (error) => assert.fail(error.message),
    WebSocketClass: FakeWebSocket,
  });

  await nextTurn();
  const socket = FakeWebSocket.instance;
  socket.receive({ type: 'session.updated', session: {} });

  return {
    receptionist,
    socket,
    audio,
    restore() {
      receptionist.close();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    },
  };
}

test('blocks invented ZIP requests while keeping the normal address question valid', () => {
  assert.equal(shouldBlockReceptionistOutput("What's the complete project address?"), false);
  assert.equal(shouldBlockReceptionistOutput("What's the ZIP code for that location?"), true);
  assert.equal(shouldBlockReceptionistOutput('I just need you to confirm the ZIP code.'), true);
});

test('contact-consent yes cannot trigger the pre-submit sentence or submit tool', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'consent-response',
      itemId: 'consent-item',
      transcript: CONSENT,
      audio: 'consent-audio',
    });
    caller(h.socket, 'Yes.', 'caller-consent-yes');

    assistantResponse(h.socket, {
      responseId: 'premature-submit-response',
      itemId: 'premature-submit-item',
      transcript: PRE_SUBMIT,
      audio: 'premature-submit-audio',
      extraOutput: [{
        id: 'premature-submit-call-item',
        type: 'function_call',
        name: 'submit_estimate_request',
        call_id: 'premature-submit-call',
        arguments: JSON.stringify({ caller_confirmed: true }),
      }],
    });

    await nextTurn();
    assert.equal(h.audio.includes('premature-submit-audio'), false);
    assert.equal(
      h.socket.sent.some(
        (event) => event.type === 'conversation.item.create'
          && event.item?.call_id === 'premature-submit-call',
      ),
      false,
    );
    assert.ok(
      h.socket.sent.some(
        (event) => event.type === 'response.create'
          && /Call prepare_estimate_summary now/i.test(event.response?.instructions || ''),
      ),
    );
  } finally {
    h.restore();
  }
});

test('a failed submit follow-up is only the requested apology sentence', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'summary-response',
      itemId: 'summary-item',
      transcript: SUMMARY,
      audio: 'summary-audio',
    });
    caller(h.socket, 'Yeah.', 'caller-summary-yes');

    assistantResponse(h.socket, {
      responseId: 'submit-response',
      itemId: 'submit-message-item',
      transcript: PRE_SUBMIT,
      audio: 'submit-audio',
      extraOutput: [{
        id: 'submit-call-item',
        type: 'function_call',
        name: 'submit_estimate_request',
        call_id: 'submit-call',
        arguments: JSON.stringify({ caller_confirmed: true }),
      }],
    });

    await nextTurn();
    const followup = h.socket.sent
      .filter((event) => event.type === 'response.create')
      .at(-1);
    assert.equal(
      followup.response.instructions,
      `Say exactly: "${SUBMIT_FAILURE}" Do not add anything before or after it.`,
    );
    assert.doesNotMatch(followup.response.instructions, /ZIP|clarification|Explain this problem/i);
  } finally {
    h.restore();
  }
});
