import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIntakeWordingSessionRules,
  augmentCallStateText,
  rewriteSilenceReaskMessage,
  rewriteThinkingCueRequest,
} from '../intake-wording-guard.js';

test('allows nice-to-meet-you wording only on the full-name turn', () => {
  const nameState = augmentCallStateText(`CURRENT CALL STATE
Stage: INTAKE
Last question ID: full_name
Last question: What is your first and last name?
Current field: fullName`);
  assert.match(nameState, /allowed once only when the newest caller response provides a valid first and last name/i);
  assert.match(nameState, /ask the service question once/i);

  const locationState = augmentCallStateText(`CURRENT CALL STATE
Stage: INTAKE
Last question ID: city_or_town
Last question: What city or town is the project in?
Current field: cityOrTown`);
  assert.match(locationState, /"Nice to meet you" is forbidden on this turn/i);
  assert.match(locationState, /do not use the caller’s name in an acknowledgment/i);
});

test('supplies one simplified retry for the current field', () => {
  const serviceState = augmentCallStateText(`CURRENT CALL STATE
Stage: INTAKE
Last question ID: service_type
Last question: What service are you looking for? We specialize in interior painting or exterior painting.
Current field: serviceType`);
  assert.match(serviceState, /I'm sorry, I didn't get that\. What service were you looking for\?/i);
  assert.match(serviceState, /Never repeat the same question/i);
  assert.doesNotMatch(serviceState, /I'm sorry, I didn't get that[\s\S]*We specialize/i);
});

test('replaces broad acknowledgment permission in the session prompt', () => {
  const result = applyIntakeWordingSessionRules({
    type: 'session.update',
    session: {
      instructions: `RESPONSIVE ACKNOWLEDGMENTS
After a usable answer, you may say Nice to meet you, [first name].

RESTRICTED OUTPUT
Only approved output.`,
    },
  });
  assert.match(result.session.instructions, /Immediately after a valid full name only/i);
  assert.match(result.session.instructions, /It is forbidden after service, location, date, time, notes, consent/i);
  assert.match(result.session.instructions, /Ask each question only once per response/i);
});

test('normal silence re-asks do not pretend an answer was misunderstood', () => {
  const result = rewriteSilenceReaskMessage({
    type: 'response.create',
    response: {
      instructions: `Say exactly this and nothing else: "I'm sorry, I didn't get that. What service do you need?" Then stop and wait. Do not add reassurance, filler, or the next intake question.`,
    },
  });
  assert.doesNotMatch(result.response.instructions, /I'm sorry, I didn't get that/i);
  assert.match(result.response.instructions, /What service were you looking for\?/i);
});

test('keeps every separate latency cue as plain speech text with no markup', () => {
  const premium = rewriteThinkingCueRequest({
    command_id: 'thinking-cue-1-1',
    payload: 'Okay...',
    payload_type: 'text',
    service_level: 'premium',
  });
  assert.equal(premium.payload_type, 'text');
  assert.equal(premium.payload, 'Mm-hm.');
  assert.doesNotMatch(premium.payload, /Okay|<|>|prosody|speak/i);

  const basic = rewriteThinkingCueRequest({
    command_id: 'thinking-cue-1-2',
    payload: 'Okay...',
    payload_type: 'text',
    service_level: 'basic',
  });
  assert.equal(basic.payload_type, 'text');
  assert.equal(basic.payload, 'Mm-hm.');
});
