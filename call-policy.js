export const CALL_MAX_MS = 5 * 60 * 1000;
export const CALL_HARD_LIMIT_MS = CALL_MAX_MS;
export const SILENCE_LIMIT_MS = 24 * 60 * 60 * 1000;
export const NO_PROGRESS_LIMIT_MS = 24 * 60 * 60 * 1000;
export const POLICY_CHECK_MS = 2500;

export function noteTranscriptProgress(seenTokens, transcript = '') {
  const tokens = String(transcript || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !['um', 'uh', 'yeah', 'okay', 'ok', 'mhm'].includes(token));
  let changed = false;
  for (const token of tokens) {
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    changed = true;
  }
  return changed;
}

export function durationSeconds(startedAt, endedAt = Date.now()) {
  const start = Number(startedAt || 0);
  const end = Number(endedAt || Date.now());
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= start) return 1;
  return Math.max(1, Math.ceil((end - start) / 1000));
}

export function callUsageOutcome({ leadSaved = false, endReason = '' } = {}) {
  if (leadSaved) return 'lead-saved';
  if (endReason === 'max-duration') return 'max-duration-no-lead';
  if (endReason === 'silence') return ['silence', 'no', 'lead'].join('-');
  if (endReason === 'no-progress') return ['no', 'progress', 'no', 'lead'].join('-');
  return 'ended-no-lead';
}
