const DEFAULT_OCM_ENDPOINT =
  'https://ark-websites-c1380rl48-andrews-projects-8d08c0b9.vercel.app/api/intake';

const connectionKey = String(process.env.OCM_CONNECTION_KEY || '').trim();
const configuredEndpoint = String(
  process.env.OCM_WEBHOOK_URL || DEFAULT_OCM_ENDPOINT
).trim();

if (!connectionKey) {
  throw new Error(
    'OCM_CONNECTION_KEY is missing. Add the Tabor Painting connection key to Railway service variables.'
  );
}

const ocmUrl = new URL(configuredEndpoint);
ocmUrl.searchParams.set('clientId', 'tabor-painting');
ocmUrl.searchParams.set('key', connectionKey);
ocmUrl.searchParams.set('source', 'phone');

process.env.OCM_WEBHOOK_URL = ocmUrl.toString();
