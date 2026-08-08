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

const NEW_NOTES_PROMPT = 'Do you have any notes or questions for the business?';
const PRE_SUBMIT = "Okay, thanks for confirming. I'm sending the estimate request in now.";
const DID_NOT_CATCH = "I'm sorry, I didn't catch that.";
const UNKNOWN_QUESTION_FALLBACK = "Okay, I'll add it to the notes.";

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

test('classifies hesitation and unfinished schedule thoughts separately from meaningful answers', () => {
  assert.equal(callerTranscriptDisposition('Uh...'), 'filler');
  assert.equal(callerTranscriptDisposition('Um'), 'filler');
  assert.equal(callerTranscriptDisposition('어'), 'filler');
  assert.equal(callerTranscriptDisposition("It's probably, like..."), 'filler');
  assert.equal(callerTranscriptDisposition('aa'), 'unclear');
  assert.equal(callerTranscriptDisposition('Probably Monday at like 1.'), 'meaningful');
});

test('does not runtime-block process transitions but still blocks punctuation and reassurance filler', () => {
  assert.equal(shouldBlockReceptionistOutput('…'), true);
  assert.equal(shouldBlockReceptionistOutput('Okay, let’s keep this moving.'), false);
  assert.equal(shouldBlockReceptionistOutput('Let me grab the details.'), false);
  assert.equal(shouldBlockReceptionistOutput('Take your time.'), true);
  assert.equal(shouldBlockReceptionistOutput('What date and time would work best for the estimate?'), false);
});

test('uses the simple notes question after scheduling', () => {
  assert.equal(
    repairInstructionForBlockedOutput({ answeredField: 'schedule' }),
    `Say exactly: "${NEW_NOTES_PROMPT}" Do not add anything before or after it.`,
  );
});

test('session rules use the simple notes question and short unknown-question fallback', async () => {
  const h = await createHarness();
  try {
    const sessionUpdate = h.socket.sent.find((event) => event.type === 'session.update');
    assert.ok(sessionUpdate);
    assert.match(sessionUpdate.session.instructions, /Do you have any notes or questions for the business\?/);
    assert.doesNotMatch(sessionUpdate.session.instructions, /you'd like me to help with or pass along/i);
    assert.match(sessionUpdate.session.instructions, /Okay, I'll add it to the notes\./);
    assert.doesNotMatch(sessionUpdate.session.instructions, /I'm sorry, I don't really know that/i);
  } finally {
    h.restore();
  }
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
    h.socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'filler-response',
      item_id: 'filler-item',
      transcript: '…',
    });
    caller(h.socket, 'Uh...', 'caller-filler');
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

test('blocked reassurance after no notes repairs directly to consent', async () => {
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
      responseId: 'bad-reassurance-response',
      itemId: 'bad-reassurance-item',
      audio: 'bad-reassurance-audio',
      transcript: 'Take your time.',
    });

    assert.equal(h.audio.includes('bad-reassurance-audio'), false);
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

test('pre-submit sentence stays buffered until the same response contains the submit tool call', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'summary-response-pairing',
      itemId: 'summary-item-pairing',
      audio: 'summary-audio-pairing',
      transcript: "Okay, here's the summary. Andrew Christensen is requesting Exterior Painting at 197 Lancaster Road in Berlin, Massachusetts. The preferred date and time is Monday, August 10, 2026 at 1:00 PM. There are no additional notes. Does that all sound right?",
    });
    caller(h.socket, 'Yes.', 'caller-summary-pairing-yes');

    assistantResponse(h.socket, {
      responseId: 'submit-without-tool',
      itemId: 'submit-without-tool-item',
      audio: 'submit-without-tool-audio',
      transcript: PRE_SUBMIT,
    });

    assert.equal(h.audio.includes('submit-without-tool-audio'), false);
    const repair = h.socket.sent
      .filter((event) => event.type === 'response.create')
      .find((event) => /submit_estimate_request with caller_confirmed true/i.test(
        event.response?.instructions || '',
      ));
    assert.ok(repair);

    assistantResponse(h.socket, {
      responseId: 'submit-with-tool',
      itemId: 'submit-with-tool-message',
      audio: 'submit-with-tool-audio',
      transcript: PRE_SUBMIT,
      extraOutput: [{
        id: 'submit-with-tool-call-item',
        type: 'function_call',
        name: 'submit_estimate_request',
        call_id: 'submit-with-tool-call-id',
        arguments: JSON.stringify({ caller_confirmed: true }),
      }],
    });

    assert.equal(h.audio.includes('submit-with-tool-audio'), true);
    assert.equal(
      h.audio.filter((payload) => payload === 'submit-with-tool-audio').length,
      1,
    );
  } finally {
    h.restore();
  }
});
