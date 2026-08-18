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
  businessInformation: [
    { title: 'Warranty', info: 'One year on labor.' },
  ],
  knowledgeJson: '{"businessInformation":[{"title":"Warranty","info":"One year on labor."}]}',
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
  deliver,
  incompleteTurnRecoveryMs,
  holdRecoveryMs,
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
    runtime: { clientId: 'client-123' },
    callControlId: 'call-123',
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

async function advanceHarnessToSummaryRequest(socket) {
  await finishSpeech(socket, {
    responseId: 'summary-path-greeting',
    transcript: 'Hi, thank you for calling Tabor Painting. What kind of work are you looking to have done?',
  });
  const steps = [
    {
      callerText: 'I need exterior painting.',
      args: analysis({
        service_status: 'complete',
        fields: { service: 'Exterior Painting' },
      }),
      speech: 'Okay, what name should I use for the estimate request?',
    },
    {
      callerText: 'Jordan Smith.',
      args: analysis({ fields: { name: 'Jordan Smith' } }),
      speech: "Thanks. What's the full project address?",
    },
    {
      callerText: '123 Main Street, Albany, New York.',
      args: analysis({
        address_status: 'complete',
        fields: { address: '123 Main Street, Albany, New York' },
      }),
      speech: 'Got it. What day or date would you prefer for the estimate, and what time works best?',
    },
    {
      callerText: 'Tuesday, August 11, 2099 at 2 PM.',
      args: analysis({
        fields: { preferred_date: 'August 11 2099', preferred_time: '2 PM' },
      }),
      speech: 'Okay, sounds good. Do you have any additional notes and/or business questions?',
    },
    {
      callerText: 'No.',
      args: analysis({ notes_complete: true }),
      speech: 'Okay, thanks. One more question. Do you consent to being contacted by Tabor Painting?',
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
    prompt: 'A telephone call collecting a service estimate request. Preserve names, United States addresses, dates, exact clock times, AM or PM, and short yes or no answers.',
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
  assert.match(prompt, /only objective is to help the caller complete one service estimate request/i);
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
      transcript: 'Okay, what name should I use for the estimate request?',
    });

    caller(h.socket, 'Jordan Smith.', 'caller-name');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-name',
      args: analysis({ fields: { name: 'Jordan Smith' } }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /full project address/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-address',
      transcript: "Thanks. What's the full project address?",
    });

    caller(h.socket, '123 Main Street, Albany, New York.', 'caller-address');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-address',
      args: analysis({
        address_status: 'complete',
        fields: { address: '123 Main Street, Albany, New York' },
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
    assert.match(latestResponse(h.socket).response.instructions, /additional notes/i);
    await finishSpeech(h.socket, {
      responseId: 'ask-notes',
      transcript: 'Okay, sounds good. Do you have any additional notes and/or business questions?',
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
    assert.equal(latestResponse(h.socket).response.max_output_tokens, 4_096);
    await finishSpeech(h.socket, {
      responseId: 'summary',
      transcript: "Okay, here's the summary. Jordan Smith is requesting Exterior Painting at 123 Main Street, Albany, New York. The preferred date and time is Tuesday, August 11, 2099 at 2:00 PM. Does that all sound right?",
    });

    caller(h.socket, 'Yes, that all sounds right.', 'caller-summary');
    await finishAnalysis(h.socket, {
      responseId: 'analysis-summary',
      args: analysis({ summary_confirmation: 'yes' }),
    });
    assert.match(latestResponse(h.socket).response.instructions, /submitting your estimate request now/i);
    assert.equal(deliveries.length, 0);
    await finishSpeech(h.socket, {
      responseId: 'pre-submit',
      transcript: "I'm submitting your estimate request now.",
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.service, 'Exterior Painting');
    assert.equal(deliveries[0].payload.name, 'Jordan Smith');
    assert.equal(deliveries[0].payload.address, '123 Main Street, Albany, New York');
    assert.equal(deliveries[0].payload.requestedTime, '2:00 PM');
    assert.equal(deliveries[0].payload.summaryConfirmed, true);
    assert.equal(h.submitted.length, 1);

    assert.match(latestResponse(h.socket).response.instructions, /request has been submitted/i);
    await finishSpeech(h.socket, {
      responseId: 'success',
      transcript: "You're all set. Your estimate request has been submitted.",
    });
    assert.match(
      latestResponse(h.socket).response.instructions,
      /Thank you for filling out an estimate request\. Have a good day\./i,
    );
    await finishSpeech(h.socket, {
      responseId: 'goodbye',
      transcript: 'Thank you for filling out an estimate request. Have a good day.',
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

test('an empty transcription during the greeting cannot create a duplicate opening prompt', async () => {
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

    const before = responseCreates(h.socket).length;
    await wait(60);
    assert.equal(responseCreates(h.socket).length, before);
    await wait(100);
    assert.equal(responseCreates(h.socket).length, before + 1);
    const instruction = latestResponse(h.socket).response.instructions;
    assert.match(instruction, /What kind of work are you looking to have done\?/);
    assert.doesNotMatch(instruction, /didn't catch|thank you for calling/i);
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

test('transcription failure produces a useful retry prompt instead of silence', async () => {
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
      transcript: 'Okay, what name should I use for the estimate request?',
    });
    caller(h.socket, 'Andrew Christensen.', 'stale-name');
    await finishAnalysis(h.socket, {
      responseId: 'stale-name-analysis',
      args: analysis({ fields: { name: 'Andrew Christensen' } }),
    });
    await finishSpeech(h.socket, {
      responseId: 'stale-address-question',
      transcript: "Thanks. What's the full project address?",
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

    assert.match(latestResponse(h.socket).response.instructions, /day or date/i);
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
      earliestEstimateStart: '00:00',
      latestEstimateStart: '23:59',
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
        speech: 'Okay, what name should I use for the estimate request?',
      },
      {
        callerText: 'Andrew Christensen.',
        args: analysis({ fields: { name: 'Andrew Christensen' } }),
        speech: "Thanks. What's the full project address?",
      },
      {
        callerText: '197 Lancaster Road, Berlin, Massachusetts.',
        args: analysis({
          address_status: 'complete',
          fields: { address: '197 Lancaster Road, Berlin, Massachusetts' },
        }),
        speech: 'Got it. What day or date would you prefer for the estimate, and what time works best?',
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
