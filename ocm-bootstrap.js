import 'dotenv/config';

const DEFAULT_OCM_ENDPOINT = 'https://ark-websites-ocm.vercel.app/api/intake';
const LEGACY_PREVIEW_HOSTS = new Set([
  'ark-websites-c1380rl48-andrews-projects-8d08c0b9.vercel.app'
]);

function cleanClientId(value) {
  return String(value || 'tabor-painting')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'tabor-painting';
}

const connectionKey = String(process.env.OCM_CONNECTION_KEY || '').trim();
const clientId = cleanClientId(process.env.OCM_CLIENT_ID);
const source = String(process.env.OCM_SOURCE || `${clientId}-receptionist`).trim();
const configuredEndpoint = String(process.env.OCM_WEBHOOK_URL || DEFAULT_OCM_ENDPOINT).trim();

if (!connectionKey) {
  throw new Error(
    'OCM_CONNECTION_KEY is missing. Add the business connection key to the Railway service variables.'
  );
}

let ocmUrl;
try {
  ocmUrl = new URL(configuredEndpoint);
} catch {
  throw new Error('OCM_WEBHOOK_URL must be a complete HTTPS URL.');
}

if (LEGACY_PREVIEW_HOSTS.has(ocmUrl.hostname)) {
  console.warn('[OCM configuration] Replacing the retired protected preview URL with the production OCM URL.');
  ocmUrl = new URL(DEFAULT_OCM_ENDPOINT);
}

if (ocmUrl.protocol !== 'https:' && ocmUrl.hostname !== 'localhost') {
  throw new Error('OCM_WEBHOOK_URL must use HTTPS outside local development.');
}

ocmUrl.searchParams.set('clientId', clientId);
ocmUrl.searchParams.set('key', connectionKey);
ocmUrl.searchParams.set('source', source);

process.env.OCM_WEBHOOK_URL = ocmUrl.toString();
process.env.OCM_CLIENT_ID = clientId;
process.env.OCM_SOURCE = source;

console.log('[OCM configuration]', {
  endpoint: `${ocmUrl.origin}${ocmUrl.pathname}`,
  clientId,
  source,
  hasConnectionKey: true,
  hasBusinessInfo: Boolean(String(process.env.BUSINESS_INFO || '').trim())
});
