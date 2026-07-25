export const THINKING_CUE_DELAY_MS = 1100;
export const THINKING_CUE_PLAYBACK_MS = 900;
export const THINKING_CUES = Object.freeze(['Okay...', 'Hmm...', 'Okay...']);

export function thinkingCueForSequence(sequence = 0) {
  const index = Math.max(0, Number(sequence) || 0) % THINKING_CUES.length;
  return THINKING_CUES[index];
}

export function thinkingCueDelayMs({ speechStoppedAt = 0, now = Date.now() } = {}) {
  const elapsed = speechStoppedAt ? Math.max(0, now - speechStoppedAt) : 0;
  return Math.max(0, THINKING_CUE_DELAY_MS - elapsed);
}

export function shouldHoldTelnyxEvent(message = {}, cueActive = false, queuedCount = 0) {
  if (!message || typeof message !== 'object') return false;
  if (!cueActive && queuedCount <= 0) return false;
  return message.event === 'media' || message.event === 'mark';
}
