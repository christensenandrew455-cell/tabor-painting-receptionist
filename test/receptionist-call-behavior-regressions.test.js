import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildPreparedSummarySpeech,
  callerTranscriptDisposition,
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

const NEW_NOTES_PROMPT = "Do you have any notes for the project or any questions about the business you'd like me to help with or pass along?";
const PRE_SUBMIT = "Okay, thanks for confirming. I'm sending the estimate request in now.";
const DID_NOT_CATCH = "I'm sorry, I didn't catch that.";

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

function caller(socket, text, itemId = `caller-${Date.now()}`) {
  socket.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  });
}

function assistantResponse(socket, {
  responseId,
  itemId,
  audio,
  transcript,
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
  if (transcript !== undefined) {
    socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: responseId,
      item_id: itemId,
      transcript,
    });
  }
  socket.receive({
    type: 'response.done',
    response: {
      id: responseId,
      output: [
        ...(transcript === undefined ? [] : [{
          id: itemId,
          type: 'message',
          content: [{ type: 'audio', transcript }],
        }]),
        ...extraOutput,
      ],
    },
  });
}

async function createHarness() {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const audio = [];
  const clears = [];
  const transcripts = [];
  const errors = [];

  const receptionist = createGuardedOpenAiReceptionist({
    context: CONTEXT,
    runtime: { clientId: 'client-123' },
    callControlId: 'call-regression',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    onAudio: (payload) => { audio.push(payload); },
    onClear: () => { clears.push(true); },
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
  socket.receive({ type: 'session.updated', session: {} });

  return {
    previousApiKey,
    receptionist,
    socket,
    audio,
    clears,
    transcripts,
    errors,
    restore() {
      receptionist.close();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    },
  };
}

test('classifies hesitation separately from unintelligible transcription', () => {
  assert.equal(callerTranscriptDisposition('Uh...'), 'filler');
  assert.equal(callerTranscriptDisposition('Um'), 'filler');
  assert.equal(callerTranscriptDisposition('어'), 'filler');
  assert.equal(callerTranscriptDisposition('aa'), 'unclear');
  assert.equal(callerTranscriptDisposition('Probably Monday at like 1.'), 'meaningful');
});

test('blocks punctuation-only and process-only receptionist output', () => {
  assert.equal(shouldBlockReceptionistOutput('…'), true);
  assert.equal(shouldBlockReceptionistOutput('Okay, let’s keep this moving.'), true);
  assert.equal(shouldBlockReceptionistOutput('Let me grab the details.'), true);
  assert.equal(shouldBlockReceptionistOutput('What date and time would work best for the estimate?'), false);
});

test('uses the smoother notes question after scheduling', () => {
  assert.equal(
    repairInstructionForBlockedOutput({ answeredField: 'schedule' }),
    `Say exactly: "${NEW_NOTES_PROMPT}" Do not add anything before or after it.`,
  );
});

test('builds one clean summary with no duplicate fields or Note: None', () => {
  const speech = buildPreparedSummarySpeech({
    name: 'Andrew Christensen',
    service: 'Exterior Painting',
    address: '197 Lancaster Road in Berlin, Massachusetts.',
    preferredDateAndTime: 'Monday, August 10, 2026 at 1:00 PM',
    notes: 'None',
  });

  assert.equal(
    speech,
    "Okay, here's the summary. Andrew Christensen is requesting Exterior Painting at 197 Lancaster Road in Berlin, Massachusetts. The preferred date and time is Monday, August 10, 2026 at 1:00 PM. There are no additional notes. Does that all sound right?",
  );
  assert.doesNotMatch(speech, /Note:\s*None/i);
  assert.equal((speech.match(/197 Lancaster Road/g) || []).length, 1);
  assert.equal((speech.match(/Monday, August 10, 2026/g) || []).length, 1);
});

test('a filler turn produces no late receptionist audio and no repair speech', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'schedule-question',
      itemId: 'schedule-question-item',
      audio: 'schedule-question-audio',
      transcript: 'What date and time would work best for the estimate?',
    });

    const beforeRepairs = h.socket.sent.filter((event) => event.type === 'response.create').length;

    h.socket.receive({ type: 'response.created', response: { id: 'filler-response' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'filler-response',
      item_id: 'filler-item',
      delta: 'should-never-play',
    });
    caller(h.socket, 'Uh...', 'caller-filler');
    h.socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'filler-response',
      item_id: 'filler-item',
      transcript: '…',
    });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'filler-response',
        output: [{
          id: 'filler-item',
          type: 'message',
          content: [{ type: 'audio', transcript: '…' }],
        }],
      },
    });

    const afterRepairs = h.socket.sent.filter((event) => event.type === 'response.create').length;
    assert.equal(h.audio.includes('should-never-play'), false);
    assert.equal(afterRepairs, beforeRepairs);
    assert.equal(
      h.transcripts.some((entry) => entry.speaker === 'receptionist' && entry.text === '…'),
      false,
    );
  } finally {
    h.restore();
  }
});

test('caller speech interrupts and discards already-buffered receptionist output', async () => {
  const h = await createHarness();
  try {
    h.socket.receive({ type: 'response.created', response: { id: 'interrupted-response' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'interrupted-response',
      item_id: 'interrupted-item',
      delta: 'late-buffered-audio',
    });

    h.socket.receive({ type: 'input_audio_buffer.speech_started' });

    h.socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'interrupted-response',
      item_id: 'interrupted-item',
      transcript: 'Take your time.',
    });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'interrupted-response',
        output: [{
          id: 'interrupted-item',
          type: 'message',
          content: [{ type: 'audio', transcript: 'Take your time.' }],
        }],
      },
    });

    assert.equal(h.clears.length, 1);
    assert.equal(h.audio.includes('late-buffered-audio'), false);
    assert.ok(h.socket.sent.some(
      (event) => event.type === 'conversation.item.delete'
        && event.item_id === 'interrupted-item',
    ));
  } finally {
    h.restore();
  }
});

test('unintelligible aa is replaced with a short did-not-catch response', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question',
      itemId: 'notes-question-item',
      audio: 'notes-question-audio',
      transcript: NEW_NOTES_PROMPT,
    });

    caller(h.socket, 'aa', 'caller-unclear');
    assistantResponse(h.socket, {
      responseId: 'bad-unclear-response',
      itemId: 'bad-unclear-item',
      audio: 'bad-unclear-audio',
      transcript: 'If you want, you can just tell me you’re done, or share any notes or questions you have.',
    });

    assert.equal(h.audio.includes('bad-unclear-audio'), false);
    const repair = h.socket.sent
      .filter((event) => event.type === 'response.create')
      .find((event) => event.response?.instructions?.includes(DID_NOT_CATCH));
    assert.ok(repair);
    assert.equal(
      repair.response.instructions,
      `Say exactly: "${DID_NOT_CATCH}" Do not add anything before or after it.`,
    );
  } finally {
    h.restore();
  }
});

test('blocked keep-it-moving narration after no notes repairs directly to consent', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-2',
      itemId: 'notes-question-item-2',
      audio: 'notes-question-audio-2',
      transcript: NEW_NOTES_PROMPT,
    });

    caller(h.socket, "No, I don't have any.", 'caller-no-notes');
    assistantResponse(h.socket, {
      responseId: 'bad-moving-response',
      itemId: 'bad-moving-item',
      audio: 'bad-moving-audio',
      transcript: 'Okay, let’s keep this moving.',
    });

    assert.equal(h.audio.includes('bad-moving-audio'), false);
    const repair = h.socket.sent
      .filter((event) => event.type === 'response.create')
      .find((event) => /Do you consent to being contacted by Tabor Painting/i.test(
        event.response?.instructions || '',
      ));
    assert.ok(repair);
    assert.match(repair.response.instructions, /Okay, thanks\. One more question\./);
    assert.doesNotMatch(repair.response.instructions, /thanks for the notes/i);
  } finally {
    h.restore();
  }
});

test('summary confirmation cannot submit until the required pre-submit sentence is spoken', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'summary-response',
      itemId: 'summary-item',
      audio: 'summary-audio',
      transcript: "Okay, here's the summary. Andrew Christensen is requesting Exterior Painting at 197 Lancaster Road in Berlin, Massachusetts. The preferred date and time is Monday, August 10, 2026 at 1:00 PM. There are no additional notes. Does that all sound right?",
    });

    caller(h.socket, 'Yeah.', 'caller-summary-yes');

    assistantResponse(h.socket, {
      responseId: 'bad-submit-response',
      itemId: 'bad-submit-message',
      audio: 'bad-submit-audio',
      transcript: 'Okay, thanks for confirming.',
      extraOutput: [{
        id: 'bad-submit-call',
        type: 'function_call',
        name: 'submit_estimate_request',
        call_id: 'bad-submit-call-id',
        arguments: JSON.stringify({ caller_confirmed: true }),
      }],
    });

    assert.equal(h.audio.includes('bad-submit-audio'), false);

    const repair = h.socket.sent
      .filter((event) => event.type === 'response.create')
      .find((event) => event.response?.instructions?.includes(PRE_SUBMIT));
    assert.ok(repair);
    assert.match(repair.response.instructions, /submit_estimate_request with caller_confirmed true/i);
    assert.match(repair.response.instructions, /Okay, thanks for confirming\. I'm sending the estimate request in now\./);
  } finally {
    h.restore();
  }
});
