import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_FIELD_ORDER,
  callerVolunteeredName,
  classifyCallerTranscript,
  fullAddressFromCallerHistory,
  fullAddressFromCallerText,
  hasUsableNameAnswer,
  hasUsableServiceAnswer,
  isAiIdentityQuestion,
  isClearAffirmative,
  isClearNegative,
  isExplicitCorrectionRequest,
  isHoldRequest,
  isHoldResume,
  looksLikeBusinessQuestion,
  looksLikeUnfinishedThought,
  requestedFieldExplanation,
} from '../receptionist-policy.js';

const HVAC_CONTEXT = Object.freeze({
  services: [
    { name: 'Air Conditioning Repair', description: 'Cooling system diagnostics and repair' },
    { name: 'Heating Repair', description: 'Furnace and heating system repair' },
  ],
});

test('uses one canonical field order for every business', () => {
  assert.deepEqual(INTAKE_FIELD_ORDER, [
    'service',
    'name',
    'address',
    'schedule',
    'notes',
    'consent',
  ]);
});

test('accepts substantive service descriptions without hardcoding one trade', () => {
  const descriptions = [
    'My kitchen sink is leaking under the cabinet.',
    'I need the roof replaced.',
    'The air conditioner stopped cooling.',
    'Two outlets are not working.',
    'The driveway has several cracks.',
    'I need a tree trimmed away from the house.',
    'A couple of rooms need work.',
    'My car has a dented passenger door that needs body work.',
    'I need a damaged stair railing rebuilt.',
  ];
  for (const description of descriptions) {
    assert.equal(hasUsableServiceAnswer(description), true, description);
  }
});

test('reactions, greetings, and non-answers cannot complete the service field', () => {
  for (const value of ['Oh.', 'Okay.', 'Hey.', 'Hi there.', 'Yes.', "I don't know.", 'Not sure.', 'My name is Jordan.']) {
    assert.equal(hasUsableServiceAnswer(value), false, value);
  }
  assert.equal(classifyCallerTranscript('Oh.'), 'filler');
});

test('recognizes a complete spoken project address without relying on model extraction', () => {
  assert.equal(
    fullAddressFromCallerText('I just said, 197 Lancaster Road, Berlin, Massachusetts.'),
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(
    fullAddressFromCallerText(
      '197 Lancaster Road in Berlin, Massachusetts. It is the big blue house.',
    ),
    '197 Lancaster Road in Berlin, Massachusetts',
  );
  assert.equal(
    fullAddressFromCallerText('123 Georgia Avenue, Washington, DC.'),
    '123 Georgia Avenue, Washington, DC',
  );
  assert.equal(
    fullAddressFromCallerText(
      '197 Lancaster Road, Berlin, Massachusetts. The owner currently lives in New York.',
    ),
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(fullAddressFromCallerText('197 Lancaster Road.'), '');
});

test('reconstructs split addresses from caller turns without keeping a bad transcription', () => {
  assert.equal(
    fullAddressFromCallerHistory([
      "That'd be 197 Lancaster Road.",
      'Brown University.',
      'Berlin, Massachusetts.',
    ]),
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(
    fullAddressFromCallerHistory([
      '197 Lancaster Road.',
      'Berlin',
      'Massachusetts',
    ]),
    '197 Lancaster Road, Berlin, Massachusetts',
  );
  assert.equal(
    fullAddressFromCallerHistory(['197 Lancaster Road.', 'Brown University.']),
    '',
  );
  assert.equal(
    fullAddressFromCallerHistory([
      '197 Lancaster Road, Berlin, Massachusetts.',
      'No, change the address to 25 Oak Avenue.',
      'Hudson, Massachusetts.',
    ]),
    '25 Oak Avenue, Hudson, Massachusetts',
  );
});

test('recognizes trailing question fragments as unfinished thoughts', () => {
  for (const value of [
    'I was wondering if you guys...',
    'I was wondering if you guys could...',
    'Could you',
  ]) {
    assert.equal(looksLikeUnfinishedThought(value), true, value);
  }
  assert.equal(looksLikeUnfinishedThought('I was wondering if you are open on Saturdays.'), false);
});

test('recognizes naturally framed and repeated business questions', () => {
  for (const value of [
    'Yeah, um, I was just wondering, like, how long will it take for the job to get done?',
    'Yeah um I was just wondering like how long will it take for the job to get done',
    'I just asked how long will it take for the job to get done.',
    'My question was how long will the job take.',
  ]) {
    assert.equal(looksLikeBusinessQuestion(value), true, value);
  }
});

test('recognizes natural names while rejecting project descriptions as names', () => {
  for (const value of [
    'Jordan Smith.',
    'María de la Cruz.',
    "My name is D'Andre Williams.",
    'You can use Anne-Marie Smith.',
    'Jordan Smith works well.',
  ]) {
    assert.equal(hasUsableNameAnswer(value, HVAC_CONTEXT), true, value);
  }

  for (const value of [
    'The air conditioner stopped cooling.',
    'Air Conditioning Repair.',
    'I need the roof replaced.',
    'Mowing lawns.',
    'Replacing a broken gate.',
    '123 Main Street.',
    'Wednesday at 3 PM.',
    'Okay.',
  ]) {
    assert.equal(hasUsableNameAnswer(value, HVAC_CONTEXT), false, value);
  }
});

test('recognizes introduced names without treating action phrases as names', () => {
  for (const value of [
    "I'm Jordan Smith.",
    'I am María de la Cruz.',
    "I'm Jordan, and I need a window fixed.",
  ]) {
    assert.equal(callerVolunteeredName(value), true, value);
  }

  for (const value of [
    "I'm mowing the lawn.",
    'I am replacing a gate.',
    'I am looking for an estimate.',
    'I am not sure.',
  ]) {
    assert.equal(callerVolunteeredName(value), false, value);
  }
});

test('recognizes hold requests without swallowing an answer that follows one', () => {
  for (const value of [
    'Wait.',
    'Wait one second, hold on.',
    'Hold on one second.',
    'Hang on a minute.',
    'Give me a moment.',
    'Just give me like a second.',
    'Can you wait a second?',
    'Let me check.',
  ]) {
    assert.equal(isHoldRequest(value), true, value);
  }
  assert.equal(isHoldRequest('Wait—my name is Jordan Smith.'), false);
  assert.equal(isHoldRequest('Wait, use Tuesday at 2 instead.'), false);
});

test('recognizes a standalone return from hold without swallowing the answer itself', () => {
  for (const value of ["I'm back.", 'Okay, ready.', 'Ready now.', 'Go ahead.']) {
    assert.equal(isHoldResume(value), true, value);
  }
  assert.equal(isHoldResume("I'm back, my name is Jordan Smith."), false);
});

test('recognizes explicit corrections without treating backchannels as corrections', () => {
  for (const value of [
    'Wait, scratch that. Make it Tuesday at 2.',
    'Actually, I meant Wednesday.',
    'No, let me correct that address.',
  ]) {
    assert.equal(isExplicitCorrectionRequest(value), true, value);
  }
  for (const value of [
    'Okay.',
    'Yeah.',
    'Yep.',
    'Got it.',
    'The wall is damaged, you know what I mean?',
  ]) {
    assert.equal(isExplicitCorrectionRequest(value), false, value);
  }
});

test('recognizes a clear no even when transcription chooses another common language', () => {
  for (const value of ['No.', 'Não.', 'Nao.', 'Nie.', 'Non.', 'Nein.']) {
    assert.equal(isClearNegative(value), true, value);
  }
});

test('recognizes yes and no after natural conversational fillers', () => {
  assert.equal(isClearAffirmative('Uh, yeah.'), true);
  assert.equal(isClearAffirmative('Okay, yes.'), true);
  assert.equal(isClearNegative("Actually, no, I don't."), true);
  assert.equal(isClearNegative('Well, no more notes.'), true);
});

test('recognizes AI identity questions and field-reason questions', () => {
  for (const value of ['Are you an AI?', 'Are you a bot?', 'Is this a real person?']) {
    assert.equal(isAiIdentityQuestion(value), true, value);
  }
  assert.equal(requestedFieldExplanation('Why do you need to know the service?', 'service'), 'service');
  assert.equal(requestedFieldExplanation('Why do you need my name?', 'name'), 'name');
  assert.equal(requestedFieldExplanation('What do you need my address for?', 'address'), 'address');
  assert.equal(requestedFieldExplanation('Why do you need the date and time?', 'schedule'), 'schedule');
  assert.equal(requestedFieldExplanation('Why do you need my consent?', 'consent'), 'consent');
  assert.equal(requestedFieldExplanation('Why?', 'notes'), 'notes');
  assert.equal(requestedFieldExplanation('Why are you closed on Sunday?', 'service'), '');
});
