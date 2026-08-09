import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildReceptionistInstructions,
  buildSessionUpdate,
  createOpenAiReceptionist,
  END_CALL_TOOL,
  ESTIMATE_TOOLS,
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

test('configures PCMU audio, low-cost transcripts, and the two-step estimate tools', () => {
  const event = buildSessionUpdate(CONTEXT);
  assert.equal(event.type, 'session.update');
  assert.equal(event.session.model, 'gpt-realtime-2.1-mini');
  assert.equal(event.session.audio.input.format.type, 'audio/pcmu');
  assert.equal(event.session.audio.output.format.type, 'audio/pcmu');
  assert.equal(event.session.audio.output.voice, 'marin');
  assert.equal(event.session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(event.session.audio.input.transcription.language, 'en');
  assert.equal(event.session.audio.input.noise_reduction.type, 'far_field');
  assert.equal(event.session.audio.input.turn_detection.threshold, 0.45);
  assert.equal(event.session.audio.input.turn_detection.prefix_padding_ms, 500);
  assert.equal(event.session.audio.input.turn_detection.silence_duration_ms, 1000);
  assert.equal(event.session.audio.input.turn_detection.create_response, false);
  assert.equal(event.session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(event.session.max_output_tokens, 800);
  assert.equal(event.session.truncation.token_limits.post_instructions, 2_500);
  assert.equal(event.session.truncation.retention_ratio, 0.7);
  assert.deepEqual(
    event.session.tools.map((tool) => tool.name),
    ['prepare_estimate_summary', 'submit_estimate_request'],
  );
  assert.equal(ESTIMATE_TOOLS[0].parameters.additionalProperties, false);
  assert.equal(ESTIMATE_TOOLS[0].parameters.required.includes('address_confirmed'), false);
  assert.ok(ESTIMATE_TOOLS[0].parameters.required.includes('additional_notes_asked'));
  assert.ok(ESTIMATE_TOOLS[0].parameters.required.includes('consent_asked_separately'));
  assert.match(
    ESTIMATE_TOOLS[0].parameters.properties.service.description,
    /painting a shed out back maps to Exterior Painting/i,
  );
  assert.match(
    ESTIMATE_TOOLS[0].parameters.properties.additional_notes.description,
    /unanswered caller questions/i,
  );
  assert.match(
    ESTIMATE_TOOLS[1].description,
    /I'm submitting your estimate request now\./,
  );
  assert.doesNotMatch(ESTIMATE_TOOLS[1].description, /Okay, I'm submitting it now/);
  assert.equal(END_CALL_TOOL.parameters.additionalProperties, false);
  assert.match(END_CALL_TOOL.description, /without speaking a preamble/i);
});

test('post-submission instructions do not reopen the conversation', () => {
  const event = buildSessionUpdate(CONTEXT, { submitted: true });
  assert.deepEqual(event.session.tools.map((tool) => tool.name), ['end_call']);
  assert.match(event.session.instructions, /Do not ask the caller any more questions/i);
  assert.match(event.session.instructions, /Do not collect, prepare, edit, restart, or submit/i);
  assert.match(event.session.instructions, /server will immediately produce the final goodbye/i);
  assert.doesNotMatch(event.session.instructions, /anything else I can help with/i);
});

test('prompt keeps the lead-first estimate flow, question fallbacks, consent, and prior safeguards', () => {
  const prompt = buildReceptionistInstructions(CONTEXT);
  assert.match(prompt, /A yes to contact permission is not a yes to submit/);
  assert.match(prompt, /Use only the returned summary values/);
  assert.match(prompt, /relative date such as "Tuesday,"/);
  assert.match(prompt, /256 output tokens as your normal response ceiling/);
  assert.match(prompt, /What date and time would work best for the estimate/);
  assert.match(prompt, /What service were you looking for/);
  assert.doesNotMatch(prompt, /Would you like to fill out an estimate request/);
  assert.match(prompt, /not a form being read aloud/i);
  assert.match(prompt, /Okay.*Great.*Got it/i);
  assert.match(prompt, /Do not force one onto every turn/i);
  assert.match(prompt, /Do not treat phrases such as "let's move on"/i);
  assert.match(prompt, /shed painted out back.*Exterior Painting/i);
  assert.match(prompt, /Infer obvious matches silently/i);
  assert.match(prompt, /2 in the afternoon.*2:00 PM/i);
  assert.match(prompt, /Never ask AM or PM when the caller has already supplied a clear daypart/i);
  assert.match(prompt, /ask exactly one question per turn/i);
  assert.match(prompt, /short acknowledgments such as "okay,"/i);
  assert.match(prompt, /Do not restart, repeat, or rephrase your question/i);
  assert.match(prompt, /do not repeat any part of it/i);
  assert.match(prompt, /do not say "I have your address as,"/i);
  assert.doesNotMatch(prompt, /required address confirmation/i);
  assert.match(prompt, /9:00 AM through 4:00 PM/);
  assert.match(prompt, /give exactly one spoken correction/i);
  assert.match(prompt, /do not announce that it is inside the window/i);
  assert.match(prompt, /Do not mention or restate contact consent/i);
  assert.match(prompt, /Do you have any notes for the project or any questions about the business/i);
  assert.match(prompt, /I may be able to answer some, and if not, I'll add them to the notes/i);
  assert.match(prompt, /The price depends on the estimate\./i);
  assert.match(prompt, /longest it will take is a week to accept or decline your estimate request/i);
  assert.match(prompt, /I'm sorry, I don't really know that\. I'll add it to the notes\./i);
  assert.match(prompt, /Preserve that unanswered question in additional_notes/i);
  assert.match(prompt, /Never give out, confirm, read back, or reveal the business's private phone number or email address/i);
  assert.match(prompt, /Never narrate your thinking or planning/i);
  assert.match(prompt, /Greet the caller only once/i);
  assert.match(prompt, /use only their first name/i);
  assert.match(prompt, /Never speak their surname or full name back except during the final summary/i);
  assert.match(prompt, /Do not say labels such as "Name:"/i);
  assert.match(prompt, /Does that all sound right/);
  assert.match(prompt, /I'm submitting your estimate request now\./);
  assert.match(prompt, /claim success before the tool returns/i);
  assert.match(prompt, /Do not ask whether they need anything else/i);
  assert.doesNotMatch(prompt, /Okay, I'm submitting it now/);
  assert.match(prompt, /Do not volunteer that you are AI/i);
  assert.match(prompt, /Never mention ARK, OpenAI, Railway, Telnyx/i);
  assert.doesNotMatch(prompt, /Alex/);
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

test('runs prepare, submits once, then automatically says goodbye and requests hangup', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const deliveries = [];
  const transcripts = [];
  let submittedSnapshot = null;
  let goodbyeCompletions = 0;

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-123',
      callerPhone: '+15555550123',
      deliver: async (payload, options) => {
        deliveries.push({ payload, options });
        return { ok: true };
      },
      onAudio: () => {},
      onClear: () => {},
      onSubmitted: (snapshot) => { submittedSnapshot = snapshot; },
      onReady: () => {},
      onTranscript: (entry) => { transcripts.push(entry); },
      onGoodbyeComplete: () => { goodbyeCompletions += 1; },
      onError: (error) => assert.fail(error.message),
      WebSocketClass: FakeWebSocket,
    });

    await nextTurn();
    const socket = FakeWebSocket.instance;
    assert.equal(socket.sent[0].type, 'session.update');
    assert.equal(socket.sent[0].session.tools.length, 2);

    socket.receive({ type: 'session.updated', session: {} });
    const greetingRequest = socket.sent.find((event) => event.type === 'response.create');
    assert.match(
      greetingRequest.response.instructions,
      /Hi, thank you for calling Tabor Painting\. What service were you looking for\?/,
    );
    assert.match(greetingRequest.response.instructions, /Do not add anything before or after it/);

    socket.receive({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call',
          name: 'prepare_estimate_summary',
          call_id: 'prepare-call',
          arguments: JSON.stringify({
            service: 'Interior Painting',
            name: 'Jordan Smith',
            address: '123 Main Street, Albany, NY 12207',
            preferred_date: '2099-08-12',
            preferred_time: '3:30 PM',
            additional_notes: '',
            additional_notes_asked: true,
            consent_to_contact: true,
            consent_asked_separately: true,
          }),
        }],
      },
    });
    await nextTurn();

    const prepareOutput = socket.sent.find(
      (event) => event.type === 'conversation.item.create'
        && event.item.call_id === 'prepare-call',
    );
    const prepareResult = JSON.parse(prepareOutput.item.output);
    assert.equal(prepareResult.status, 'ready_for_confirmation');
    assert.deepEqual(Object.keys(prepareResult.summary), [
      'name',
      'service',
      'address',
      'preferredDateAndTime',
      'notes',
    ]);
    assert.equal('consentToContact' in prepareResult.summary, false);
    assert.equal(deliveries.length, 0);
    const prepareResponse = socket.sent.filter((event) => event.type === 'response.create').at(-1);
    assert.match(prepareResponse.response.instructions, /conversational readback/i);
    assert.match(prepareResponse.response.instructions, /Does that all sound right/);
    assert.match(prepareResponse.response.instructions, /Do not use field labels/i);

    socket.receive({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call',
          name: 'submit_estimate_request',
          call_id: 'submit-call',
          arguments: JSON.stringify({ caller_confirmed: true }),
        }],
      },
    });
    await nextTurn();

    assert.equal(deliveries.length, 1);
    assert.equal(submittedSnapshot.phase, 'submitted');
    const submitOutput = socket.sent.find(
      (event) => event.type === 'conversation.item.create'
        && event.item.call_id === 'submit-call',
    );
    const submitResult = JSON.parse(submitOutput.item.output);
    assert.equal(
      submitResult.response_text,
      "You're all set. Your estimate request has been submitted.",
    );
    assert.equal(submitResult.require_repeat_verbatim, true);
    const postSubmissionResponse = socket.sent
      .filter((event) => event.type === 'response.create')
      .at(-1);
    assert.match(postSubmissionResponse.response.instructions, /Say exactly/);
    assert.match(postSubmissionResponse.response.instructions, /Your estimate request has been submitted\./);
    assert.doesNotMatch(postSubmissionResponse.response.instructions, /anything else I can help with/i);
    const postSubmissionUpdate = socket.sent
      .filter((event) => event.type === 'session.update')
      .at(-1);
    assert.deepEqual(postSubmissionUpdate.session.tools.map((tool) => tool.name), ['end_call']);
    assert.match(postSubmissionUpdate.session.instructions, /Do not ask the caller any more questions/i);
    assert.equal(receptionist.snapshot().submitted, true);

    socket.receive({ type: 'response.created', response: { id: 'submission-success-response' } });
    socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'submission-success-response',
      item_id: 'submission-success-item',
      transcript: "You're all set. Your estimate request has been submitted.",
    });
    socket.receive({
      type: 'response.done',
      response: { id: 'submission-success-response', output: [] },
    });

    assert.equal(receptionist.snapshot().endingCall, true);
    const goodbyeRequest = socket.sent.filter((event) => event.type === 'response.create').at(-1);
    assert.match(goodbyeRequest.response.instructions, /Thanks for calling Tabor Painting\. Have a good day\./);
    assert.doesNotMatch(goodbyeRequest.response.instructions, /Have a good day\. Goodbye/);

    socket.receive({ type: 'response.created', response: { id: 'goodbye-response' } });
    socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'goodbye-response',
      item_id: 'goodbye-item',
      transcript: 'Thanks for calling Tabor Painting. Have a good day.',
    });
    socket.receive({
      type: 'response.done',
      response: { id: 'goodbye-response', output: [] },
    });

    assert.equal(goodbyeCompletions, 1);
    assert.deepEqual(transcripts.map(({ speaker, text }) => ({ speaker, text })), [
      {
        speaker: 'receptionist',
        text: "You're all set. Your estimate request has been submitted.",
      },
      {
        speaker: 'receptionist',
        text: 'Thanks for calling Tabor Painting. Have a good day.',
      },
    ]);
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test('signals the server when the per-call response ceiling is exceeded', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousLimit = process.env.OPENAI_MAX_RESPONSES_PER_CALL;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MAX_RESPONSES_PER_CALL = '10';
  let limitEvent = null;

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-response-limit',
      callerPhone: '+15555550123',
      deliver: async () => ({ ok: true }),
      onAudio: () => {},
      onClear: () => {},
      onSubmitted: () => {},
      onReady: () => {},
      onCostLimit: (event) => { limitEvent = event; },
      onError: (error) => assert.fail(error.message),
      WebSocketClass: FakeWebSocket,
    });
    await nextTurn();

    const socket = FakeWebSocket.instance;
    socket.receive({ type: 'session.updated', session: {} });
    for (let count = 0; count < 10; count += 1) {
      socket.receive({ type: 'response.created', response: { id: `response-${count}` } });
    }

    assert.equal(limitEvent.reason, 'response-limit');
    assert.equal(limitEvent.maximumResponses, 10);
    assert.equal(receptionist.snapshot().responseCount, 10);
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousLimit === undefined) delete process.env.OPENAI_MAX_RESPONSES_PER_CALL;
    else process.env.OPENAI_MAX_RESPONSES_PER_CALL = previousLimit;
  }
});

test('does not clear receptionist audio when the caller backchannels', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let clearCount = 0;

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-backchannel',
      callerPhone: '+15555550123',
      deliver: async () => ({ ok: true }),
      onAudio: () => {},
      onClear: () => { clearCount += 1; },
      onSubmitted: () => {},
      onReady: () => {},
      onError: (error) => assert.fail(error.message),
      WebSocketClass: FakeWebSocket,
    });
    await nextTurn();

    const socket = FakeWebSocket.instance;
    socket.receive({ type: 'session.updated', session: {} });
    socket.receive({ type: 'input_audio_buffer.speech_started' });

    assert.equal(clearCount, 0);
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test('requests caller responses manually after transcription instead of through VAD', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-manual-response',
      callerPhone: '+15555550123',
      deliver: async () => ({ ok: true }),
      onAudio: () => {},
      onClear: () => {},
      onSubmitted: () => {},
      onReady: () => {},
      onError: (error) => assert.fail(error.message),
      WebSocketClass: FakeWebSocket,
    });
    await nextTurn();

    const socket = FakeWebSocket.instance;
    socket.receive({ type: 'session.updated', session: {} });
    const beforeCaller = socket.sent.filter((event) => event.type === 'response.create').length;
    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'manual-caller-item',
      transcript: 'I need exterior painting.',
    });

    const requests = socket.sent.filter((event) => event.type === 'response.create');
    assert.equal(requests.length, beforeCaller + 1);
    assert.deepEqual(requests.at(-1), {
      type: 'response.create',
      response: { output_modalities: ['audio'] },
    });
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
