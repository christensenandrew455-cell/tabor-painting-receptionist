import 'dotenv/config';

const REQUIRED_VARIABLES = Object.freeze([
  'OPENAI_API_KEY',
  'TELNYX_API_KEY',
]);

function clean(value) {
  return String(value || '').trim();
}

function requireExactVariables() {
  const missing = REQUIRED_VARIABLES.filter((name) => !clean(process.env[name]));
  if (missing.length) {
    throw new Error(`Missing required Railway variables: ${missing.join(', ')}`);
  }
}

function validatePublicUrlWhenProvided() {
  const configured = clean(process.env.PUBLIC_URL);
  if (!configured) return;
  let url;
  try {
    url = new URL(configured.includes('://') ? configured : `https://${configured}`);
  } catch {
    throw new Error('PUBLIC_URL must be a complete HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_URL must use HTTP or HTTPS.');
  }
  process.env.PUBLIC_URL = `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

requireExactVariables();
validatePublicUrlWhenProvided();

process.env.AI_MODEL = 'gpt-realtime-mini';
delete process.env.RECEPTIONIST_SCRIPT;

console.log('[Receptionist bootstrap]', {
  configuration: 'loaded per call from ARK OCM by dialed Telnyx number',
  customization: 'single source in receptionist-customization.js',
  model: process.env.AI_MODEL,
  hasOpenAiKey: true,
  hasTelnyxKey: true,
  publicUrl: clean(process.env.PUBLIC_URL) || clean(process.env.RAILWAY_PUBLIC_DOMAIN) || 'Railway default',
});
