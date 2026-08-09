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
  assert.equal(event.session.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(event.session.audio.input.turn_detection.eagerness, 'low');
  assert.equal(event.session.audio.input.turn_detection.create_response, false);
  assert.equal(event.session.audio.input.turn_detection.interrupt_response, false);
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
    /service from the supplied business service list/i,
  );
  assert.doesNotMatch(
    ESTIMATE_TOOLS[0].parameters.properties.service.description,
    /painting|plumbing|roofing|landscaping/i,
  );
  assert.match(
    ESTIMATE_TOOLS[0].parameters.properties.additional_notes.description,
    /unanswered caller questions/i,
  );
  assert.match(
    ESTIMATE_TOOLS[1].description,
    /Okay, thanks for confirming\. I'm sending the estimate request in now\./,
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
  assert.match(event.session.instructions, /server will produce the final goodbye/i);
  assert.doesNotMatch(event.session.instructions, /anything else I can help with/i);
});

test('prompt defines one universal intake flow and a clear knowledge boundary', () => {
  const prompt = buildReceptionistInstructions(CONTEXT);
  assert.match(prompt, /service -> name -> address -> schedule -> notes -> consent/i);
  assert.match(prompt, /Keep exactly one pending field/i);
  assert.match(prompt, /Once a field is answered, lock it/i);
  assert.match(prompt, /Never jump ahead, bounce backward, or reopen a completed field/i);

  assert.match(prompt, /What kind of work do you need done\?/);
  assert.doesNotMatch(prompt, /What service were you looking for/i);
  assert.match(prompt, /What name should I use for the estimate request\?/);
  assert.match(prompt, /What's the full project address\?/);
  assert.doesNotMatch(prompt, /What's the complete project address\?/);
  assert.match(prompt, /What day or date would you prefer for the estimate, and what time works best\?/);
  assert.match(prompt, /Do you have any notes or questions for the business\?/);

  assert.match(prompt, /ordinary language understanding/i);
  assert.match(prompt, /recognizing likely names, addresses/i);
  assert.match(prompt, /Never use a hardcoded trade-specific mapping/i);
  assert.match(prompt, /business information supplied for this call/i);
  assert.match(prompt, /Do not use general knowledge to answer factual or advisory questions/i);
  assert.match(prompt, /Never substitute a hardcoded fallback claim/i);
  assert.doesNotMatch(prompt, /The price depends on the estimate/i);
  assert.doesNotMatch(prompt, /longest it will take is a week/i);

  assert.match(prompt, /standalone backchannel.*does not answer an open question/is);
  assert.match(prompt, /same spoken response must contain the one actual next required question/i);
  assert.match(prompt, /Never narrate thinking, planning/i);
  assert.match(prompt, /conversation repair.*never a business question and never a project note/is);
  assert.match(prompt, /Continue to contact permission only after the caller explicitly says/i);

  assert.match(prompt, /A yes to contact permission is not a yes to submit/i);
  assert.match(prompt, /Use only the returned summary values/i);
  assert.match(prompt, /Does that all sound right/);
  assert.match(prompt, /Okay, thanks for confirming\. I'm sending the estimate request in now\./);
  assert.match(prompt, /claim success before the tool returns/i);
  assert.match(prompt, /Do not offer more help/i);

  assert.match(prompt, /Never mention ARK, OpenAI, Railway, Telnyx/i);
  assert.match(prompt, /Never reveal or confirm private business phone numbers or email addresses/i);
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
      /Hi, thank you for calling Tabor Painting\. What kind of work do you need done\?/,
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
    assert.match(goodbyeRequest.response.instructions, /Thank you for calling Tabor Painting\. Have a good day\./);
    assert.doesNotMatch(goodbyeRequest.response.instructions, /Have a good day\. Goodbye/);

    socket.receive({ type: 'response.created', response: { id: 'goodbye-response' } });
    socket.receive({
      type: 'response.output_audio_transcript.done',
      response_id: 'goodbye-response',
      item_id: 'goodbye-item',
      transcript: 'Thank you for calling Tabor Painting. Have a good day.',
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
        text: 'Thank you for calling Tabor Painting. Have a good day.',
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
    socket.receive({ type: 'response.created', response: { id: 'manual-greeting' } });
    socket.receive({
      type: 'response.done',
      response: { id: 'manual-greeting', output: [] },
    });
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

test('queues an overlapping caller turn until the receptionist finishes speaking', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const receptionist = createOpenAiReceptionist({
      context: CONTEXT,
      runtime: { clientId: 'client-123' },
      callControlId: 'call-overlap-queue',
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
    socket.receive({ type: 'response.created', response: { id: 'active-greeting' } });
    const beforeCaller = socket.sent.filter((event) => event.type === 'response.create').length;

    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'caller-overlap-answer',
      transcript: 'I need my roof repaired.',
    });
    assert.equal(
      socket.sent.filter((event) => event.type === 'response.create').length,
      beforeCaller,
    );

    socket.receive({
      type: 'response.done',
      response: { id: 'active-greeting', output: [] },
    });
    assert.equal(
      socket.sent.filter((event) => event.type === 'response.create').length,
      beforeCaller + 1,
    );
    receptionist.close();
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
