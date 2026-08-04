import { createReceptionistCore } from './receptionist-core.js';

const DEFAULT_OCM_RUNTIME_ENDPOINT = 'https://ark-websites-ocm-xi.vercel.app/api/receptionist/runtime';

const ALLOWED_PROFILE_FIELDS = Object.freeze([
  'businessName',
  'receptionistName',
  'ownerName',
  'businessPhone',
  'businessEmail',
  'businessHours',
  'timeZone',
  'estimateDays',
  'estimateWeekdays',
  'earliestEstimateStart',
  'latestEstimateStart',
  'businessBase',
  'serviceAreas',
  'services',
  'about',
  'extraInformation',
  'aiVoice',
  'aiSpeechSpeed',
  'aiSilenceMs',
]);

function clean(value) {
  return String(value || '').trim();
}

function sanitizeProfile(profile = {}) {
  const sanitized = {};
  for (const field of ALLOWED_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(profile, field)) sanitized[field] = profile[field];
  }
  return sanitized;
}

function validatedEndpoint(value, label) {
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(`${label} must use HTTPS.`);
  }
  return url.toString();
}

function runtimeEndpointValue() {
  return validatedEndpoint(
    process.env.OCM_RUNTIME_ENDPOINT || DEFAULT_OCM_RUNTIME_ENDPOINT,
    'OCM runtime endpoint',
  );
}

export async function loadRuntimeFromSignedTelnyxEvent({ rawBody, signature, timestamp }) {
  if (!clean(rawBody) || !clean(signature) || !clean(timestamp)) {
    throw new Error('The signed Telnyx call event is incomplete.');
  }

  const response = await fetch(runtimeEndpointValue(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'telnyx-signature-ed25519': signature,
      'telnyx-timestamp': timestamp,
    },
    body: rawBody,
    signal: AbortSignal.timeout(7000),
  });

  const rawResponse = await response.text();
  let data;
  try {
    data = rawResponse ? JSON.parse(rawResponse) : null;
  } catch {
    throw new Error(`ARK OCM returned non-JSON while loading the receptionist: ${response.status}`);
  }

  if (!response.ok || !data || data.ok === false) {
    throw new Error(data?.error || `ARK OCM receptionist lookup failed: ${response.status}`);
  }
  if (!clean(data.clientId) || !data.profile || !clean(data.intakeUrl) || !clean(data.usageUrl)) {
    throw new Error('ARK OCM returned incomplete receptionist settings.');
  }

  const profile = sanitizeProfile(data.profile);
  const ignoredFields = Object.keys(data.profile).filter((field) => !ALLOWED_PROFILE_FIELDS.includes(field));
  if (ignoredFields.length) {
    console.log('[OCM runtime fields ignored]', {
      clientId: clean(data.clientId),
      fields: ignoredFields,
    });
  }

  return Object.freeze({
    clientId: clean(data.clientId),
    calledPhone: clean(data.calledPhone),
    profile,
    intakeUrl: validatedEndpoint(data.intakeUrl, 'OCM intake endpoint'),
    usageUrl: validatedEndpoint(data.usageUrl, 'OCM usage endpoint'),
    intakeToken: clean(data.intakeToken),
    usageToken: clean(data.usageToken),
    expiresAt: clean(data.expiresAt),
  });
}

export async function prepareCallRuntime(runtimeData) {
  const safeRuntimeData = {
    ...runtimeData,
    profile: sanitizeProfile(runtimeData.profile || {}),
  };
  const core = createReceptionistCore({
    profile: safeRuntimeData.profile,
    clientId: safeRuntimeData.clientId,
  });
  return Object.freeze({ ...safeRuntimeData, core });
}

export function runtimeEndpoint() {
  return runtimeEndpointValue();
}
