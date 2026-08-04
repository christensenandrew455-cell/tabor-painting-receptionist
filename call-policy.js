export function durationSeconds(startedAt, endedAt = Date.now()) {
  const start = Number(startedAt || 0);
  const end = Number(endedAt || Date.now());
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= start) return 1;
  return Math.max(1, Math.ceil((end - start) / 1000));
}

export function callUsageOutcome({ leadSaved = false, endReason = '' } = {}) {
  if (leadSaved) return 'lead-saved';
  if (endReason === 'max-duration') return 'max-duration-no-lead';
  if (endReason === 'consent-declined') return 'consent-declined-no-lead';
  if (endReason === 'declined-estimate') return 'declined-estimate';
  if (endReason === 'submission-failed') return 'submission-failed';
  return 'ended-no-lead';
}
