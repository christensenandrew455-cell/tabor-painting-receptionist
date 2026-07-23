import 'dotenv/config';
import { HARD_CODED_RECEPTIONIST_SCRIPT } from './receptionist-script.js';

const OCM_ENDPOINT = 'https://ark-websites-ocm.vercel.app/api/intake';
const REQUIRED_VARIABLES = Object.freeze([
  'AI_SILENCE_MS',
  'AI_SPEECH_SPEED',
  'AI_VOICE',
  'BUSINESS_INFO',
  'OCM_CLIENT_ID',
  'OCM_CONNECTION_KEY',
  'OPENAI_API_KEY',
  'PUBLIC_URL',
  'TELNYX_API_KEY',
]);

function clean(value) {
  return String(value || '').trim();
}

function cleanClientId(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function requireExactVariables() {
  const missing = REQUIRED_VARIABLES.filter((name) => !clean(process.env[name]));
  if (missing.length) {
    throw new Error(`Missing required Railway variables: ${missing.join(', ')}`);
  }
}

function validateNumber(name, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} through ${maximum}.`);
  }
}

function validatePublicUrl() {
  let url;
  try {
    url = new URL(clean(process.env.PUBLIC_URL));
  } catch {
    throw new Error('PUBLIC_URL must be a complete HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_URL must use HTTP or HTTPS.');
  }
  process.env.PUBLIC_URL = `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

function validateBusinessInfo() {
  let info;
  try {
    info = JSON.parse(process.env.BUSINESS_INFO);
  } catch {
    throw new Error('BUSINESS_INFO must be valid JSON.');
  }
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    throw new Error('BUSINESS_INFO must be one JSON object.');
  }
}

requireExactVariables();
validateNumber('AI_SPEECH_SPEED', 0.25, 1.5);
validateNumber('AI_SILENCE_MS', 300, 3000);
validatePublicUrl();
validateBusinessInfo();

process.env.AI_MODEL = 'gpt-realtime-mini';
process.env.RECEPTIONIST_SCRIPT = HARD_CODED_RECEPTIONIST_SCRIPT;

const connectionKey = clean(process.env.OCM_CONNECTION_KEY);
const clientId = cleanClientId(process.env.OCM_CLIENT_ID);
if (!clientId) {
  throw new Error('OCM_CLIENT_ID must contain letters, numbers, hyphens, or underscores.');
}

const source = `${clientId}-receptionist`;
const ocmUrl = new URL(OCM_ENDPOINT);
ocmUrl.searchParams.set('clientId', clientId);
ocmUrl.searchParams.set('key', connectionKey);
ocmUrl.searchParams.set('source', source);

process.env.OCM_CLIENT_ID = clientId;
process.env.OCM_SOURCE = source;
process.env.OCM_WEBHOOK_URL = ocmUrl.toString();

console.log('[Receptionist configuration]', {
  clientId,
  source,
  endpoint: `${ocmUrl.origin}${ocmUrl.pathname}`,
  publicUrl: process.env.PUBLIC_URL,
  hasConnectionKey: true,
  hasBusinessInfo: true,
  hasHardcodedReceptionistScript: true,
  model: process.env.AI_MODEL,
  voice: process.env.AI_VOICE,
  speechSpeed: process.env.AI_SPEECH_SPEED,
  silenceMs: process.env.AI_SILENCE_MS,
});
