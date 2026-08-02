const REALTIME_MODEL = 'gpt-realtime-2.1-mini';

export const MODELS = Object.freeze({
  realtime: REALTIME_MODEL,
  realtimeVoice: REALTIME_MODEL,
  brain: REALTIME_MODEL,
  voice: process.env.AI_VOICE || 'alloy',
});

export const TURN = Object.freeze({
  silenceMs: Number(process.env.AI_SILENCE_MS || 1500),
  prefixPaddingMs: Number(process.env.AI_PREFIX_PADDING_MS || 300),
  bargeInMs: Number(process.env.AI_BARGE_IN_MS || 120),
  maxReplyCharacters: Number(process.env.AI_MAX_REPLY_CHARACTERS || 280),
});

export const LEAD_FIELDS = Object.freeze([
  'name',
  'service',
  'projectLocation',
  'preferredDate',
  'preferredTime',
  'notes',
  'contactConsent',
]);
