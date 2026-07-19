import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  BUSINESS,
  REALTIME_MODEL,
  REALTIME_VOICE,
  SILENCE_DURATION_MS,
  SPEECH_SPEED,
  afterSaveQuestion,
  buildOcmPayload,
  getCallerPhone,
  instructions,
  normalizePreferredTime,
  openingLine,
  receptionistScript,
  resolvePreferredDate,
  tools,
  validateLead,
} from '../receptionist-core.js';

function completeLead(overrides = {}) {
  return {
    fullName: 'Taylor Morgan',
    email: 'taylor@example.com',
    serviceType: 'interior painting',
    townOrCity: 'Example City',
    streetAddress: '12 Main Street',
    contactMethod: 'text',
    preferredDay: 'Tuesday',
    preferredTime: '4:30 PM',
    additionalNotes: 'Please call before arriving',
    ...overrides,
  };
}

function completeRuntimeEnv(overrides = {}) {
  return {
    ...process.env,
    AI_MODEL: 'gpt-realtime-mini',
    AI_SILENCE_MS: '1200',
    AI_SPEECH_SPEED: '0.94',
    AI_VOICE: 'alloy',
    BUSINESS_INFO: process.env.BUSINESS_INFO,
    OCM_CLIENT_ID: 'example-painting',
    OCM_CONNECTION_KEY: 'test-connection-value',
    OPENAI_API_KEY: 'test-openai-value',
    PUBLIC_URL: 'https://example-receptionist.example.com',
    RECEPTIONIST_SCRIPT: process.env.RECEPTIONIST_SCRIPT,
    TELNYX_API_KEY: 'test-telnyx-value',
    ...overrides,
  };
}

test('reads business, script, model, voice, speed, and silence only from variables', () => {
  assert.equal(BUSINESS.name, 'Example Painting');
  assert.equal(BUSINESS.receptionist, 'Alex');
  assert.match(openingLine, /Example Painting/);
  assert.match(afterSaveQuestion, /Example Painting/);
  assert.match(receptionistScript, /configured service they need/i);
  assert.equal(REALTIME_MODEL, 'gpt-realtime-mini');
  assert.equal(REALTIME_VOICE, 'alloy');
  assert.equal(SPEECH_SPEED, 0.94);
  assert.equal(SILENCE_DURATION_MS, 1200);
});

test('accepts times inside the configured estimate window', () => {
  assert.equal(normalizePreferredTime('9 am'), '9:00 AM');
  assert.equal(normalizePreferredTime('4:30 PM'), '4:30 PM');
  assert.equal(normalizePreferredTime('5:00 PM'), '');
});

test('allows callers to decline email unless email is their contact method', () => {
  const declined = validateLead(completeLead({ email: '', contactMethod: 'text' }));
  assert.equal(declined.valid, true);
  assert.equal(declined.lead.email, '');

  const emailContact = validateLead(completeLead({ email: '', contactMethod: 'email' }));
  assert.equal(emailContact.valid, false);
  assert.match(emailContact.errors.join(' '), /complete email address/i);
});

test('builds the OpenAI tool choices from BUSINESS_INFO services', () => {
  const submitTool = tools.find((tool) => tool.name === 'submit_estimate_lead');
  assert.ok(submitTool);
  assert.equal(submitTool.parameters.required.includes('email'), false);
  assert.deepEqual(submitTool.parameters.properties.serviceType.enum, [
    'interior painting',
    'exterior painting',
  ]);
});

test('resolves the requested weekday in the configured business timezone', () => {
  const friday = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(resolvePreferredDate('Monday', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('Friday', friday), '2026-07-17');
});

test('builds OCM payloads from OCM_CLIENT_ID and derives the source', () => {
  const result = validateLead(completeLead());
  assert.equal(result.valid, true);

  const payload = buildOcmPayload('+17745550123', result.lead);
  assert.equal(payload.clientId, 'example-painting');
  assert.equal(payload.source, 'example-painting-receptionist');
  assert.equal(payload.sectionKey, 'contactedMe');
  assert.equal(payload.Phone, '+17745550123');
  assert.equal(payload.Job, 'interior painting');
  assert.equal(payload.Address, '12 Main Street, Example City');
  assert.match(payload.Notes, /Please call before arriving/);
  assert.match(payload.EstimateDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('pulls the caller phone number from a Telnyx webhook', () => {
  assert.equal(
    getCallerPhone({ data: { payload: { from: '+17745550123' } } }),
    '+17745550123',
  );
});

test('keeps shared safety and save behavior hardcoded around the variable script', () => {
  const prompt = instructions();
  assert.match(prompt, /configured service they need/i);
  assert.match(prompt, /Never ask for, say, confirm, or repeat the caller’s phone number/i);
  assert.match(prompt, /give me one second to save that/i);
  assert.match(prompt, /Silence is mandatory/i);
  assert.match(prompt, /take your time[\s\S]*forbidden/i);
  assert.match(prompt, /standalone filler/i);
  assert.doesNotMatch(prompt, /Tabor Painting|Jason Beirne|Berlin, Massachusetts/i);
});

test('BUSINESS_INFO and RECEPTIONIST_SCRIPT fully rebrand a cloned receptionist', () => {
  const businessInfo = {
    name: 'Sample Roofing',
    receptionist: 'Morgan',
    owner: 'Casey Rivera',
    phone: '(555) 555-0100',
    email: 'hello@example.com',
    hours: 'Monday through Saturday, 7 AM to 6 PM',
    timeZone: 'America/Chicago',
    estimateDays: 'Tuesday through Saturday',
    estimateWeekdays: ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    earliestEstimateStart: '8:00 AM',
    latestEstimateStart: '5:00 PM',
    base: 'Austin, Texas',
    serviceAreas: ['Austin', 'Round Rock'],
    services: {
      'roof repair': 'Repairing leaks and damaged roofing.',
      'roof replacement': 'Replacing residential roofing systems.',
    },
    about: ['Sample Roofing serves residential customers.'],
    openingLine: 'Thanks for calling {{business_name}}. This is {{receptionist_name}}. Are you calling about an estimate?',
    closingLine: '{{owner_first_name}} will contact you soon. Goodbye.',
    extraInformation: 'Final pricing is provided after inspection.',
  };
  const customScript = 'Ask what roofing service they need. Use only {{services}}. The owner is {{owner_first_name}}.';
  const code = `
    const core = await import('./receptionist-core.js');
    console.log(JSON.stringify({
      business: core.BUSINESS,
      openingLine: core.openingLine,
      closingLine: core.closingLine,
      instructions: core.instructions(),
      model: core.REALTIME_MODEL,
      voice: core.REALTIME_VOICE,
      speed: core.SPEECH_SPEED,
      silence: core.SILENCE_DURATION_MS,
      services: core.tools[0].parameters.properties.serviceType.enum,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: completeRuntimeEnv({
      BUSINESS_INFO: JSON.stringify(businessInfo),
      RECEPTIONIST_SCRIPT: customScript,
      OCM_CLIENT_ID: 'sample-roofing',
      AI_MODEL: 'gpt-realtime',
      AI_VOICE: 'marin',
      AI_SPEECH_SPEED: '1.08',
      AI_SILENCE_MS: '900',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.business.name, 'Sample Roofing');
  assert.equal(output.business.timeZone, 'America/Chicago');
  assert.equal(output.openingLine, 'Thanks for calling Sample Roofing. This is Morgan. Are you calling about an estimate?');
  assert.equal(output.closingLine, 'Casey will contact you soon. Goodbye.');
  assert.match(output.instructions, /Ask what roofing service they need/i);
  assert.match(output.instructions, /roof repair, or roof replacement/i);
  assert.doesNotMatch(output.instructions, /Example Painting|Tabor Painting|Jason Beirne|Berlin, Massachusetts/i);
  assert.deepEqual(output.services, ['roof repair', 'roof replacement']);
  assert.equal(output.model, 'gpt-realtime');
  assert.equal(output.voice, 'marin');
  assert.equal(output.speed, 1.08);
  assert.equal(output.silence, 900);
});

test('the core refuses to start without RECEPTIONIST_SCRIPT', () => {
  const env = completeRuntimeEnv();
  delete env.RECEPTIONIST_SCRIPT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./receptionist-core.js')"], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECEPTIONIST_SCRIPT is required/i);
});

test('bootstrap requires the exact variable list, hardcodes the shared endpoint, and derives the source', () => {
  const code = `
    await import('./ocm-bootstrap.js');
    const url = new URL(process.env.OCM_WEBHOOK_URL);
    console.log(JSON.stringify({
      origin: url.origin,
      pathname: url.pathname,
      clientId: url.searchParams.get('clientId'),
      key: url.searchParams.get('key'),
      source: url.searchParams.get('source'),
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: completeRuntimeEnv({
      OCM_CLIENT_ID: 'sample-business',
      OCM_CONNECTION_KEY: 'private-test-value',
      OCM_WEBHOOK_URL: 'https://wrong.example.com/old',
      OCM_SOURCE: 'old-source',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  const output = JSON.parse(lines.at(-1));
  assert.equal(output.origin, 'https://ark-websites-ocm.vercel.app');
  assert.equal(output.pathname, '/api/intake');
  assert.equal(output.clientId, 'sample-business');
  assert.equal(output.key, 'private-test-value');
  assert.equal(output.source, 'sample-business-receptionist');
});
