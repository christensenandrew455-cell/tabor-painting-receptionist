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
const UNKNOWN = "I'm sorry, I don't know that. I'll add that question to the notes.";
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

async function createHarness(context = CONTEXT) {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const audio = [];
  const transcripts = [];
  const errors = [];
  const submitted = [];
  const goodbye = [];

  const receptionist = createGuardedOpenAiReceptionist({
    context,
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

function sessionInstructions(socket) {
  return socket.sent.find((event) => event.type === 'session.update')?.session?.instructions || '';
}

test('session rules remove conflicting business-answer and notes instructions', async () => {
  const h = await createHarness();
  try {
    const instructions = sessionInstructions(h.socket);
    assert.match(instructions, /business information supplied for this call/i);
    assert.match(instructions, /same response may contain the brief grounded answer followed by the one appropriate follow-up question/i);
    assert.match(instructions, /Continue to contact permission only after the caller explicitly says they have no more notes or questions/i);
    assert.match(instructions, /required final summary/i);
    assert.match(instructions, /same spoken response must contain the one actual next required question/i);
    assert.match(instructions, /that is conversation repair.*never a business question and never a project note/i);
    assert.doesNotMatch(instructions, /Choose exactly one next action before speaking/i);
    assert.doesNotMatch(instructions, /The price depends on the estimate/i);
    assert.doesNotMatch(instructions, /longest it will take is a week/i);
    assert.doesNotMatch(instructions, /one of the two fallbacks above/i);
    assert.doesNotMatch(instructions, /safe fallbacks/i);
  } finally {
    h.restore();
  }
});

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

test('a clear service answer must go directly to the name question', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'service-question-order',
      itemId: 'service-question-order-item',
      transcript: SERVICE_QUESTION,
      audio: 'service-question-order-audio',
    });
    caller(h.socket, 'I just kind of need a shed painted.', 'caller-shed-service');
    assistantResponse(h.socket, {
      responseId: 'skipped-name-transition',
      itemId: 'skipped-name-transition-item',
      transcript: 'Got it—painting a shed is a great project. Let me grab a couple quick details.',
      audio: 'skipped-name-transition-audio',
    });

    assert.equal(h.audio.includes('skipped-name-transition-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      'Say exactly: "What name should I use for the estimate request?" Do not add anything before or after it.',
    );
  } finally {
    h.restore();
  }
});

test('a caller who volunteers their name with the service is not asked for it again', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'service-question-volunteered-name',
      itemId: 'service-question-volunteered-name-item',
      transcript: SERVICE_QUESTION,
      audio: 'service-question-volunteered-name-audio',
    });
    caller(
      h.socket,
      'I need a shed painted, and my name is Andrew Christensen.',
      'caller-service-and-name',
    );
    assistantResponse(h.socket, {
      responseId: 'address-after-volunteered-name',
      itemId: 'address-after-volunteered-name-item',
      transcript: "What's the complete project address?",
      audio: 'address-after-volunteered-name-audio',
    });

    assert.equal(h.audio.includes('address-after-volunteered-name-audio'), true);
  } finally {
    h.restore();
  }
});

test('a missing cleanup item is treated as an already-complete guarded deletion', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'service-question-delete',
      itemId: 'service-question-delete-item',
      transcript: SERVICE_QUESTION,
      audio: 'service-question-delete-audio',
    });
    caller(h.socket, 'I need a shed painted.', 'caller-delete-service');
    assistantResponse(h.socket, {
      responseId: 'blocked-delete-response',
      itemId: 'blocked-delete-item',
      transcript: 'Let me grab a couple quick details.',
      audio: 'blocked-delete-audio',
    });

    const deletion = h.socket.sent.find(
      (event) => event.type === 'conversation.item.delete'
        && event.item_id === 'blocked-delete-item',
    );
    assert.ok(deletion?.event_id);
    h.socket.receive({
      type: 'error',
      error: {
        event_id: deletion.event_id,
        message: "Error deleting item: the item with id 'blocked-delete-item' does not exist.",
      },
    });
    assert.equal(h.errors.length, 0);
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

test('a natural acknowledgement stays attached to the immediate next question', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'conversational-name-question',
      itemId: 'conversational-name-question-item',
      transcript: 'What name should I use for the estimate request?',
      audio: 'conversational-name-question-audio',
    });
    caller(h.socket, 'Andrew Christensen.', 'conversational-caller-name');
    assistantResponse(h.socket, {
      responseId: 'conversational-address-question',
      itemId: 'conversational-address-question-item',
      transcript: "Okay, Andrew, sounds great. What's the complete project address?",
      audio: 'conversational-address-question-audio',
    });

    assert.equal(h.audio.includes('conversational-address-question-audio'), true);
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

test('Monday at 1 silently resolves to 1 PM and advances to notes', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'schedule-question-bare-hour',
      itemId: 'schedule-question-bare-hour-item',
      transcript: 'What date and time would work best for the estimate?',
      audio: 'schedule-question-bare-hour-audio',
    });
    caller(h.socket, 'Probably, like, Monday at 1.', 'caller-bare-hour');
    assistantResponse(h.socket, {
      responseId: 'unnecessary-meridiem-question',
      itemId: 'unnecessary-meridiem-question-item',
      transcript: 'Do you mean Monday at 1 PM for the estimate?',
      audio: 'unnecessary-meridiem-question-audio',
    });

    assert.equal(h.audio.includes('unnecessary-meridiem-question-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "${NOTES_PROMPT}" Do not add anything before or after it.`,
    );
  } finally {
    h.restore();
  }
});

test('Tuesday at 12 cannot dead-end on transition narration or turn recovery chatter into notes', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'noon-schedule-question',
      itemId: 'noon-schedule-question-item',
      transcript: 'What date and time would work best for the estimate?',
      audio: 'noon-schedule-question-audio',
    });
    caller(
      h.socket,
      'Probably like Tuesday. Uh, and can you do 12 on Tuesday?',
      'caller-tuesday-noon',
    );
    assistantResponse(h.socket, {
      responseId: 'dead-end-transition',
      itemId: 'dead-end-transition-item',
      transcript: 'Got it, let me ask one quick question to move things along.',
      audio: 'dead-end-transition-audio',
    });

    assert.equal(h.audio.includes('dead-end-transition-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "${NOTES_PROMPT}" Do not add anything before or after it.`,
    );

    assistantResponse(h.socket, {
      responseId: 'actual-notes-question',
      itemId: 'actual-notes-question-item',
      transcript: NOTES_PROMPT,
      audio: 'actual-notes-question-audio',
    });
    caller(h.socket, "What's the question?", 'caller-asks-for-question');
    assistantResponse(h.socket, {
      responseId: 'misclassified-recovery-question',
      itemId: 'misclassified-recovery-question-item',
      transcript: `${UNKNOWN} ${MORE_NOTES_PROMPT}`,
      audio: 'misclassified-recovery-question-audio',
    });

    assert.equal(h.audio.includes('misclassified-recovery-question-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "${NOTES_PROMPT}" Do not add anything before or after it.`,
    );

    assistantResponse(h.socket, {
      responseId: 'repeated-actual-notes-question',
      itemId: 'repeated-actual-notes-question-item',
      transcript: NOTES_PROMPT,
      audio: 'repeated-actual-notes-question-audio',
    });
    caller(
      h.socket,
      "No, I didn't even ask a question. I was wondering what the hell you were even talking about.",
      'caller-explains-confusion',
    );
    assistantResponse(h.socket, {
      responseId: 'premature-consent-after-confusion',
      itemId: 'premature-consent-after-confusion-item',
      transcript: 'Okay, thanks for the notes. One more question. Do you consent to being contacted by Tabor Painting?',
      audio: 'premature-consent-after-confusion-audio',
    });

    assert.equal(h.audio.includes('premature-consent-after-confusion-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "${NOTES_PROMPT}" Do not add anything before or after it.`,
    );

    assistantResponse(h.socket, {
      responseId: 'notes-question-after-confusion',
      itemId: 'notes-question-after-confusion-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-after-confusion-audio',
    });
    caller(h.socket, "No, I don't have any notes or questions.", 'caller-no-actual-notes');
    assistantResponse(h.socket, {
      responseId: 'consent-without-fake-notes',
      itemId: 'consent-without-fake-notes-item',
      transcript: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
      audio: 'consent-without-fake-notes-audio',
    });

    assert.equal(h.audio.includes('consent-without-fake-notes-audio'), true);
  } finally {
    h.restore();
  }
});

test('answered intake fields stay locked while later steps continue', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'locked-service-question',
      itemId: 'locked-service-question-item',
      transcript: SERVICE_QUESTION,
      audio: 'locked-service-question-audio',
    });
    caller(h.socket, 'I need a shed painted.', 'locked-caller-service');
    assistantResponse(h.socket, {
      responseId: 'locked-name-question',
      itemId: 'locked-name-question-item',
      transcript: 'What name should I use for the estimate request?',
      audio: 'locked-name-question-audio',
    });
    caller(h.socket, 'Andrew Christensen.', 'locked-caller-name');
    assistantResponse(h.socket, {
      responseId: 'locked-address-question',
      itemId: 'locked-address-question-item',
      transcript: "What's the complete project address?",
      audio: 'locked-address-question-audio',
    });
    caller(
      h.socket,
      '197 Lancaster Road, Berlin, Massachusetts.',
      'locked-caller-address',
    );
    assistantResponse(h.socket, {
      responseId: 'locked-schedule-question',
      itemId: 'locked-schedule-question-item',
      transcript: 'What date and time would work best for the estimate?',
      audio: 'locked-schedule-question-audio',
    });
    caller(h.socket, 'Monday at 1.', 'locked-caller-schedule');
    assistantResponse(h.socket, {
      responseId: 'locked-notes-question',
      itemId: 'locked-notes-question-item',
      transcript: NOTES_PROMPT,
      audio: 'locked-notes-question-audio',
    });
    caller(h.socket, 'The shed has some rotten wood.', 'locked-caller-note');

    assistantResponse(h.socket, {
      responseId: 'repeated-completed-service',
      itemId: 'repeated-completed-service-item',
      transcript: SERVICE_QUESTION,
      audio: 'repeated-completed-service-audio',
    });
    assert.equal(h.audio.includes('repeated-completed-service-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "${MORE_NOTES_PROMPT}" Do not add anything before or after it.`,
    );

    assistantResponse(h.socket, {
      responseId: 'locked-more-notes-repair',
      itemId: 'locked-more-notes-repair-item',
      transcript: MORE_NOTES_PROMPT,
      audio: 'locked-more-notes-repair-audio',
    });
    caller(
      h.socket,
      "No, I don't have any more notes or questions.",
      'locked-caller-notes-done',
    );
    assistantResponse(h.socket, {
      responseId: 'repeated-completed-address',
      itemId: 'repeated-completed-address-item',
      transcript: "What's the complete project address?",
      audio: 'repeated-completed-address-audio',
    });

    assert.equal(h.audio.includes('repeated-completed-address-audio'), false);
    assert.match(
      latestResponseCreate(h.socket).response.instructions,
      /Okay, thanks for the notes\. One more question\. Do you consent to being contacted by Tabor Painting\?/,
    );
  } finally {
    h.restore();
  }
});

test('a supported business question is answered without being added to notes and stays in notes', async () => {
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
    assert.match(repair, /supplied business data for this call/i);
    assert.match(repair, /Do not add an answered question to the notes/i);
    assert.match(repair, new RegExp(MORE_NOTES_PROMPT.replace(/[?]/g, '\\?')));
    assert.doesNotMatch(repair, /add that question to the notes/i);
    assert.doesNotMatch(repair, /ask.*service were you looking for/i);
  } finally {
    h.restore();
  }
});

test('a business fact supplied by the app can be answered and is not forced into notes', async () => {
  const context = {
    ...CONTEXT,
    knowledgeJson: JSON.stringify({
      businessHours: 'Monday through Friday',
      serviceAreas: ['Local service area'],
      warranty: 'Two-year workmanship warranty',
    }),
  };
  const h = await createHarness(context);
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-warranty',
      itemId: 'notes-question-warranty-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-warranty-audio',
    });
    caller(h.socket, 'Do you have a warranty?', 'caller-warranty-question');
    assistantResponse(h.socket, {
      responseId: 'grounded-warranty-answer',
      itemId: 'grounded-warranty-answer-item',
      transcript: `Yes, the business data says there is a two-year workmanship warranty. ${MORE_NOTES_PROMPT}`,
      audio: 'grounded-warranty-audio',
    });

    assert.equal(h.audio.includes('grounded-warranty-audio'), true);
    assert.equal(latestResponseCreate(h.socket).response.instructions.includes(UNKNOWN), false);
  } finally {
    h.restore();
  }
});

test('grounded business wording containing unit is not mistaken for an address-unit request', async () => {
  const context = {
    ...CONTEXT,
    knowledgeJson: JSON.stringify({
      businessHours: 'Monday through Friday',
      serviceAreas: ['Local service area'],
      pricing: 'Some work is priced per unit after the estimate.',
    }),
  };
  const h = await createHarness(context);
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-unit-pricing',
      itemId: 'notes-question-unit-pricing-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-unit-pricing-audio',
    });
    caller(h.socket, 'Do you price anything per unit?', 'caller-unit-pricing-question');
    assistantResponse(h.socket, {
      responseId: 'grounded-unit-answer',
      itemId: 'grounded-unit-answer-item',
      transcript: `The supplied business data says some work is priced per unit after the estimate. ${MORE_NOTES_PROMPT}`,
      audio: 'grounded-unit-answer-audio',
    });

    assert.equal(h.audio.includes('grounded-unit-answer-audio'), true);
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
      `Say exactly: "${UNKNOWN} ${MORE_NOTES_PROMPT}" Do not add anything before or after it.`,
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

test('a project note with a conversational question tag stays a note', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-conversational-tag',
      itemId: 'notes-question-conversational-tag-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-conversational-tag-audio',
    });
    caller(h.socket, 'Um...', 'caller-note-filler');
    caller(h.socket, 'Probably...', 'caller-note-start');
    caller(h.socket, 'The shed is kind of rotted out a bit.', 'caller-note-rot');
    caller(
      h.socket,
      "I think a layer of paint will do good, but I don't want them to damage it any further, you know what I'm talking about?",
      'caller-note-tag',
    );
    assistantResponse(h.socket, {
      responseId: 'misclassified-note-question',
      itemId: 'misclassified-note-question-item',
      transcript: `${UNKNOWN} ${MORE_NOTES_PROMPT}`,
      audio: 'misclassified-note-question-audio',
    });

    assert.equal(h.audio.includes('misclassified-note-question-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      `Say exactly: "${MORE_NOTES_PROMPT}" Do not add anything before or after it.`,
    );
  } finally {
    h.restore();
  }
});

test('notes completion requires the exact consent wording recognized by submission state', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'notes-question-consent-boundary',
      itemId: 'notes-question-consent-boundary-item',
      transcript: NOTES_PROMPT,
      audio: 'notes-question-consent-boundary-audio',
    });
    caller(h.socket, 'Please note that the back wall needs extra prep.', 'caller-note-consent-boundary');
    assistantResponse(h.socket, {
      responseId: 'more-notes-consent-boundary',
      itemId: 'more-notes-consent-boundary-item',
      transcript: MORE_NOTES_PROMPT,
      audio: 'more-notes-consent-boundary-audio',
    });
    caller(h.socket, 'No, that is all.', 'caller-done-consent-boundary');
    assistantResponse(h.socket, {
      responseId: 'nonstandard-consent',
      itemId: 'nonstandard-consent-item',
      transcript: 'Do you consent to being contacted by Tabor Painting?',
      audio: 'nonstandard-consent-audio',
    });

    assert.equal(h.audio.includes('nonstandard-consent-audio'), false);
    assert.equal(
      latestResponseCreate(h.socket).response.instructions,
      'Say exactly: "Okay, thanks for the notes. One more question. Do you consent to being contacted by Tabor Painting?" Do not add anything before or after it.',
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

test('consent yes cannot repeat notes or reopen any completed intake field', async () => {
  const h = await createHarness();
  try {
    assistantResponse(h.socket, {
      responseId: 'consent-question-no-reopen',
      itemId: 'consent-question-no-reopen-item',
      transcript: 'Okay, thanks for the notes. One more question. Do you consent to being contacted by Tabor Painting?',
      audio: 'consent-question-no-reopen-audio',
    });
    caller(h.socket, 'Yes.', 'caller-consent-no-reopen');
    assistantResponse(h.socket, {
      responseId: 'repeated-note-and-name',
      itemId: 'repeated-note-and-name-item',
      transcript: 'Got it, thank you. I also saved that note about the damaged shed. What name should I use for the estimate request?',
      audio: 'repeated-note-and-name-audio',
    });

    assert.equal(h.audio.includes('repeated-note-and-name-audio'), false);
    assert.match(latestResponseCreate(h.socket).response.instructions, /Call prepare_estimate_summary now/i);
    assert.doesNotMatch(latestResponseCreate(h.socket).response.instructions, /saved that note/i);
    assert.doesNotMatch(latestResponseCreate(h.socket).response.instructions, /What name should I use/i);
  } finally {
    h.restore();
  }
});

test('an explicit final-summary correction may reopen only the corrected field', async () => {
  const h = await createHarness();
  try {
    caller(
      h.socket,
      '197 Lancaster Road, Berlin, Massachusetts.',
      'correction-address-evidence',
    );
    assistantResponse(h.socket, {
      responseId: 'correction-consent-question',
      itemId: 'correction-consent-question-item',
      transcript: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
      audio: 'correction-consent-question-audio',
    });
    caller(h.socket, 'Yes.', 'correction-caller-consent');
    assistantResponse(h.socket, {
      responseId: 'correction-prepare-response',
      itemId: 'correction-prepare-response-item',
      extraOutput: [{
        id: 'correction-prepare-call-item',
        type: 'function_call',
        name: 'prepare_estimate_summary',
        call_id: 'correction-prepare-call-id',
        arguments: JSON.stringify({
          service: 'Exterior Painting',
          name: 'Andrew Christensen',
          address: '197 Lancaster Road, Berlin, Massachusetts.',
          preferred_date: 'Monday',
          preferred_time: '1',
          additional_notes: '',
          additional_notes_asked: true,
          consent_to_contact: true,
          consent_asked_separately: true,
        }),
      }],
    });
    await nextTurn();

    const summaryRequest = responseCreates(h.socket).find((event) =>
      /Okay, here's the summary/i.test(event.response?.instructions || ''),
    );
    assert.ok(summaryRequest);
    const summarySpeechMatch = summaryRequest.response.instructions.match(
      /Say exactly: ("(?:[^"\\]|\\.)*")/,
    );
    assert.ok(summarySpeechMatch);
    const summarySpeech = JSON.parse(summarySpeechMatch[1]);
    assistantResponse(h.socket, {
      responseId: 'correction-summary-readback',
      itemId: 'correction-summary-readback-item',
      transcript: summarySpeech,
      audio: 'correction-summary-readback-audio',
    });
    caller(h.socket, 'No, the project address is wrong.', 'correction-caller-summary-no');
    assistantResponse(h.socket, {
      responseId: 'correction-reopen-address',
      itemId: 'correction-reopen-address-item',
      transcript: "What's the complete project address?",
      audio: 'correction-reopen-address-audio',
    });

    assert.equal(h.audio.includes('correction-reopen-address-audio'), true);
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
