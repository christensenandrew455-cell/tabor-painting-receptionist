export const CALL_MAX_MS = 5 * 60 * 1000;
export const CALL_HARD_LIMIT_MS = 5.5 * 60 * 1000;
export const SILENCE_LIMIT_MS = 60 * 1000;
export const NO_PROGRESS_LIMIT_MS = 3 * 60 * 1000;
export const POLICY_CHECK_MS = 2500;

const IGNORED_PROGRESS_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'doing', 'fine', 'good', 'great',
  'hello', 'hey', 'hi', 'hold', 'how', 'i', 'im', 'is', 'it', 'like',
  'me', 'mhm', 'minute', 'my', 'no', 'nope', 'ok', 'okay', 'please',
  'second', 'so', 'thanks', 'thank', 'that', 'the', 'this', 'uh', 'um',
  'wait', 'well', 'what', 'why', 'yeah', 'yep', 'yes', 'you', 'your',
]);

export function progressTokens(transcript = '') {
  return String(transcript || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !IGNORED_PROGRESS_WORDS.has(token));
}

export function noteTranscriptProgress(seenTokens, transcript = '') {
  let changed = false;
  for (const token of progressTokens(transcript)) {
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
  if (endReason === 'silence') return 'silence-no-lead';
  if (endReason === 'no-progress') return 'no-progress-no-lead';
  return 'ended-no-lead';
}
