import { createHash } from 'node:crypto';
import { runtimeEnvironmentFromApp } from './app-info-config.js';

const OCM_RUNTIME_ENDPOINT = 'https://ark-websites-ocm-xi.vercel.app/api/receptionist/runtime';
const runtimeCache = new Map();
let importQueue = Promise.resolve();
let importSequence = 0;

function clean(value) {
  return String(value || '').trim();
}

function cacheKey(runtimeData) {
  const stable = JSON.stringify({ clientId: runtimeData.clientId, profile: runtimeData.profile });
  return createHash('sha256').update(stable).digest('hex');
}

function withTemporaryEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.entries(values).forEach(([name, value]) => {
    process.env[name] = String(value);
  });
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      Object.entries(previous).forEach(([name, value]) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    });
}

async function importCore(runtimeData) {
  const key = cacheKey(runtimeData);
  if (runtimeCache.has(key)) return runtimeCache.get(key);

  const values = runtimeEnvironmentFromApp({
    profile: runtimeData.profile || {},
    clientId: runtimeData.clientId,
  });

  const task = importQueue.then(() => withTemporaryEnvironment(values, async () => {
    importSequence += 1;
    const module = await import(`./receptionist-core.js?runtime=${encodeURIComponent(key)}-${importSequence}`);
    runtimeCache.set(key, module);
    return module;
  }));
  importQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function loadRuntimeFromSignedTelnyxEvent({ rawBody, signature, timestamp }) {
  if (!clean(rawBody) || !clean(signature) || !clean(timestamp)) {
    throw new Error('The signed Telnyx call event is incomplete.');
  }

  const response = await fetch(OCM_RUNTIME_ENDPOINT, {
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
  let data = {};
  try {
    data = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`ARK OCM returned non-JSON while loading the receptionist: ${response.status}`);
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `ARK OCM receptionist lookup failed: ${response.status}`);
  }
  if (!clean(data.clientId) || !data.profile || !clean(data.intakeUrl) || !clean(data.usageUrl)) {
    throw new Error('ARK OCM returned incomplete receptionist settings.');
  }

  return {
    clientId: clean(data.clientId),
    calledPhone: clean(data.calledPhone),
    profile: data.profile,
    intakeUrl: clean(data.intakeUrl),
    usageUrl: clean(data.usageUrl),
  };
}

export async function prepareCallRuntime(runtimeData) {
  const core = await importCore(runtimeData);
  return { ...runtimeData, core };
}

export function runtimeEndpoint() {
  return OCM_RUNTIME_ENDPOINT;
}
