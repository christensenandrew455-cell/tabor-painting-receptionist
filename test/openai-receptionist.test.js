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
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '09:00',
  latestEstimateStart: '16:00',
  services: [
    { name: 'Exterior Painting', description: 'Exterior painting' },
    { name: 'Interior Painting', description: 'Interior painting' },
  ],
  knowledgeJson: '{"businessHours":"Monday through Friday"}',
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

async function createHarness({ deliver, incompleteTurnRecoveryMs } = {}) {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const audio = [];
  const transcripts = [];
  const submitted = [];
  const goodbye = [];
  const errors = [];
  const latencies = [];
  const receptionist = createOpenAiReceptionist({
    context: CONTEXT,
    runtime: { clientId: 'client-123' },
    callControlId: 'call-123',
    callerPhone: '+15555550123',
    deliver: deliver || (async () => ({ ok: true })),
    onAudio: (value) => audio.push(value),
    onTranscript: (entry) => transcripts.push(entry),
    onSubmitted: (snapshot) => submitted.push(snapshot),
    onReady: () => {},
    onGoodbyeComplete: () => goodbye.push(true),
    onCostLimit: () => {},
    onUsage: () => {},
    onLatency: (entry) => latencies.push(entry),
    onError: (error) => errors.push(error),
    incompleteTurnRecoveryMs,
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
    restore() {
      receptionist.close();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    },
  };
}

test('session uses responsive semantic turn detection without caller barge-in', () => {
  const event = buildSessionUpdate(CONTEXT);
  assert.equal(event.type, 'session.update');
  assert.equal(event.session.model, 'gpt-realtime-2.1-mini');
  assert.equal(event.session.audio.input.format.type, 'audio/pcmu');
  assert.equal(event.session.audio.output.format.type, 'audio/pcmu');
  assert.equal(event.session.audio.output.voice, 'marin');
  assert.equal(event.session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(event.session.audio.input.noise_reduction.type, 'far_field');
  assert.deepEqual(event.session.audio.input.turn_detection, {
    type: 'semantic_vad',
    eagerness: 'high',
    create_response: false,
    interrupt_response: false,
  });
  assert.deepEqual(event.session.tools, []);
  assert.equal(event.session.tool_choice, 'none');
});

test('prompt has one state owner and a short, explicit knowledge boundary', () => {
  const prompt = buildReceptionistInstructions(CONTEXT);
  assert.match(prompt, /server owns the intake state, question order, validation, confirmation, submission, and hangup/i);
  assert.match(prompt, /ordinary general knowledge only to understand natural speech/i);
  assert.match(prompt, /only when the supplied business information explicitly supports/i);
  assert.match(prompt, /call it once without speaking/i);
  assert.doesNotMatch(prompt, /delete|blocked output|repair attempts|completedIntakeFields/i);
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
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
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
      transcript: 'Okay, what name should I use for the estimate request?',
    });

    caller(h.socket, 'Andrew Christensen.', 'caller-name');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-name',
      args: analysis({ fields: { name: 'Andrew Christensen' } }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /full project address/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-address',
      transcript: "Thanks. What's the full project address?",
    });

    caller(h.socket, '197 Lancaster Road, Berlin, Massachusetts.', 'caller-address');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-address',
      args: analysis({
        address_status: 'complete',
        fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /day or date/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-schedule',
      transcript: 'Got it. What day or date would you prefer for the estimate, and what time works best?',
    });

    caller(h.socket, 'Tuesday, August 11, 2099 at 2 PM.', 'caller-schedule');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-schedule',
      args: analysis({
        fields: { preferred_date: 'August 11 2099', preferred_time: '2 PM' },
      }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /notes or questions/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-notes',
      transcript: 'Okay, sounds good. Do you have any notes or questions for the business?',
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
    await finishSpeech(h.socket, {
      responseId: 'summary',
      transcript: "Okay, here's the summary. Andrew Christensen is requesting Exterior Painting at 197 Lancaster Road, Berlin, Massachusetts. The preferred date and time is Tuesday, August 11, 2099 at 2:00 PM. Does that all sound right?",
    });

    caller(h.socket, 'Yes, that all sounds right.', 'caller-summary');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-summary',
      args: analysis({ summary_confirmation: 'yes' }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /sending the estimate request in now/i);
    assert.equal(deliveries.length, 0);
    await finishSpeech(h.socket, {
      responseId: 'pre-submit',
      transcript: "Okay, thanks for confirming. I'm sending the estimate request in now.",
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.service, 'Exterior Painting');
    assert.equal(deliveries[0].payload.name, 'Andrew Christensen');
    assert.equal(deliveries[0].payload.address, '197 Lancaster Road, Berlin, Massachusetts');
    assert.equal(deliveries[0].payload.requestedTime, '2:00 PM');
    assert.equal(deliveries[0].payload.summaryConfirmed, true);
    assert.equal(h.submitted.length, 1);

    assert.match(latestResponse(h.socket).response.instructions, /request has been submitted/i);
    await finishSpeech(h.socket, {
      responseId: 'success',
      transcript: "You're all set. Your estimate request has been submitted.",
    });
    assert.match(latestResponse(h.socket).response.instructions, /Thank you for calling Tabor Painting/i);
    await finishSpeech(h.socket, {
      responseId: 'goodbye',
      transcript: 'Thank you for calling Tabor Painting. Have a good day.',
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

test('filler creates no model response and does not advance the call', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'filler-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
    });
    const before = responseCreates(h.socket).length;
    caller(h.socket, 'Oh.', 'caller-filler');
    assert.equal(responseCreates(h.socket).length, before);
    assert.equal(h.receptionist.snapshot().state.pendingField, 'service');
  } finally {
    h.restore();
  }
});

test('an abandoned filler turn gets a delayed prompt instead of indefinite silence', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'recovery-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
    });
    const before = responseCreates(h.socket).length;
    caller(h.socket, 'Um...', 'caller-abandoned-filler');
    assert.equal(responseCreates(h.socket).length, before);
    await wait(80);
    assert.equal(responseCreates(h.socket).length, before + 1);
    assert.match(latestResponse(h.socket).response.instructions, /What kind of work do you need done/);
  } finally {
    h.restore();
  }
});

test('a split caller sentence is recombined even when the first analysis already finished', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 100 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'split-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
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

test('transcription failure produces a useful retry prompt instead of silence', async () => {
  const h = await createHarness({ incompleteTurnRecoveryMs: 20 });
  try {
    await finishSpeech(h.socket, {
      responseId: 'transcription-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
    });
    const before = responseCreates(h.socket).length;
    h.socket.receive({
      type: 'conversation.item.input_audio_transcription.failed',
      error: { message: 'transcription unavailable' },
    });
    await wait(80);
    assert.equal(responseCreates(h.socket).length, before + 1);
    assert.match(latestResponse(h.socket).response.instructions, /didn't catch that/i);
    assert.match(latestResponse(h.socket).response.instructions, /what kind of work/i);
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
  } finally {
    h.restore();
  }
});

test('a missing analysis tool call retries and then asks the pending question instead of going silent', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'retry-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
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
    assert.match(latestResponse(h.socket).response.instructions, /What kind of work do you need done/);
  } finally {
    h.restore();
  }
});

test('latency telemetry separates analysis from first-audio generation', async () => {
  const h = await createHarness();
  try {
    await finishSpeech(h.socket, {
      responseId: 'latency-greeting',
      transcript: 'Hi, thank you for calling Tabor Painting. What kind of work do you need done?',
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
      transcript: 'Okay, what name should I use for the estimate request?',
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
