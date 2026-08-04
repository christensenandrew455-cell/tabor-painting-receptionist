import { createHash } from 'node:crypto';

function clean(value) {
  return String(value ?? '').trim();
}

function deliveryError(message, { retryable = false, status = 0 } = {}) {
  const error = new Error(message);
  error.retryable = retryable;
  error.status = status;
  return error;
}

export function createIntakeRequestId({ callSessionId, payload }) {
  const sessionId = clean(callSessionId);
  if (!sessionId) throw new Error('A call session ID is required for intake delivery.');
  return createHash('sha256')
    .update(`${sessionId}:confirmed:${JSON.stringify(payload || {})}`)
    .digest('hex');
}

export async function deliverIntake({
  url,
  token = '',
  clientId,
  callSessionId,
  payload,
  attempts = 2,
  timeoutMs = 7000,
  fetchImpl = fetch,
}) {
  const intakeUrl = clean(url);
  const exactClientId = clean(clientId);
  const sessionId = clean(callSessionId);
  if (!intakeUrl || !exactClientId || !sessionId) {
    throw new Error('Intake URL, exact client ID, and call session ID are required.');
  }

  const intakeRequestId = createIntakeRequestId({ callSessionId: sessionId, payload });
  let lastError;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const response = await fetchImpl(intakeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': intakeRequestId,
          ...(clean(token) ? { Authorization: `Bearer ${clean(token)}` } : {}),
        },
        body: JSON.stringify({
          ...payload,
          callSessionId: sessionId,
          intakeRequestId,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        throw deliveryError(`OCM returned non-JSON after intake submission: ${response.status}`);
      }

      if (!response.ok) {
        throw deliveryError(data?.error || `OCM intake failed: ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        });
      }
      if (!data || typeof data !== 'object' || data.ok === false || data.success === false) {
        throw deliveryError(data?.error || 'OCM did not confirm that the intake was saved.');
      }
      if (data.clientId && data.clientId !== exactClientId) {
        throw deliveryError('OCM confirmed the intake for a different client.');
      }

      return Object.freeze({ data, intakeRequestId });
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable !== false;
      if (attempt < attempts && retryable) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
        continue;
      }
      break;
    }
  }

  throw lastError || new Error('The estimate request could not be saved.');
}
