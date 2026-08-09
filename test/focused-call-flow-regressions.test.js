import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGuardedOpenAiReceptionist } from '../receptionist-output-guard.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  clientId: 'client-123',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '09:00',
  latestEstimateStart: '16:00',
  services: [
    { name: 'Wood Staining', description: 'Wood staining' },
    { name: 'Exterior Painting', description: 'Exterior painting' },
    { name: 'Interior Painting', description: 'Interior painting' },
    { name: 'Small Paint Repair', description: 'Small paint repair' },
  ],
  knowledgeJson: JSON.stringify({
    businessHours: 'Monday through Friday',
    serviceAreas: ['Local service area'],
  }),
});

const SERVICE_QUESTION = 'What kind of work do you need done?';
const NOTES_PROMPT = 'Do you have any notes or questions for the business?';
const MORE_NOTES_PROMPT = 'Do you have any other notes or questions for the business?';
const PRE_SUBMIT = "Okay, thanks for confirming. I'm sending the estimate request in now.";
const SUCCESS = "You're all set. Your estimate request has been submitted.";

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
  transcript = '',
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
  if (transcript) {
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
        ...(transcript ? [{
          id: itemId,
          type: 'message',
          content: [{ type: 'audio', transcript }],
        }] : []),
        ...extraOutput,
      ],
    },
  });
}

async function createHarness() {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const audio = [];
  const transcripts = [];
  const errors = [];
  const submitted = [];
  const goodbye = [];

  const receptionist = createGuardedOpenAiReceptionist({
    context: CONTEXT,
    runtime: { clientId: 'client-123' },
    callControlId: 'call-focused-regression',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    onAudio: (payload) => { audio.push(payload); },
    onClear: () => {},
    onSubmitted: (snapshot) => { submitted.push(snapshot); },
    onReady: () => {},
    onTranscript: (entry) => { transcripts.push(entry); },
    onGoodbyeComplete: () => { goodbye.push(true); },
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
    transcripts,
    errors,
    submitted,
    goodbye,
    restore() {
      receptionist.close();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    },
  };
}

function responseCreates(socket) {
  return socket.sent.filter((event) => event.type === 'response.create');
}

function latestResponseCreate(socket) {
  return responseCreates(socket).at(-1);
}

test('greeting asks for the work in ordinary caller language', async () => {
  const h = await createHarness();
  try {
    const greeting = responseCreates(h.socket).find((event) =>
      event.response?.instructions?.includes('Hi, thank you for calling Tabor Painting.'),
    );
    assert.ok(greeting);
    assert.match(greeting.response.instructions, new RegExp(SERVICE_QUESTION.replace(/[?]/g, '\\?')));
    assert.doesNotMatch(greeting.response.instructions, /What service were you looking for/i);
  } finally {
    h.restore();
  }
});

test('a name-only answer cannot skip the address question', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'name-question',
      itemId: 'name-question-item',
      transcript: 'What name should I use for the estimate request?',
      audio: 'name-question-audio',
    });
    caller(h.socket, 'Andrew Christensen works the best.', 'caller-name');
    assistantResponse(h.socket, {
      responseId: 'wrong-next-field',
      itemId: 'wrong-next-field-item',
      transcript: 'What date and time would work best for the estimate?',
      audio: 'wrong-next-field-audio',
    });

    assert.equal(h.audio.includes('wrong-next-field-audio'), false);
    assert.match(
      latestResponseCreate(h.socket).response.instructions,
      /What's the complete project address\?/,
    );
  } finally {
    h.restore();
  }
});

test('an answer to a different field re-asks the field that was actually pending', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'address-question',
      itemId: 'address-question-item',
      transcript: "What's the complete project address?",
      audio: 'address-question-audio',
    });
    caller(h.socket, 'Monday at 1.', 'caller-wrong-field');
    assistantResponse(h.socket, {
      responseId: 'bad-advance',
      itemId: 'bad-advance-item',
      transcript: NOTES_PROMPT,
      audio: 'bad-advance-audio',
    });

    assert.equal(h.audio.includes('bad-advance-audio'), false);
    assert.match(
      latestResponseCreate(h.socket).response.instructions,
      /I'm sorry, I was asking for the project address\. What's the complete project address\?/,
    );
  } finally {
    h.restore();
  }
});

test('a supported business question stays inside the notes loop instead of restarting intake', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-services',
      itemId: 'notes-question-services-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-services-audio',
    });
    caller(h.socket, 'What services do you guys offer?', 'caller-services-question');
    assistantResponse(h.socket, {
      responseId: 'bad-services-answer',
      itemId: 'bad-services-answer-item',
      transcript: 'We offer wood staining, exterior painting, interior painting, and small paint repair. What service were you looking for?',
      audio: 'bad-services-answer-audio',
    });

    assert.equal(h.audio.includes('bad-services-answer-audio'), false);
    const repair = latestResponseCreate(h.socket).response.instructions;
    assert.match(repair, /supplied structured business data/i);
    assert.match(repair, new RegExp(MORE_NOTES_PROMPT.replace(/[?]/g, '\\?')));
    assert.doesNotMatch(repair, /ask.*service were you looking for/i);
  } finally {
    h.restore();
  }
});

test('an unsupported multi-part business question is not answered from general knowledge', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-duration',
      itemId: 'notes-question-duration-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-duration-audio',
    });
    caller(h.socket, 'How long does it normally take, like...', 'caller-duration-1');
    caller(h.socket, 'Do a paint job.', 'caller-duration-2');
    assistantResponse(h.socket, {
      responseId: 'hallucinated-duration',
      itemId: 'hallucinated-duration-item',
      transcript: 'It usually takes a day or two. Do you consent to being contacted by Tabor Painting?',
      audio: 'hallucinated-duration-audio',
    });

    assert.equal(h.audio.includes('hallucinated-duration-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "Okay, I'll add it to the notes. ${MORE_NOTES_PROMPT}" Do not add anything before or after it.`,
    );
  } finally {
    h.restore();
  }
});

test('notes do not advance to consent until the caller explicitly says they are done', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-note',
      itemId: 'notes-question-note-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-note-audio',
    });
    caller(h.socket, 'Please note that the shed needs prep work.', 'caller-note');
    assistantResponse(h.socket, {
      responseId: 'premature-consent',
      itemId: 'premature-consent-item',
      transcript: 'Okay, thanks for the notes. One more question. Do you consent to being contacted by Tabor Painting?',
      audio: 'premature-consent-audio',
    });

    assert.equal(h.audio.includes('premature-consent-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "${MORE_NOTES_PROMPT}" Do not add anything before or after it.`,
    );

    caller(h.socket, 'No, that is all.', 'caller-notes-done');
    assistantResponse(h.socket, {
      responseId: 'wrong-after-done',
      itemId: 'wrong-after-done-item',
      transcript: MORE_NOTES_PROMPT,
      audio: 'wrong-after-done-audio',
    });
    assert.equal(h.audio.includes('wrong-after-done-audio'), false);
    assert.match(
      latestResponseCreate(h.socket).response.instructions,
      /Okay, thanks for the notes\. One more question\. Do you consent to being contacted by Tabor Painting\?/,
    );
  } finally {
    h.restore();
  }
});

test('consent yes cannot be followed by ZIP, unit, suite, apartment, or address reconfirmation', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'consent-question',
      itemId: 'consent-question-item',
      transcript: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
      audio: 'consent-question-audio',
    });
    caller(h.socket, 'Yes.', 'caller-consent-yes');
    assistantResponse(h.socket, {
      responseId: 'bad-unit-question',
      itemId: 'bad-unit-question-item',
      transcript: 'Is there a unit, apartment number, or suite for that address?',
      audio: 'bad-unit-question-audio',
    });

    assert.equal(h.audio.includes('bad-unit-question-audio'), false);
    assert.match(latestResponseCreate(h.socket).response.instructions, /Call prepare_estimate_summary now/i);
    assert.doesNotMatch(latestResponseCreate(h.socket).response.instructions, /ask.*unit|ask.*zip/i);
  } finally {
    h.restore();
  }
});

test('a real submit allows the success message and exact thank-you goodbye', async () => {
  const h = await createHarness();
  try {
    caller(h.socket, '197 Lancaster Road, Berlin, Massachusetts.', 'caller-address-evidence');
    assistantResponse(h.socket, {
      responseId: 'consent-for-prepare',
      itemId: 'consent-for-prepare-item',
      transcript: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
      audio: 'consent-for-prepare-audio',
    });
    caller(h.socket, 'Yes.', 'caller-consent-for-prepare');

    assistantResponse(h.socket, {
      responseId: 'prepare-response',
      itemId: 'prepare-response-item',
      extraOutput: [{
        id: 'prepare-call-item',
        type: 'function_call',
        name: 'prepare_estimate_summary',
        call_id: 'prepare-call-id',
        arguments: JSON.stringify({
          service: 'Exterior Painting',
          name: 'Andrew Christensen',
          address: '197 Lancaster Road, Berlin, Massachusetts.',
          preferred_date: 'Monday',
          preferred_time: '1 PM',
          additional_notes: '',
          additional_notes_asked: true,
          consent_to_contact: true,
          consent_asked_separately: true,
        }),
      }],
    });
    await nextTurn();

    const summaryRequest = responseCreates(h.socket).find((event) =>
      /Use only the returned summary values|Okay, here's the summary/i.test(event.response?.instructions || ''),
    );
    assert.ok(summaryRequest);

    const summarySpeechMatch = summaryRequest.response.instructions.match(/Say exactly: ("(?:[^"\\]|\\.)*")/);
    assert.ok(summarySpeechMatch);
    const summarySpeech = JSON.parse(summarySpeechMatch[1]);
    assistantResponse(h.socket, {
      responseId: 'summary-readback',
      itemId: 'summary-readback-item',
      transcript: summarySpeech,
      audio: 'summary-readback-audio',
    });
    caller(h.socket, 'Yes.', 'caller-summary-yes');

    assistantResponse(h.socket, {
      responseId: 'submit-response',
      itemId: 'submit-response-item',
      transcript: PRE_SUBMIT,
      audio: 'pre-submit-audio',
      extraOutput: [{
        id: 'submit-call-item',
        type: 'function_call',
        name: 'submit_estimate_request',
        call_id: 'submit-call-id',
        arguments: JSON.stringify({ caller_confirmed: true }),
      }],
    });
    await nextTurn();
    await nextTurn();

    const successRequest = responseCreates(h.socket).find((event) =>
      event.response?.instructions?.includes(SUCCESS),
    );
    assert.ok(successRequest);
    assistantResponse(h.socket, {
      responseId: 'success-response',
      itemId: 'success-response-item',
      transcript: SUCCESS,
      audio: 'success-audio',
    });

    assert.equal(h.audio.includes('success-audio'), true);
    const goodbyeRequest = latestResponseCreate(h.socket);
    assert.match(goodbyeRequest.response.instructions, /Thank you for calling Tabor Painting\. Have a good day\./);
    assert.doesNotMatch(goodbyeRequest.response.instructions, /Thanks for calling Tabor Painting/);
  } finally {
    h.restore();
  }
});
