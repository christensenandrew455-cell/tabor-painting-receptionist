import 'dotenv/config';

const OCM_ENDPOINT = 'https://ark-websites-ocm.vercel.app/api/intake';

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

const connectionKey = clean(process.env.OCM_CONNECTION_KEY);
const clientId = cleanClientId(process.env.OCM_CLIENT_ID);

if (!clientId) {
  throw new Error('OCM_CLIENT_ID is missing. Add the client account ID to the Railway service variables.');
}

if (!connectionKey) {
  throw new Error('OCM_CONNECTION_KEY is missing. Add the private client connection key to the Railway service variables.');
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
  hasConnectionKey: true,
  hasBusinessInfo: Boolean(clean(process.env.BUSINESS_INFO)),
  hasCustomScript: Boolean(clean(process.env.RECEPTIONIST_SCRIPT)),
  model: clean(process.env.AI_MODEL) || 'gpt-realtime-mini',
  voice: clean(process.env.AI_VOICE) || 'alloy',
  speechSpeed: clean(process.env.AI_SPEECH_SPEED) || '0.94',
  silenceMs: clean(process.env.AI_SILENCE_MS) || '1200',
});
