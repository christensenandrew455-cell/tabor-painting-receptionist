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
  resolvePreferredDate,
  tools,
  validateLead,
} from '../receptionist-core.js';

function completeLead(overrides = {}) {
  return {
    fullName: 'Taylor Morgan',
    email: 'taylor@example.com',
    serviceType: 'interior painting',
    townOrCity: 'Berlin',
    streetAddress: '12 Main Street',
    contactMethod: 'text',
    preferredDay: 'Tuesday',
    preferredTime: '4:30 PM',
    additionalNotes: 'Please call before arriving',
    ...overrides,
  };
}

test('keeps the current Tabor behavior as the safe default', () => {
  assert.equal(BUSINESS.name, 'Tabor Painting');
  assert.equal(BUSINESS.receptionist, 'Alex');
  assert.match(openingLine, /Tabor Painting/);
  assert.match(afterSaveQuestion, /Tabor Painting/);
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

test('makes email optional in the OpenAI lead tool schema', () => {
  const submitTool = tools.find((tool) => tool.name === 'submit_estimate_lead');
  assert.ok(submitTool);
  assert.equal(submitTool.parameters.required.includes('email'), false);
  assert.match(submitTool.parameters.properties.email.description, /optional/i);
});

test('resolves the requested weekday in the business timezone', () => {
  const friday = new Date('2026-07-17T16:00:00.000Z');
  assert.equal(resolvePreferredDate('Monday', friday), '2026-07-20');
  assert.equal(resolvePreferredDate('Friday', friday), '2026-07-17');
});

test('builds OCM payloads from the client ID and derives the source', () => {
  const previousClientId = process.env.OCM_CLIENT_ID;
  const previousSource = process.env.OCM_SOURCE;
  process.env.OCM_CLIENT_ID = 'sample-business';
  process.env.OCM_SOURCE = 'this-old-variable-is-ignored';

  try {
    const result = validateLead(completeLead());
    assert.equal(result.valid, true);

    const payload = buildOcmPayload('+17745550123', result.lead);
    assert.equal(payload.clientId, 'sample-business');
    assert.equal(payload.source, 'sample-business-receptionist');
    assert.equal(payload.sectionKey, 'contactedMe');
    assert.equal(payload.Phone, '+17745550123');
    assert.equal(payload.Job, 'interior painting');
    assert.equal(payload.Address, '12 Main Street, Berlin');
    assert.match(payload.Notes, /Please call before arriving/);
    assert.match(payload.EstimateDate, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    if (previousClientId === undefined) delete process.env.OCM_CLIENT_ID;
    else process.env.OCM_CLIENT_ID = previousClientId;
    if (previousSource === undefined) delete process.env.OCM_SOURCE;
    else process.env.OCM_SOURCE = previousSource;
  }
});

test('pulls the caller phone number from a Telnyx webhook', () => {
  assert.equal(
    getCallerPhone({ data: { payload: { from: '+17745550123' } } }),
    '+17745550123',
  );
});

test('default instructions preserve the intake, phone privacy, save, and silent-pause behavior', () => {
  const prompt = instructions();
  assert.match(prompt, /Would you like to add your email\? Yes or no/i);
  assert.match(prompt, /If no email was provided[\s\S]*call or text\?/i);
  assert.match(prompt, /Never ask for, say, confirm, or repeat the caller’s phone number/i);
  assert.match(prompt, /give me one second to save that/i);
  assert.match(prompt, /Silence is mandatory/i);
  assert.match(prompt, /take your time[\s\S]*forbidden/i);
  assert.match(prompt, /standalone filler/i);
  assert.match(prompt, /natural, measured pace/i);
});

test('one BUSINESS_INFO variable and one RECEPTIONIST_SCRIPT variable fully rebrand a clone', () => {
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
    env: {
      ...process.env,
      BUSINESS_INFO: JSON.stringify(businessInfo),
      RECEPTIONIST_SCRIPT: customScript,
      OCM_CLIENT_ID: 'sample-roofing',
      AI_MODEL: 'gpt-realtime',
      AI_VOICE: 'marin',
      AI_SPEECH_SPEED: '1.08',
      AI_SILENCE_MS: '900',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.business.name, 'Sample Roofing');
  assert.equal(output.business.timeZone, 'America/Chicago');
  assert.equal(output.openingLine, 'Thanks for calling Sample Roofing. This is Morgan. Are you calling about an estimate?');
  assert.equal(output.closingLine, 'Casey will contact you soon. Goodbye.');
  assert.match(output.instructions, /Ask what roofing service they need/i);
  assert.match(output.instructions, /roof repair, or roof replacement/i);
  assert.doesNotMatch(output.instructions, /Tabor Painting|Jason Beirne|Berlin, Massachusetts/i);
  assert.deepEqual(output.services, ['roof repair', 'roof replacement']);
  assert.equal(output.model, 'gpt-realtime');
  assert.equal(output.voice, 'marin');
  assert.equal(output.speed, 1.08);
  assert.equal(output.silence, 900);
});

test('bootstrap hardcodes the shared OCM endpoint and derives the source', () => {
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
    env: {
      ...process.env,
      OCM_CLIENT_ID: 'sample-business',
      OCM_CONNECTION_KEY: 'private-test-key',
      OCM_WEBHOOK_URL: 'https://wrong.example.com/old',
      OCM_SOURCE: 'old-source',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  const output = JSON.parse(lines.at(-1));
  assert.equal(output.origin, 'https://ark-websites-ocm.vercel.app');
  assert.equal(output.pathname, '/api/intake');
  assert.equal(output.clientId, 'sample-business');
  assert.equal(output.key, 'private-test-key');
  assert.equal(output.source, 'sample-business-receptionist');
});
