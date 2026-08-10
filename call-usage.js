function clean(value) {
  return String(value ?? '').trim();
}

function validDate(value, fallback) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function temporaryStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function buildCallUsageRecord({
  callId,
  startedAt,
  endedAt = new Date(),
  leadSaved = false,
  endReason = 'hangup',
  timeZone = 'UTC',
} = {}) {
  const ended = validDate(endedAt, new Date());
  const started = validDate(startedAt, ended);
  const durationSeconds = Math.max(1, Math.ceil((ended.getTime() - Math.min(started.getTime(), ended.getTime())) / 1_000));
  const normalizedReason = clean(endReason).slice(0, 80) || 'hangup';
  const savedLead = leadSaved === true;

  return Object.freeze({
    action: 'record',
    callId: clean(callId),
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationSeconds,
    leadSaved: savedLead,
    outcome: savedLead
      ? 'lead-saved'
      : normalizedReason === 'duration-limit'
        ? 'max-duration-no-lead'
        : 'ended-no-lead',
    endReason: normalizedReason,
    timeZone: clean(timeZone) || 'UTC',
  });
}

export async function reportCallUsage({
  usageUrl,
  usageKey = '',
  record,
  fetchImpl = fetch,
  attempts = 3,
  retryDelayMs = 250,
} = {}) {
  const url = clean(usageUrl);
  if (!url) return { ok: true, skipped: true };
  if (!record?.callId) throw new Error('A call ID is required to report call usage.');

  const maximumAttempts = Math.max(1, Math.min(5, Math.round(Number(attempts) || 1)));
  let lastError;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(clean(usageKey) ? { 'x-ark-connection-key': clean(usageKey) } : {}),
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      let data = {};
      if (body) {
        try { data = JSON.parse(body); } catch {}
      }
      if (response.ok && data.ok !== false) return { ok: true, duplicate: data.duplicate === true };

      const message = data.error || `ARK call usage failed: ${response.status}`;
      lastError = new Error(message);
      if (!temporaryStatus(response.status)) {
        lastError.retryable = false;
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (error?.retryable === false) throw error;
      if (attempt >= maximumAttempts) break;
    }

    if (attempt < maximumAttempts && retryDelayMs > 0) {
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError || new Error('ARK call usage could not be reported.');
}
