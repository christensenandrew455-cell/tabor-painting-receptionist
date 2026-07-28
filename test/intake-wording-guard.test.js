import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIntakeWordingSessionRules,
  augmentCallStateText,
  rewritePrimaryIntakeQuestions,
  rewriteSilenceReaskMessage,
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
Last question ID: project_location
Last question: What is the project address?
Current field: projectLocation`);
  assert.match(locationState, /"Nice to meet you" is forbidden on this turn/i);
  assert.match(locationState, /do not use the caller’s name in an acknowledgment/i);
});

test('supplies one simplified retry for grouped location and scheduling fields', () => {
  const locationState = augmentCallStateText(`CURRENT CALL STATE
Stage: INTAKE
Last question ID: project_location
Last question: What is the project address?
Current field: projectLocation`);
  assert.match(locationState, /I'm sorry, I didn't get that\. What is the project address\?/i);
  assert.match(locationState, /street number, street name, city or town, and state/i);
  assert.match(locationState, /Ask only for a missing part after evaluating the complete answer/i);

  const scheduleState = augmentCallStateText(`CURRENT CALL STATE
Stage: INTAKE
Last question ID: estimate_schedule
Last question: What day works best for you, and what time?
Current field: preferredSchedule`);
  assert.match(scheduleState, /What day works best for you, and what time\?/i);
  assert.match(scheduleState, /supplying both a day or date and a time/i);
  assert.match(scheduleState, /The date and time you requested is a request\. The business might ask to reschedule\./i);
  assert.match(scheduleState, /Do not ask a separate date-confirmation question/i);
  assert.doesNotMatch(scheduleState, /Just to make sure/i);
});

test('supplies one concise retry for the service field', () => {
  const serviceState = augmentCallStateText(`CURRENT CALL STATE
Stage: INTAKE
Last question ID: service_type
Last question: What service are you looking for? We specialize in interior painting or exterior painting.
Current field: serviceType`);
  assert.match(serviceState, /I'm sorry, I didn't get that\. What service were you looking for\?/i);
  assert.match(serviceState, /Never repeat the same question/i);
  assert.doesNotMatch(serviceState, /I'm sorry, I didn't get that[\s\S]*We specialize/i);
});

test('rewrites the first address and schedule questions without duplicating scheduling', () => {
  const result = rewritePrimaryIntakeQuestions(
    '- Business name: Tabor Painting\n'
    + 'What is the project address? Please give me the city or town, state, street number, and street name.\n'
    + 'Next, what exact date or upcoming day and time works best for the estimate? We offer estimates Monday through Friday from 8:00 AM through 5:00 PM.',
  );

  assert.match(result, /street number, street name, city or town, and state/i);
  assert.doesNotMatch(result, /city or town, state, street number, and street name/i);
  assert.match(
    result,
    /What day works best for you, and what time\? We schedule estimates Monday through Friday from 8:00 AM to 5:00 PM\./i,
  );
  assert.equal((result.match(/What day works best for you, and what time\?/gi) || []).length, 1);
  assert.doesNotMatch(result, /exact date or upcoming day/i);
});

test('removes a second scheduling question when old rewritten wording is present', () => {
  const result = rewritePrimaryIntakeQuestions(
    '- Business name: Tabor Painting\n'
    + 'What day works best for you, and what time? We schedule estimates Monday through Friday from 8:00 AM to 5:00 PM. What day and time works best for you?',
  );
  assert.equal((result.match(/What day works best for you, and what time\?/gi) || []).length, 1);
  assert.doesNotMatch(result, /What day and time works best for you\?/i);
});

test('session rules preserve service classification and use the request disclaimer without date confirmation', () => {
  const result = applyIntakeWordingSessionRules({
    type: 'session.update',
    session: {
      instructions: `NATURAL ESTIMATE INTAKE
Ask: "What is the project address? Please give me the city or town, state, street number, and street name."
Ask: "Next, what exact date or upcoming day and time works best for the estimate? We offer estimates Monday through Friday from 8:00 AM through 5:00 PM."

RESPONSIVE ACKNOWLEDGMENTS
After a usable answer, you may say Nice to meet you, [first name].

RESTRICTED OUTPUT
Only approved output.

- Business name: Tabor Painting`,
    },
  });
  assert.match(result.session.instructions, /Immediately after a valid full name only/i);
  assert.match(result.session.instructions, /first service question must include the complete configured service list/i);
  assert.match(result.session.instructions, /identify the best matching configured service/i);
  assert.match(result.session.instructions, /street number, street name, city or town, and state/i);
  assert.match(
    result.session.instructions,
    /What day works best for you, and what time\? We schedule estimates Monday through Friday from 8:00 AM to 5:00 PM\./i,
  );
  assert.match(result.session.instructions, /The date and time you requested is a request\. Tabor Painting might ask to reschedule\./i);
  assert.match(result.session.instructions, /Do not ask a separate date-confirmation question/i);
  assert.doesNotMatch(result.session.instructions, /Just to make sure/i);
  assert.match(result.session.instructions, /There is no separate latency cue or secondary voice/i);
  assert.match(result.session.instructions, /While waiting, say nothing/i);
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

test('silence schedule retry uses the short day-and-time wording', () => {
  const result = rewriteSilenceReaskMessage({
    type: 'response.create',
    response: {
      instructions: `Say exactly this and nothing else: "I'm sorry, I didn't get that. What exact date or upcoming day and time works best for the estimate?" Then stop and wait. Do not add reassurance, filler, or the next intake question.`,
    },
  });
  assert.doesNotMatch(result.response.instructions, /exact date or upcoming day/i);
  assert.match(result.response.instructions, /What day works best for you, and what time\?/i);
});