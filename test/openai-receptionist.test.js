import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildReceptionistInstructions,
  buildSessionUpdate,
  createOpenAiReceptionist,
} from '../openai-receptionist.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  clientId: 'client-123',
  serviceRequestWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestServiceRequestStart: '09:00',
  latestServiceRequestStart: '16:00',
  services: [
    { name: 'Exterior Painting', description: 'Exterior painting' },
    { name: 'Interior Painting', description: 'Interior painting' },
  ],
  businessInformation: [
    { title: 'Warranty', info: 'One year on labor.' },
  ],
  knowledgeJson: '{"businessInformation":[{"title":"Warranty","info":"One year on labor."}]}',
});

const DEMO_CONTEXT = Object.freeze({
  businessName: 'AI Receptionist Demo',
  timeZone: 'America/New_York',
  clientId: '',
  serviceRequestWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestServiceRequestStart: '9:00 AM',
  latestServiceRequestStart: '5:00 PM',
  services: [],
  businessInformation: [],
  knowledgeJson: '{"profile":{"businessName":"AI Receptionist Demo"},"services":[]}',
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
    this.sent.push(JSON.parse(String(value)));
    return true;
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseCreates(socket) {
  return socket.sent.filter((event) => event.type === 'response.create');
}

function latestResponse(socket) {
  return responseCreates(socket).at(-1);
}

function caller(socket, transcript, itemId) {
  socket.receive({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  socket.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

async function finishSpeech(socket, {
  responseId,
  transcript,
  audio = `${responseId}-audio`,
}) {
  const itemId = `${responseId}-item`;
  socket.receive({ type: 'response.created', response: { id: responseId } });
  socket.receive({
    type: 'response.output_audio.delta',
    response_id: responseId,
    item_id: itemId,
    delta: audio,
  });
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
  await nextTurn();
}

function analysis(overrides = {}) {
  const { fields = {}, ...rest } = overrides;
  return {
    turn_status: 'complete',
    address_status: 'not_addressed',
    service_status: 'not_addressed',
    project_note: '',
    notes_complete: false,
    contact_consent: 'not_answered',
    summary_confirmation: 'not_answered',
    correction_field: 'none',
    business_answer_status: 'not_a_question',
    business_question: '',
    business_question_type: 'none',
    business_support: '',
    ...rest,
    fields: {
      service: '',
      name: '',
      address: '',
      preferred_date: '',
      preferred_time: '',
      ...fields,
    },
  };
}

async function finishAnalysis(socket, {
  responseId,
  args,
  includeTool = true,
}) {
  socket.receive({ type: 'response.created', response: { id: responseId } });
  socket.receive({
    type: 'response.done',
    response: {
      id: responseId,
      output: includeTool ? [{
        id: `${responseId}-call-item`,
        type: 'function_call',
        name: 'analyze_caller_turn',
        call_id: `${responseId}-call`,
        arguments: JSON.stringify(args),
      }] : [],
    },
  });
  await nextTurn();
  await nextTurn();
}

async function createHarness({
  context = CONTEXT,
  runtime = { clientId: 'client-123' },
  callControlId = 'call-123',
  deliver,
  incompleteTurnRecoveryMs,
  holdRecoveryMs,
  summarizeRequest = async ({ draft }) => ({
    service: draft.service,
    notes: draft.additional_notes,
  }),
} = {}) {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const audio = [];
  const transcripts = [];
  const submitted = [];
  const goodbye = [];
  const errors = [];
  const latencies = [];
  const playbackClears = [];
  const receptionist = createOpenAiReceptionist({
    context,
    runtime,
    callControlId,
    callerPhone: '+15555550123',
    deliver: deliver || (async () => ({ ok: true })),
    onAudio: (value) => audio.push(value),
    onPlaybackClear: () => playbackClears.push(true),
    onTranscript: (entry) => transcripts.push(entry),
    onSubmitted: (snapshot) => submitted.push(snapshot),
    onReady: () => {},
    onGoodbyeComplete: () => goodbye.push(true),
    onCostLimit: () => {},
    onUsage: () => {},
    onLatency: (entry) => latencies.push(entry),
    onError: (error) => errors.push(error),
    summarizeRequest,
    incompleteTurnRecoveryMs,
    holdRecoveryMs,
    WebSocketClass: FakeWebSocket,
  });
  await nextTurn();
  const socket = FakeWebSocket.instance;
  socket.receive({ type: 'session.updated', session: {} });
  return {
    receptionist,
    socket,
    audio,
    transcripts,
    submitted,
    goodbye,
    errors,
    latencies,
    playbackClears,
    restore() {
      receptionist.close();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    },
  };
}

test('keeps the OpenAI safety identifier within 64 characters for long Telnyx call IDs', async () => {
  const h = await createHarness({
    runtime: {},
    callControlId: `v3:${'long-telnyx-call-control-id-'.repeat(8)}`,
  });

  try {
    const identifier = h.socket.options.headers['OpenAI-Safety-Identifier'];
    assert.ok(identifier.length <= 64);
    assert.equal(identifier.length, 56);
    assert.match(identifier, /^receptionist-[A-Za-z0-9_-]+$/);
  } finally {
    h.restore();
  }
});

test('omits the optional OpenAI safety identifier only for the demo runtime', async () => {
  const h = await createHarness({
    runtime: { demo: true },
    callControlId: `v3:${'long-telnyx-call-control-id-'.repeat(8)}`,
  });

  try {
    assert.equal('OpenAI-Safety-Identifier' in h.socket.options.headers, false);
    assert.equal(h.socket.options.headers.Authorization, 'Bearer test-key');
  } finally {
    h.restore();
  }
});

async function advanceHarnessToScheduleQuestion(socket, { idPrefix = 'schedule-path' } = {}) {
  await finishSpeech(socket, {
    responseId: `${idPrefix}-greeting`,
    transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
  });
  const steps = [
    {
      callerText: 'I need exterior painting.',
      args: analysis({
        service_status: 'complete',
        fields: { service: 'Exterior Painting' },
      }),
      speech: 'Okay, what name should I use for the service request?',
    },
    {
      callerText: 'Jordan Smith.',
      args: analysis({ fields: { name: 'Jordan Smith' } }),
      speech: "Thanks. What's the full address where the service is needed?",
    },
    {
      callerText: '123 Main Street, Albany, New York.',
      args: analysis({
        address_status: 'complete',
        fields: { address: '123 Main Street, Albany, New York' },
      }),
      speech: 'Got it. What date and exact time would you prefer for the service request?',
    },
  ];

  for (const [index, step] of steps.entries()) {
    caller(socket, step.callerText, `${idPrefix}-caller-${index}`);
    await finishAnalysis(socket, {
      responseId: `${idPrefix}-analysis-${index}`,
      args: step.args,
    });
    await finishSpeech(socket, {
      responseId: `${idPrefix}-speech-${index}`,
      transcript: step.speech,
    });
  }
}

async function advanceHarnessToSummaryRequest(socket, {
  businessName = 'Tabor Painting',
  greeting = `Hi, thank you for calling ${businessName}. What kind of work are you looking to have done?`,
  serviceCallerText = 'I need exterior painting.',
  service = 'Exterior Painting',
  projectNoteCallerText = '',
  projectNote = '',
} = {}) {
  await finishSpeech(socket, {
    responseId: 'summary-path-greeting',
    transcript: greeting,
  });
  const steps = [
    {
      callerText: serviceCallerText,
      args: analysis({
        service_status: 'complete',
        fields: { service },
      }),
      speech: 'Okay, what name should I use for the service request?',
    },
    {
      callerText: 'Jordan Smith.',
      args: analysis({ fields: { name: 'Jordan Smith' } }),
      speech: "Thanks. What's the full address where the service is needed?",
    },
    {
      callerText: '123 Main Street, Albany, New York.',
      args: analysis({
        address_status: 'complete',
        fields: { address: '123 Main Street, Albany, New York' },
      }),
      speech: 'Got it. What date and exact time would you prefer for the service request?',
    },
    {
      callerText: 'Tuesday, August 11, 2099 at 2 PM.',
      args: analysis({
        fields: { preferred_date: 'August 11 2099', preferred_time: '2 PM' },
      }),
      speech: 'Okay, sounds good. Do you have any additional notes and/or business questions?',
    },
    ...(projectNote ? [{
      callerText: projectNoteCallerText,
      args: analysis({ project_note: projectNote }),
      speech: 'Okay, I put that down. Do you have any other notes or business questions?',
    }] : []),
    {
      callerText: 'No.',
      args: analysis({ notes_complete: true }),
      speech: `Okay, thanks. One more question. Do you consent to being contacted by ${businessName}?`,
    },
    {
      callerText: 'Yes.',
      args: analysis({ contact_consent: 'yes' }),
      speech: '',
    },
  ];

  for (const [index, step] of steps.entries()) {
    caller(socket, step.callerText, `summary-path-caller-${index}`);
    await finishAnalysis(socket, {
      responseId: `summary-path-analysis-${index}`,
      args: step.args,
    });
    if (step.speech) {
      await finishSpeech(socket, {
        responseId: `summary-path-speech-${index}`,
        transcript: step.speech,
      });
    }
  }
  return latestResponse(socket);
}

test('session uses responsive semantic turn detection without caller barge-in', () => {
  const event = buildSessionUpdate(CONTEXT);
  assert.equal(event.type, 'session.update');
  assert.equal(event.session.model, 'gpt-realtime-2.1-mini');
  assert.equal(event.session.audio.input.format.type, 'audio/pcmu');
  assert.equal(event.session.audio.output.format.type, 'audio/pcmu');
  assert.equal(event.session.audio.output.voice, 'marin');
  assert.deepEqual(event.session.audio.input.transcription, {
    model: 'gpt-live-transcribe',
    prompt: 'A telephone call collecting a service request. Preserve names, United States addresses, dates, exact clock times, AM or PM, time-of-day phrases such as morning, afternoon, evening, or night, and short yes or no answers.',
    keywords: ['Tabor Painting', 'Exterior Painting', 'Interior Painting'],
    languages: ['en'],
  });
  assert.equal(event.session.audio.input.noise_reduction.type, 'far_field');
  assert.deepEqual(event.session.audio.input.turn_detection, {
    type: 'semantic_vad',
    eagerness: 'medium',
    create_response: false,
    interrupt_response: false,
  });
  assert.deepEqual(event.session.tools, []);
  assert.equal(event.session.tool_choice, 'none');
});

test('prompt has one state owner and a short, explicit knowledge boundary', () => {
  const prompt = buildReceptionistInstructions(CONTEXT);
  assert.match(prompt, /only objective is to help the caller complete one service request/i);
  assert.match(prompt, /server owns the intake state, question order, validation, confirmation, submission, and hangup/i);
  assert.match(prompt, /ordinary general knowledge only to understand natural speech/i);
  assert.match(prompt, /only when the supplied business information explicitly supports/i);
  assert.match(prompt, /owner-supplied Title\/Info item/i);
  assert.match(prompt, /One year on labor/i);
  assert.match(prompt, /never claim that a particular date or time is available/i);
  assert.match(prompt, /AI receptionist working for Tabor Painting, managed by ARC Client Center/i);
  assert.match(prompt, /call it once without speaking/i);
  assert.match(prompt, /only a question repeated after the caller-silence delay yields/i);
  assert.match(prompt, /keep the caller's name, address, date, time, and yes\/no meaning literal/i);
  assert.match(prompt, /simplify only owner-facing notes and business questions/i);
  assert.match(prompt, /never duplicate the structured service, name, address, date, or time in notes/i);
  assert.doesNotMatch(prompt, /delete|blocked output|repair attempts|completedIntakeFields/i);
});

test('demo session is neutral, accepts every trade, and contains no Tabor Painting rules', () => {
  const event = buildSessionUpdate(DEMO_CONTEXT, { demo: true });
  const prompt = event.session.instructions;

  assert.match(prompt, /neutral product demo of the ARC Client Center AI receptionist/i);
  assert.match(prompt, /not representing any real business/i);
  assert.match(prompt, /accept any substantive description of requested work/i);
  assert.match(prompt, /painting, HVAC, plumbing, landscaping, electrical, cleaning, or any other trade/i);
  assert.match(prompt, /Monday through Friday and times from 9:00 AM through 5:00 PM/i);
  assert.match(prompt, /classify every separate business-information question as unanswerable/i);
  assert.match(prompt, /demo information is never submitted or saved/i);
  assert.doesNotMatch(prompt, /Tabor Painting|Interior Painting|Exterior Painting|Wood Staining/i);
  assert.deepEqual(event.session.audio.input.transcription.keywords, ['AI Receptionist Demo']);
});

test('demo accepts a burst-pipe problem statement without asking for more detail', async () => {
  const h = await createHarness({
    context: DEMO_CONTEXT,
    runtime: { demo: true },
  });
  try {
    assert.match(
      latestResponse(h.socket).response.instructions,
      /Hi, thank you for calling the ARC Client Center demo number\./i,
    );
    assert.match(latestResponse(h.socket).response.instructions, /pretend you're one of your own clients/i);
    assert.match(latestResponse(h.socket).response.instructions, /None of the information you provide is saved/i);
    assert.doesNotMatch(latestResponse(h.socket).response.instructions, /Tabor Painting/i);

    await finishSpeech(h.socket, {
      responseId: 'demo-greeting',
      transcript: "Hi, thank you for calling the ARC Client Center demo number. You can pretend you're one of your own clients and test it however you'd like. None of the information you provide is saved. What kind of work are you looking to have done?",
    });
    caller(h.socket, 'Yeah, one of my pipes burst in my basement.', 'demo-pipe-service');

    const request = latestResponse(h.socket).response;
    assert.match(request.instructions, /demo has no service catalog/i);
    assert.match(
      request.instructions,
      /every meaningful problem, condition, desired outcome, or work statement completes/i,
    );
    assert.match(
      request.tools[0].parameters.properties.fields.properties.service.description,
      /accept every meaningful problem, condition, desired outcome, trade, or work type/i,
    );
    assert.match(
      request.tools[0].parameters.properties.service_status.description,
      /never use ambiguous or not_offered/i,
    );

    await finishAnalysis(h.socket, {
      responseId: 'demo-pipe-analysis',
      args: analysis({
        service_status: 'ambiguous',
      }),
    });
    assert.equal(
      h.receptionist.snapshot().state.values.service,
      'one of my pipes burst in my basement',
    );
    assert.deepEqual(h.receptionist.snapshot().state.notes, []);
    assert.match(latestResponse(h.socket).response.instructions, /what name should I use/i);
    assert.doesNotMatch(latestResponse(h.socket).response.instructions, /little more|more specific/i);
  } finally {
    h.restore();
  }
});

test('demo gives its fixed fallback for business questions without saving them as notes', async () => {
  const h = await createHarness({
    context: DEMO_CONTEXT,
    runtime: { demo: true },
  });
  try {
    await finishSpeech(h.socket, {
      responseId: 'demo-question-greeting',
      transcript: "Hi, thank you for calling the ARC Client Center demo number. You can pretend you're one of your own clients and test it however you'd like. None of the information you provide is saved. What kind of work are you looking to have done?",
    });
    caller(h.socket, 'What hours are you open?', 'demo-hours-question');
    await finishAnalysis(h.socket, {
      responseId: 'demo-hours-analysis',
      args: analysis({
        business_answer_status: 'answerable',
        business_question: 'What hours are you open?',
        business_question_type: 'service_request_window',
        business_support: 'Monday through Friday from 9 AM to 5 PM.',
      }),
    });

    const instructions = latestResponse(h.socket).response.instructions;
    assert.match(
      instructions,
      /I'm sorry, I don't know that, but you can submit a service request\./i,
    );
    assert.match(instructions, /What kind of work are you looking to have done\?/i);
    assert.doesNotMatch(instructions, /Monday through Friday|9:00 AM|5:00 PM/i);
    assert.deepEqual(h.receptionist.snapshot().state.notes, []);
    assert.equal(h.receptionist.snapshot().state.pendingField, 'service');
  } finally {
    h.restore();
  }
});

test('demo ends immediately after confirmation without saving or claiming submission', async () => {
  const deliveries = [];
  const h = await createHarness({
    context: DEMO_CONTEXT,
    runtime: { demo: true },
    deliver: async (payload) => {
      deliveries.push(payload);
      return { ok: true };
    },
  });
  try {
    await advanceHarnessToSummaryRequest(h.socket, {
      businessName: 'AI Receptionist Demo',
      greeting: "Hi, thank you for calling the ARC Client Center demo number. You can pretend you're one of your own clients and test it however you'd like. None of the information you provide is saved. What kind of work are you looking to have done?",
      serviceCallerText: "My AC won't run.",
      service: 'AC repair',
    });
    await finishSpeech(h.socket, {
      responseId: 'demo-summary',
      transcript: "Okay, here's the summary. Jordan Smith is requesting AC repair at 123 Main Street, Albany, New York. The preferred date and time is Tuesday, August 11, 2099 at 2:00 PM. Does that all sound right?",
    });
    caller(h.socket, 'Yes.', 'demo-summary-confirmation');

    assert.match(
      latestResponse(h.socket).response.instructions,
      /Thank you for calling the demo number\. Have a good day\./i,
    );
    assert.doesNotMatch(
      latestResponse(h.socket).response.instructions,
      /submitting|submitted|Thank you for filling out a service request/i,
    );
    assert.equal(deliveries.length, 0);
    assert.equal(h.submitted.length, 0);
    assert.equal(h.receptionist.snapshot().submitted, false);
    assert.equal(h.receptionist.snapshot().endingCall, true);
    await finishSpeech(h.socket, {
      responseId: 'demo-goodbye',
      transcript: 'Thank you for calling the demo number. Have a good day.',
    });
    assert.deepEqual(h.goodbye, [true]);
    assert.equal(h.errors.length, 0);
  } finally {
    h.restore();
  }
});

test('generated audio streams immediately instead of waiting for transcript validation', async () => {
  const h = await createHarness();
  try {
    const greeting = latestResponse(h.socket);
    assert.match(greeting.response.instructions, /Hi, thank you for calling Tabor Painting/);

    h.socket.receive({ type: 'response.created', response: { id: 'greeting-stream' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'greeting-stream',
      item_id: 'greeting-stream-item',
      delta: 'first-audio-now',
    });
    assert.deepEqual(h.audio, ['first-audio-now']);
    assert.equal(
      h.socket.sent.some((event) => event.type === 'conversation.item.delete'),
      false,
    );
  } finally {
    h.restore();
  }
});

test('the live model\'s native-audio interpretation outranks a bad sidecar transcript', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'native-audio-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });

    caller(h.socket, 'I need my lawn mower.', 'native-audio-service');
    await finishAnalysis(h.socket, {
      responseId: 'native-audio-service-analysis',
      args: analysis({
        heard_text: 'I need the exterior of my house painted.',
        service_status: 'complete',
        fields: { service: 'Exterior Painting' },
      }),
    });

    assert.equal(h.receptionist.snapshot().state.values.service, 'Exterior Painting');
    assert.equal(h.receptionist.snapshot().state.pendingField, 'name');
    assert.match(latestResponse(h.socket).response.instructions, /what name should I use/i);
  } finally {
    h.restore();
  }
});

test('one final summary supplies both the spoken readback and the saved bullet summary', async () => {
  const deliveries = [];
  const summaryCalls = [];
  const h = await createHarness({
    deliver: async (payload) => {
      deliveries.push(payload);
      return { ok: true };
    },
    summarizeRequest: async (input) => {
      summaryCalls.push(input);
      return {
        service: 'A service the business does not offer',
        notes: 'Rear siding is peeling. The back gate is locked.',
      };
    },
  });
  try {
    await advanceHarnessToSummaryRequest(h.socket, {
      projectNoteCallerText: 'Uh, the rear siding is peeling, and, you know, the back gate is locked.',
      projectNote: 'The rear siding is peeling, and the back gate is locked.',
    });

    assert.equal(summaryCalls.length, 1);
    assert.equal(summaryCalls[0].demo, false);
    assert.match(
      summaryCalls[0].source.understoodCallerTurns.join('\n'),
      /rear siding is peeling.*back gate is locked/i,
    );
    const readback = latestResponse(h.socket).response.instructions;
    assert.match(readback, /requesting Exterior Painting/i);
    assert.doesNotMatch(readback, /service the business does not offer/i);
    assert.match(readback, /Rear siding is peeling\. The back gate is locked\./i);
    assert.doesNotMatch(readback, /\buh\b|you know/i);

    await finishSpeech(h.socket, {
      responseId: 'dedicated-final-summary-readback',
      transcript: "Okay, here's the summary. Jordan Smith is requesting Exterior Painting at 123 Main Street, Albany, New York. The preferred date and time is Tuesday, August 11, 2099 at 2:00 PM. The notes are: Rear siding is peeling. The back gate is locked. Does that all sound right?",
    });
    caller(h.socket, 'Yes.', 'dedicated-final-summary-confirmation');
    assert.match(latestResponse(h.socket).response.instructions, /I'm sending it in now/i);
    await finishSpeech(h.socket, {
      responseId: 'dedicated-final-summary-submit',
      transcript: "I'm sending it in now.",
    });

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].service, 'Exterior Painting');
    assert.equal(deliveries[0].additionalNotes, 'Rear siding is peeling. The back gate is locked.');
    assert.equal(deliveries[0].requestSummary, [
      '- Service: Exterior Painting',
      '- Preferred time: Tuesday, August 11, 2099 at 2:00 PM',
      '- Address: 123 Main Street, Albany, New York',
      '- Notes: Rear siding is peeling. The back gate is locked.',
    ].join('\n'));
  } finally {
    h.restore();
  }
});

test('the demo uses the dedicated final summary for its service label and notes', async () => {
  const summaryCalls = [];
  const h = await createHarness({
    context: DEMO_CONTEXT,
    runtime: { demo: true },
    summarizeRequest: async (input) => {
      summaryCalls.push(input);
      return {
        service: 'Emergency burst pipe repair',
        notes: 'Water is spreading across the basement.',
      };
    },
  });
  try {
    await advanceHarnessToSummaryRequest(h.socket, {
      businessName: 'AI Receptionist Demo',
      greeting: "Hi, thank you for calling the ARC Client Center demo number. You can pretend you're one of your own clients and test it however you'd like. None of the information you provide is saved. What kind of work are you looking to have done?",
      serviceCallerText: "Uh, a pipe burst downstairs and water's going everywhere.",
      service: 'Pipe burst downstairs',
    });

    assert.equal(summaryCalls.length, 1);
    assert.equal(summaryCalls[0].demo, true);
    const readback = latestResponse(h.socket).response.instructions;
    assert.match(readback, /requesting Emergency burst pipe repair/i);
    assert.match(readback, /Water is spreading across the basement/i);
    assert.doesNotMatch(readback, /\buh\b|going everywhere/i);
  } finally {
    h.restore();
  }
});

test('a failed Luna summary falls back once to Realtime whole-call summarization', async () => {
  let lunaCalls = 0;
  const h = await createHarness({
    summarizeRequest: async () => {
      lunaCalls += 1;
      throw new Error('Luna summary unavailable');
    },
  });
  try {
    await advanceHarnessToSummaryRequest(h.socket, {
      projectNoteCallerText: 'The rear siding is peeling.',
      projectNote: 'The rear siding is peeling.',
    });

    assert.equal(lunaCalls, 1);
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'finalize_service_request_summary');
    assert.match(latestResponse(h.socket).response.instructions, /complete caller audio conversation/i);

    h.socket.receive({ type: 'response.created', response: { id: 'realtime-summary-fallback' } });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'realtime-summary-fallback',
        output: [{
          id: 'realtime-summary-fallback-call-item',
          type: 'function_call',
          name: 'finalize_service_request_summary',
          call_id: 'realtime-summary-fallback-call',
          arguments: JSON.stringify({
            service_label: 'Wrong service label',
            notes_summary: 'Rear siding is peeling.',
          }),
        }],
      },
    });
    await nextTurn();
    await nextTurn();

    const readback = latestResponse(h.socket).response.instructions;
    assert.match(readback, /requesting Exterior Painting/i);
    assert.doesNotMatch(readback, /Wrong service label/i);
    assert.match(readback, /Rear siding is peeling/i);
    assert.equal(h.errors.filter((error) => /Luna summary unavailable/i.test(error.message)).length, 1);
  } finally {
    h.restore();
  }
});

test('a complete call collects, confirms, submits once, reports success, and ends', async () => {
  const deliveries = [];
  const h = await createHarness({
    deliver: async (payload, options) => {
      deliveries.push({ payload, options });
      return { ok: true };
    },
  });
  try {
    await finishSpeech(h.socket, {
      responseId: 'greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });

    caller(h.socket, 'I need the exterior of my house painted.', 'caller-service');
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-service',
      args: analysis({
        service_status: 'complete',
        fields: { service: 'Exterior Painting' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /what name should I use/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-name',
      transcript: 'Okay, what name should I use for the service request?',
    });

    caller(h.socket, 'Jordan Smith.', 'caller-name');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-name',
      args: analysis({ fields: { name: 'Jordan Smith' } }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /full address where the service is needed/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-address',
      transcript: "Thanks. What's the full address where the service is needed?",
    });

    caller(h.socket, '123 Main Street, Albany, New York.', 'caller-address');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-address',
      args: analysis({
        address_status: 'complete',
        fields: { address: '123 Main Street, Albany, New York' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /date and exact time/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-schedule',
      transcript: 'Got it. What date and exact time would you prefer for the service request?',
    });

    caller(h.socket, 'Tuesday, August 11, 2099 at 2 PM.', 'caller-schedule');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-schedule',
      args: analysis({
        fields: { preferred_date: 'August 11 2099', preferred_time: '2 PM' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /additional notes/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-notes',
      transcript: 'Okay, sounds good. Do you have any additional notes and/or business questions?',
    });

    const responsesBeforeNote = responseCreates(h.socket).length;
    caller(
      h.socket,
      "Yeah, uh, the lawn's a little bumpy, so just tell them to look out, you know.",
      'caller-note-detail',
    );
    assert.equal(responseCreates(h.socket).length, responsesBeforeNote + 1);
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-note-detail',
      args: analysis({ project_note: 'The lawn is bumpy, so look out.' }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /Okay, I put that down\./i);
    assert.match(latestResponse(h.socket).response.instructions, /other notes or business questions/i);
    assert.deepEqual(h.receptionist.snapshot().state.notes, [
      'Paint the exterior of the house.',
      'The lawn is bumpy, so look out.',
    ]);
    await finishSpeech(h.socket, {
      responseId: 'acknowledge-note',
      transcript: 'Okay, I put that down. Do you have any other notes or business questions?',
    });

    caller(h.socket, 'No.', 'caller-notes');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-notes',
      args: analysis({ notes_complete: true }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /consent to being contacted/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-consent',
      transcript: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
    });

    caller(h.socket, 'Yes.', 'caller-consent');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-consent',
      args: analysis({ contact_consent: 'yes' }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /here's the summary/i);
    assert.match(latestResponse(h.socket).response.instructions, /Does that all sound right/i);
    assert.match(latestResponse(h.socket).response.instructions, /The lawn is bumpy, so look out/i);
    assert.doesNotMatch(latestResponse(h.socket).response.instructions, /just tell them to look out, you know/i);
    assert.equal(latestResponse(h.socket).response.max_output_tokens, 4_096);
    await finishSpeech(h.socket, {
      responseId: 'summary',
      transcript: "Okay, here's the summary. Jordan Smith is requesting Exterior Painting at 123 Main Street, Albany, New York. The preferred date and time is Tuesday, August 11, 2099 at 2:00 PM. The notes are: Paint the exterior of the house. The lawn is bumpy, so look out. Does that all sound right?",
    });

    caller(h.socket, 'Yes, that all sounds right.', 'caller-summary');
    assert.equal(latestResponse(h.socket).response.tool_choice, 'none');
    assert.match(latestResponse(h.socket).response.instructions, /I'm sending it in now\./i);
    assert.equal(deliveries.length, 0);
    await finishSpeech(h.socket, {
      responseId: 'pre-submit',
      transcript: "I'm sending it in now.",
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.service, 'Exterior Painting');
    assert.equal(deliveries[0].payload.name, 'Jordan Smith');
    assert.equal(deliveries[0].payload.address, '123 Main Street, Albany, New York');
    assert.equal(deliveries[0].payload.requestedTime, '2:00 PM');
    assert.equal(
      deliveries[0].payload.additionalNotes,
      'Paint the exterior of the house. The lawn is bumpy, so look out.',
    );
    assert.equal(
      deliveries[0].payload.requestSummary,
      [
        '- Service: Exterior Painting',
        '- Preferred time: Tuesday, August 11, 2099 at 2:00 PM',
        '- Address: 123 Main Street, Albany, New York',
        '- Notes: Paint the exterior of the house. The lawn is bumpy, so look out.',
      ].join('\n'),
    );
    assert.equal(deliveries[0].payload.summaryConfirmed, true);
    assert.equal(h.submitted.length, 1);

    assert.match(latestResponse(h.socket).response.instructions, /request has been submitted/i);
    await finishSpeech(h.socket, {
      responseId: 'success',
      transcript: "You're all set. Your service request has been submitted.",
    });
    assert.match(
      latestResponse(h.socket).response.instructions,
      /Thank you for filling out a service request\. Have a good day\./i,
    );
    await finishSpeech(h.socket, {
      responseId: 'goodbye',
      transcript: 'Thank you for filling out a service request. Have a good day.',
    });

    assert.deepEqual(h.goodbye, [true]);
    assert.equal(h.errors.length, 0);
    assert.equal(h.receptionist.snapshot().submitted, true);
    assert.equal(
      h.socket.sent.some((event) => event.type === 'conversation.item.delete'),
      false,
    );
  } finally {
    h.restore();
  }
});

test('contact refusal ends once without claiming the request was submitted', async () => {
  const deliveries = [];
  const h = await createHarness({
    deliver: async (payload) => {
      deliveries.push(payload);
      return { ok: true };
    },
  });
  try {
    await advanceHarnessToScheduleQuestion(h.socket, { idPrefix: 'refusal' });
    caller(h.socket, 'Tuesday, August 11, 2099 at 2 PM.', 'refusal-schedule');
    await finishAnalysis(h.socket, {
      responseId: 'refusal-schedule-analysis',
      args: analysis({
        fields: { preferred_date: 'August 11 2099', preferred_time: '2 PM' },
      }),
    });
    await finishSpeech(h.socket, {
      responseId: 'refusal-ask-notes',
      transcript: 'Okay, sounds good. Do you have any additional notes and/or business questions?',
    });
    caller(h.socket, 'No notes.', 'refusal-notes');
    await finishAnalysis(h.socket, {
      responseId: 'refusal-notes-analysis',
      args: analysis({ notes_complete: true }),
    });
    await finishSpeech(h.socket, {
      responseId: 'refusal-ask-consent',
      transcript: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
    });

    caller(h.socket, 'No.', 'refusal-consent');
    await finishAnalysis(h.socket, {
      responseId: 'refusal-consent-analysis',
      args: analysis({ contact_consent: 'no' }),
    });
    const responsesBeforeEnding = responseCreates(h.socket).length;
    const ending = latestResponse(h.socket).response.instructions;
    assert.match(ending, /was not submitted/i);
    assert.match(ending, /Have a good day/i);
    assert.doesNotMatch(ending, /Thank you for filling out a service request/i);

    await finishSpeech(h.socket, {
      responseId: 'refusal-ending',
      transcript: "I understand. I can't submit the service request without permission to contact you, so it was not submitted. Have a good day.",
    });
    assert.equal(responseCreates(h.socket).length, responsesBeforeEnding);
    assert.deepEqual(h.goodbye, [true]);
    assert.equal(deliveries.length, 0);
    assert.equal(h.submitted.length, 0);
  } finally {
    h.restore();
  }
});

test('a greeting-only caller turn cannot advance the work question', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'filler-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    const before = responseCreates(h.socket).length;
    caller(h.socket, 'Hey.', 'caller-filler');
    assert.equal(responseCreates(h.socket).length, before);
    assert.equal(h.receptionist.snapshot().state.pendingField, 'service');
    caller(h.socket, 'I was looking to get the exterior of my house painted.', 'caller-service-after-hello');
    assert.equal(responseCreates(h.socket).length, before + 1);
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
  } finally {
    h.restore();
  }
});

test('an abandoned filler turn gets a delayed prompt instead of indefinite silence', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'recovery-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    const before = responseCreates(h.socket).length;
    caller(h.socket, 'Um...', 'caller-abandoned-filler');
    assert.equal(responseCreates(h.socket).length, before);
    await wait(80);
    assert.equal(responseCreates(h.socket).length, before + 1);
    assert.match(latestResponse(h.socket).response.instructions, /What kind of work are you looking to have done/);
  } finally {
    h.restore();
  }
});

test('ordinary caller silence repeats only the pending question', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'silent-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    const before = responseCreates(h.socket).length;
    await wait(80);
    assert.equal(responseCreates(h.socket).length, before + 1);
    const instruction = latestResponse(h.socket).response.instructions;
    assert.match(instruction, /What kind of work are you looking to have done\?/);
    assert.doesNotMatch(instruction, /thank you for calling/i);
  } finally {
    h.restore();
  }
});

test('the silence timer does not begin before generated receptionist audio can finish playing', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'playback-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
      audio: Buffer.alloc(8_000).toString('base64'),
    });
    const before = responseCreates(h.socket).length;
    await wait(80);
    assert.equal(responseCreates(h.socket).length, before);
  } finally {
    h.restore();
  }
});

test('an empty sidecar transcription falls back to native audio without duplicating the greeting', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    h.socket.receive({ type: 'response.created', response: { id: 'overlap-greeting' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'overlap-greeting',
      item_id: 'overlap-greeting-item',
      delta: Buffer.alloc(800).toString('base64'),
    });
    h.socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'empty-overlap',
      transcript: '',
    });
    h.socket.receive({
      type: 'response.done',
      response: { id: 'overlap-greeting', output: [] },
    });
    await nextTurn();

    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    assert.match(latestResponse(h.socket).response.instructions, /latest caller audio.*primary evidence/i);

    await finishAnalysis(h.socket, {
      responseId: 'empty-overlap-analysis',
      args: analysis({
        heard_text: '',
        turn_status: 'unintelligible',
      }),
    });
    const instruction = latestResponse(h.socket).response.instructions;
    assert.match(instruction, /What kind of work are you looking to have done\?/);
    assert.match(instruction, /didn't catch/i);
    assert.doesNotMatch(instruction, /thank you for calling/i);
  } finally {
    h.restore();
  }
});

test('a hold request waits longer and then asks whether the caller is still there', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20, holdRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'hold-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    const before = responseCreates(h.socket).length;
    caller(h.socket, 'Hold on one second.', 'caller-hold');
    assert.equal(responseCreates(h.socket).length, before + 1);
    assert.match(latestResponse(h.socket).response.instructions, /Okay, waiting\./);
    await finishSpeech(h.socket, {
      responseId: 'hold-acknowledgement',
      transcript: 'Okay, waiting.',
    });
    const afterAcknowledgement = responseCreates(h.socket).length;
    await wait(80);
    assert.equal(responseCreates(h.socket).length, afterAcknowledgement + 1);
    assert.match(latestResponse(h.socket).response.instructions, /Are you still there\?/);
  } finally {
    h.restore();
  }
});

test('speaking before the hold timeout resumes analysis without a still-there prompt', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20, holdRecoveryMs: 100 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'resume-hold-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    caller(h.socket, 'Wait a second.', 'caller-hold-before-answer');
    assert.match(latestResponse(h.socket).response.instructions, /Okay, waiting\./);
    await finishSpeech(h.socket, {
      responseId: 'resume-hold-acknowledgement',
      transcript: 'Okay, waiting.',
    });
    const beforeAnswer = responseCreates(h.socket).length;
    caller(h.socket, 'I need exterior painting.', 'caller-answer-after-hold');
    assert.equal(responseCreates(h.socket).length, beforeAnswer + 1);
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    assert.match(latestResponse(h.socket).response.instructions, /"holdActive":true/);
    await finishAnalysis(h.socket, {
      responseId: 'resume-hold-analysis',
      args: analysis({
        service_status: 'complete',
        fields: { service: 'Exterior Painting' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /what name should I use/i);
    await wait(140);
    assert.equal(
      responseCreates(h.socket).some((event) => /Are you still there/i.test(event.response?.instructions || '')),
      false,
    );
  } finally {
    h.restore();
  }
});

test('unrelated speech during a hold changes no field and preserves the original hold deadline', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20, holdRecoveryMs: 100 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'background-hold-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    caller(h.socket, 'Wait one second, hold on.', 'background-hold-request');
    await finishSpeech(h.socket, {
      responseId: 'background-hold-acknowledgement',
      transcript: 'Okay, waiting.',
    });

    await wait(40);
    caller(h.socket, 'Where did I put that tape?', 'background-hold-speech');
    const analysisRequest = latestResponse(h.socket);
    assert.equal(analysisRequest.response.tool_choice.name, 'analyze_caller_turn');
    assert.match(analysisRequest.response.instructions, /"holdActive":true/);
    await finishAnalysis(h.socket, {
      responseId: 'background-hold-analysis',
      args: analysis({ turn_status: 'background_speech' }),
    });
    const afterBackgroundAnalysis = responseCreates(h.socket).length;
    assert.equal(h.receptionist.snapshot().state.pendingField, 'service');

    await wait(80);
    assert.equal(responseCreates(h.socket).length, afterBackgroundAnalysis + 1);
    assert.match(latestResponse(h.socket).response.instructions, /Are you still there\?/);
  } finally {
    h.restore();
  }
});

test('a standalone return from hold immediately repeats the pending question', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20, holdRecoveryMs: 100 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'return-hold-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    caller(h.socket, 'Give me a moment.', 'return-hold-request');
    await finishSpeech(h.socket, {
      responseId: 'return-hold-acknowledgement',
      transcript: 'Okay, waiting.',
    });

    const beforeReturn = responseCreates(h.socket).length;
    caller(h.socket, "Okay, I'm ready.", 'return-from-hold');
    assert.equal(responseCreates(h.socket).length, beforeReturn + 1);
    assert.match(
      latestResponse(h.socket).response.instructions,
      /What kind of work are you looking to have done\?/,
    );
    await wait(140);
    assert.equal(
      responseCreates(h.socket).some((event) => /Are you still there/i.test(event.response?.instructions || '')),
      false,
    );
  } finally {
    h.restore();
  }
});

test('a split caller sentence is recombined even when the first analysis already finished', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 100 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'split-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    caller(h.socket, 'I need', 'caller-split-one');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-split-one',
      args: analysis({ turn_status: 'unfinished' }),
    });
    caller(h.socket, 'exterior painting.', 'caller-split-two');
    assert.match(
      latestResponse(h.socket).response.instructions,
      /LATEST_CALLER_TRANSCRIPT="I need exterior painting\."/,
    );
  } finally {
    h.restore();
  }
});

test('a pause after a schedule lead-in waits for and combines the exact time', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 200 });
  try {
    await advanceHarnessToScheduleQuestion(h.socket, { idPrefix: 'paused-schedule' });
    const beforeFragment = responseCreates(h.socket).length;

    caller(h.socket, 'Tuesday at', 'paused-schedule-date-fragment');
    await nextTurn();

    assert.equal(responseCreates(h.socket).length, beforeFragment);
    assert.equal(h.receptionist.snapshot().state.pendingField, 'schedule');

    caller(h.socket, '2 PM.', 'paused-schedule-time-fragment');
    await nextTurn();

    assert.equal(responseCreates(h.socket).length, beforeFragment + 1);
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    assert.match(
      latestResponse(h.socket).response.instructions,
      /LATEST_CALLER_TRANSCRIPT="Tuesday at 2 PM\."/,
    );

    await finishAnalysis(h.socket, {
      responseId: 'paused-schedule-analysis',
      args: analysis({
        fields: { preferred_date: 'Tuesday', preferred_time: '2 PM' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /additional notes/i);
    assert.doesNotMatch(latestResponse(h.socket).response.instructions, /AM or PM/i);
    assert.equal(h.errors.length, 0);
  } finally {
    h.restore();
  }
});

test('transcription failure falls back to the live model\'s native audio understanding', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'transcription-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
      audio: '',
    });
    const before = responseCreates(h.socket).length;
    h.socket.receive({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'failed-sidecar-transcription',
      error: { message: 'transcription unavailable' },
    });
    assert.equal(responseCreates(h.socket).length, before + 1);
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    assert.match(latestResponse(h.socket).response.instructions, /latest caller audio.*primary evidence/i);

    await finishAnalysis(h.socket, {
      responseId: 'failed-sidecar-native-analysis',
      args: analysis({
        heard_text: 'I need the outside of my house painted.',
        service_status: 'complete',
        fields: { service: 'Exterior Painting' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /what name should I use/i);
    assert.equal(h.receptionist.snapshot().state.values.service, 'Exterior Painting');
    assert.match(h.errors[0].message, /transcription unavailable/i);
  } finally {
    h.restore();
  }
});

test('a failed speech response is retried without advancing state', async () => {
  const h = await createHarness();
  try {
    const originalGreeting = latestResponse(h.socket).response.instructions;
    h.socket.receive({ type: 'response.created', response: { id: 'failed-greeting' } });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'failed-greeting',
        status: 'failed',
        status_details: { error: { message: 'temporary response failure' } },
        output: [],
      },
    });
    await nextTurn();
    assert.equal(latestResponse(h.socket).response.instructions, originalGreeting);
    assert.equal(h.receptionist.snapshot().state.pendingField, 'service');
    assert.match(h.errors[0].message, /temporary response failure/i);
  } finally {
    h.restore();
  }
});

test('an output-limited summary uses a concise recovery instead of replaying the full summary', async () => {
  const h = await createHarness();
  try {
    const summaryRequest = await advanceHarnessToSummaryRequest(h.socket);
    const originalInstructions = summaryRequest.response.instructions;
    assert.match(originalInstructions, /here's the summary/i);
    assert.equal(summaryRequest.response.max_output_tokens, 4_096);

    h.socket.receive({ type: 'response.created', response: { id: 'limited-summary' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'limited-summary',
      item_id: 'limited-summary-item',
      delta: Buffer.alloc(800).toString('base64'),
    });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'limited-summary',
        status: 'incomplete',
        status_details: { reason: 'max_output_tokens' },
        output: [],
      },
    });
    await nextTurn();

    const recoveryRequest = latestResponse(h.socket);
    assert.notEqual(recoveryRequest.response.instructions, originalInstructions);
    assert.match(recoveryRequest.response.instructions, /readback was cut off/i);
    assert.match(recoveryRequest.response.instructions, /Does that all sound right/i);
    assert.doesNotMatch(recoveryRequest.response.instructions, /here's the summary/i);
    assert.equal(recoveryRequest.response.max_output_tokens, 4_096);
    assert.equal(
      responseCreates(h.socket).filter((event) => /here's the summary/i.test(
        event.response?.instructions || '',
      )).length,
      1,
    );
    assert.match(h.errors[0].message, /max_output_tokens/i);
  } finally {
    h.restore();
  }
});

test('a rejected response.create event is recovered instead of wedging the call', async () => {
  const h = await createHarness();
  try {
    const firstCreate = latestResponse(h.socket);
    h.socket.receive({
      type: 'error',
      error: {
        event_id: firstCreate.event_id,
        message: 'response creation rejected',
      },
    });
    assert.equal(responseCreates(h.socket).length, 2);
    assert.equal(latestResponse(h.socket).response.instructions, firstCreate.response.instructions);
    assert.match(h.errors[0].message, /response creation rejected/i);
  } finally {
    h.restore();
  }
});

test('caller speech while the receptionist is talking is queued without cancelling audio', async () => {
  const h = await createHarness();
  try {
    h.socket.receive({ type: 'response.created', response: { id: 'active-greeting' } });
    h.socket.receive({ type: 'input_audio_buffer.speech_started', item_id: 'caller-overlap' });
    caller(h.socket, 'I need exterior painting.', 'caller-overlap');
    const beforeDone = responseCreates(h.socket).length;
    assert.equal(beforeDone, 1);
    h.socket.receive({
      type: 'response.done',
      response: { id: 'active-greeting', output: [] },
    });
    await nextTurn();
    assert.equal(responseCreates(h.socket).length, 2);
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    assert.equal(
      h.socket.sent.some((event) => event.type === 'response.cancel'),
      false,
    );
    assert.equal(h.playbackClears.length, 0);
  } finally {
    h.restore();
  }
});

test('a timed question repeat yields immediately when the caller answers', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'repeat-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
      audio: '',
    });
    const beforeRepeat = responseCreates(h.socket).length;
    await wait(80);
    assert.equal(responseCreates(h.socket).length, beforeRepeat + 1);
    assert.match(
      latestResponse(h.socket).response.instructions,
      /What kind of work are you looking to have done\?/,
    );

    h.socket.receive({ type: 'response.created', response: { id: 'active-repeat' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'active-repeat',
      item_id: 'active-repeat-item',
      content_index: 0,
      delta: Buffer.alloc(32_000).toString('base64'),
    });

    h.socket.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: 'caller-retry-answer',
    });

    assert.equal(h.playbackClears.length, 1);
    assert.deepEqual(
      h.socket.sent.find((event) => (
        event.type === 'response.cancel'
        && event.response_id === 'active-repeat'
      )),
      { type: 'response.cancel', response_id: 'active-repeat' },
    );
    const truncation = h.socket.sent.find((event) => (
      event.type === 'conversation.item.truncate'
      && event.item_id === 'active-repeat-item'
    ));
    assert.equal(truncation.content_index, 0);
    assert.ok(truncation.audio_end_ms >= 0);
    assert.ok(truncation.audio_end_ms < 4_000);

    const audioBeforeLateDelta = h.audio.length;
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'active-repeat',
      item_id: 'active-repeat-item',
      delta: Buffer.alloc(800).toString('base64'),
    });
    assert.equal(h.audio.length, audioBeforeLateDelta);

    h.socket.receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'caller-retry-answer',
    });
    h.socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'caller-retry-answer',
      transcript: 'The whole outside of my house needs painting.',
    });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'active-repeat',
        status: 'cancelled',
        output: [],
      },
    });
    await nextTurn();
    await nextTurn();

    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-retry-answer',
      args: analysis({
        service_status: 'complete',
        project_note: 'Paint the whole outside of the house.',
        fields: { service: 'Exterior Painting' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /what name should I use/i);
    assert.deepEqual(h.receptionist.snapshot().state.notes, [
      'Paint the whole outside of the house.',
    ]);
    assert.equal(h.errors.length, 0);
  } finally {
    h.restore();
  }
});

test('a newer caller turn supersedes stale analysis before the receptionist can repeat', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'stale-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    caller(h.socket, 'I need my living room painted.', 'stale-service');
    await finishAnalysis(h.socket, {
      responseId: 'stale-service-analysis',
      args: analysis({
        service_status: 'complete',
        project_note: 'Paint the living room.',
        fields: { service: 'Interior Painting' },
      }),
    });
    await finishSpeech(h.socket, {
      responseId: 'stale-name-question',
      transcript: 'Okay, what name should I use for the service request?',
    });
    caller(h.socket, 'Andrew Christensen.', 'stale-name');
    await finishAnalysis(h.socket, {
      responseId: 'stale-name-analysis',
      args: analysis({ fields: { name: 'Andrew Christensen' } }),
    });
    await finishSpeech(h.socket, {
      responseId: 'stale-address-question',
      transcript: "Thanks. What's the full address where the service is needed?",
    });
    caller(h.socket, "That'd be 197 Lancaster Road.", 'stale-street');
    await finishAnalysis(h.socket, {
      responseId: 'stale-street-analysis',
      args: analysis({
        address_status: 'partial',
        fields: { address: '197 Lancaster Road' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /city or town and state/i);
    await finishSpeech(h.socket, {
      responseId: 'stale-locality-question',
      transcript: 'What city or town and state is that in?',
    });

    caller(h.socket, 'Brown University.', 'stale-bad-locality');
    h.socket.receive({
      type: 'response.created',
      response: { id: 'stale-bad-locality-analysis' },
    });
    h.socket.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: 'stale-good-locality',
    });
    h.socket.receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'stale-good-locality',
    });
    const beforeOldAnalysisFinishes = responseCreates(h.socket).length;
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'stale-bad-locality-analysis',
        output: [{
          id: 'stale-bad-locality-call-item',
          type: 'function_call',
          name: 'analyze_caller_turn',
          call_id: 'stale-bad-locality-call',
          arguments: JSON.stringify(analysis({ address_status: 'partial' })),
        }],
      },
    });
    await nextTurn();
    await nextTurn();
    assert.equal(responseCreates(h.socket).length, beforeOldAnalysisFinishes);

    h.socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'stale-good-locality',
      transcript: 'Berlin, Massachusetts.',
    });
    await nextTurn();
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    await finishAnalysis(h.socket, {
      responseId: 'stale-combined-locality-analysis',
      args: analysis({ turn_status: 'background_speech' }),
    });

    assert.match(latestResponse(h.socket).response.instructions, /date and exact time/i);
    assert.equal(
      h.receptionist.snapshot().state.values.address,
      '197 Lancaster Road, Berlin, Massachusetts',
    );
    assert.equal(
      responseCreates(h.socket).filter((event) => /city or town and state/i.test(
        event.response?.instructions || '',
      )).length,
      1,
    );
    assert.equal(h.errors.length, 0);
  } finally {
    h.restore();
  }
});

test('silence repeats the AM-or-PM clarification instead of replacing it with a generic time question', async () => {
  const h = await createHarness({
    context: {
      ...CONTEXT,
      earliestServiceRequestStart: '00:00',
      latestServiceRequestStart: '23:59',
    },
    incompleteTurnRecoveryMs: 20,
  });
  try {
    await finishSpeech(h.socket, {
      responseId: 'meridiem-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    const steps = [
      {
        callerText: 'Interior painting.',
        args: analysis({
          service_status: 'complete',
          fields: { service: 'Interior Painting' },
        }),
        speech: 'Okay, what name should I use for the service request?',
      },
      {
        callerText: 'Andrew Christensen.',
        args: analysis({ fields: { name: 'Andrew Christensen' } }),
        speech: "Thanks. What's the full address where the service is needed?",
      },
      {
        callerText: '197 Lancaster Road, Berlin, Massachusetts.',
        args: analysis({
          address_status: 'complete',
          fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
        }),
        speech: 'Got it. What date and exact time would you prefer for the service request?',
      },
    ];
    for (const [index, step] of steps.entries()) {
      caller(h.socket, step.callerText, `meridiem-caller-${index}`);
      await finishAnalysis(h.socket, {
        responseId: `meridiem-analysis-${index}`,
        args: step.args,
      });
      await finishSpeech(h.socket, {
        responseId: `meridiem-speech-${index}`,
        transcript: step.speech,
      });
    }

    caller(h.socket, 'Next Monday at 6.', 'meridiem-schedule');
    await finishAnalysis(h.socket, {
      responseId: 'meridiem-schedule-analysis',
      args: analysis({
        fields: { preferred_date: 'Next Monday', preferred_time: '6' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /Do you mean AM or PM\?/i);
    await finishSpeech(h.socket, {
      responseId: 'meridiem-clarification',
      transcript: 'Do you mean AM or PM?',
      audio: '',
    });

    const beforeRepeat = responseCreates(h.socket).length;
    await wait(80);
    assert.equal(responseCreates(h.socket).length, beforeRepeat + 1);
    const retry = latestResponse(h.socket).response.instructions;
    assert.match(retry, /Do you mean AM or PM\?/i);
    assert.doesNotMatch(retry, /What time would work best/i);
    assert.equal(h.errors.length, 0);
  } finally {
    h.restore();
  }
});

test('an immediate clarification remains non-interruptible', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'clarification-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
      audio: '',
    });
    caller(h.socket, 'คุณหนึ่ง อ่า เสียใหม่', 'caller-unclear');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-unclear',
      args: analysis({ turn_status: 'unintelligible' }),
    });

    assert.match(latestResponse(h.socket).response.instructions, /didn't catch/i);
    h.socket.receive({ type: 'response.created', response: { id: 'active-clarification' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'active-clarification',
      item_id: 'active-clarification-item',
      content_index: 0,
      delta: Buffer.alloc(32_000).toString('base64'),
    });
    h.socket.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: 'caller-clarification-answer',
    });

    assert.equal(h.playbackClears.length, 0);
    assert.equal(
      h.socket.sent.some((event) => event.type === 'response.cancel'),
      false,
    );
    assert.equal(
      h.socket.sent.some((event) => event.type === 'conversation.item.truncate'),
      false,
    );

    caller(
      h.socket,
      'The whole outside of my house needs painting.',
      'caller-clarification-answer',
    );
    h.socket.receive({
      type: 'response.done',
      response: { id: 'active-clarification', output: [] },
    });
    await nextTurn();
    await nextTurn();

    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    assert.equal(h.errors.length, 0);
  } finally {
    h.restore();
  }
});

test('the first question remains non-interruptible even for an explicit correction', async () => {
  const h = await createHarness();
  try {
    h.socket.receive({ type: 'response.created', response: { id: 'corrected-greeting' } });
    h.socket.receive({
      type: 'response.output_audio.delta',
      response_id: 'corrected-greeting',
      item_id: 'corrected-greeting-item',
      delta: Buffer.alloc(800).toString('base64'),
    });
    h.socket.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: 'caller-correction-overlap',
    });
    caller(
      h.socket,
      'Wait, scratch that. Make it Tuesday at 2.',
      'caller-correction-overlap',
    );

    assert.equal(h.playbackClears.length, 0);
    assert.equal(
      h.socket.sent.some((event) => event.type === 'response.cancel'),
      false,
    );
    h.socket.receive({
      type: 'response.done',
      response: { id: 'corrected-greeting', output: [] },
    });
    await nextTurn();
    await nextTurn();

    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    assert.equal(h.errors.length, 0);
  } finally {
    h.restore();
  }
});

test('a missing analysis tool call retries and then asks the pending question instead of going silent', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'retry-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    caller(h.socket, 'I need exterior painting.', 'caller-retry');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-missing-one',
      args: analysis(),
      includeTool: false,
    });
    assert.equal(latestResponse(h.socket).response.tool_choice.name, 'analyze_caller_turn');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-missing-two',
      args: analysis(),
      includeTool: false,
    });
    assert.match(latestResponse(h.socket).response.instructions, /What kind of work are you looking to have done/);
  } finally {
    h.restore();
  }
});

test('analysis uses a larger token budget and safely handles repeated output-limit failures', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'token-budget-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    const question = 'I just asked how long will it take for the job to get done.';
    caller(h.socket, question, 'caller-token-budget');

    const initialAnalysis = latestResponse(h.socket);
    assert.equal(initialAnalysis.response.max_output_tokens, 2_048);
    assert.equal(initialAnalysis.response.tool_choice.name, 'analyze_caller_turn');

    h.socket.receive({ type: 'response.created', response: { id: 'analysis-token-limit-one' } });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'analysis-token-limit-one',
        status: 'incomplete',
        status_details: { reason: 'max_output_tokens' },
        output: [],
      },
    });
    await nextTurn();
    assert.equal(latestResponse(h.socket).response.max_output_tokens, 4_096);

    h.socket.receive({ type: 'response.created', response: { id: 'analysis-token-limit-two' } });
    h.socket.receive({
      type: 'response.done',
      response: {
        id: 'analysis-token-limit-two',
        status: 'incomplete',
        status_details: { reason: 'max_output_tokens' },
        output: [],
      },
    });
    await nextTurn();
    await nextTurn();

    const recoveryInstructions = latestResponse(h.socket).response.instructions;
    assert.doesNotMatch(recoveryInstructions, /I don't know that/i);
    assert.doesNotMatch(recoveryInstructions, /add that question to the notes/i);
    assert.match(recoveryInstructions, /What kind of work are you looking to have done/i);
    assert.deepEqual(h.receptionist.snapshot().state.notes, []);
    assert.equal(h.errors.length, 2);
    assert.match(h.errors[0].message, /max_output_tokens/i);
  } finally {
    h.restore();
  }
});

test('latency telemetry separates analysis from first-audio generation', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'latency-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
    });
    caller(h.socket, 'Exterior painting.', 'caller-latency');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-latency',
      args: analysis({
        service_status: 'complete',
        fields: { service: 'Exterior Painting' },
      }),
    });
    await finishSpeech(h.socket, {
      responseId: 'speech-latency',
      transcript: 'Okay, what name should I use for the service request?',
    });
    assert.equal(h.latencies.length >= 1, true);
    const metric = h.latencies.at(-1);
    assert.equal(Number.isFinite(metric.speechStoppedToTranscriptMs), true);
    assert.equal(Number.isFinite(metric.speechStoppedToFirstAudioMs), true);
    assert.equal(Number.isFinite(metric.callerTranscriptToFirstAudioMs), true);
    assert.equal(Number.isFinite(metric.analysisMs), true);
    assert.equal(Number.isFinite(metric.speechGenerationMs), true);
  } finally {
    h.restore();
  }
});

test('response limit still triggers the server cost guard', async () => {
  const previousLimit = process.env.OPENAI_MAX_RESPONSES_PER_CALL;
  process.env.OPENAI_MAX_RESPONSES_PER_CALL = '10';
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let limit = null;
  const receptionist = createOpenAiReceptionist({
    context: CONTEXT,
    runtime: { clientId: 'client-123' },
    callControlId: 'call-limit',
    callerPhone: '+15555550123',
    deliver: async () => ({ ok: true }),
    onAudio: () => {},
    onReady: () => {},
    onCostLimit: (event) => { limit = event; },
    onError: (error) => assert.fail(error.message),
    WebSocketClass: FakeWebSocket,
  });
  try {
    await nextTurn();
    const socket = FakeWebSocket.instance;
    for (let count = 0; count < 10; count += 1) {
      socket.receive({ type: 'response.created', response: { id: `limit-${count}` } });
    }
    assert.equal(limit.maximumResponses, 10);
    assert.equal(receptionist.snapshot().responseCount, 10);
  } finally {
    receptionist.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousLimit === undefined) delete process.env.OPENAI_MAX_RESPONSES_PER_CALL;
    else process.env.OPENAI_MAX_RESPONSES_PER_CALL = previousLimit;
  }
});
