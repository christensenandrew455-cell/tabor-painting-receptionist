export const MODELS = Object.freeze({
  realtimeVoice: process.env.REALTIME_VOICE_MODEL || 'gpt-realtime-mini',
  transcription: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  brain: process.env.BRAIN_MODEL || 'gpt-5-mini',
  voice: process.env.AI_VOICE || 'alloy',
});

export const TURN = Object.freeze({
  silenceMs: Number(process.env.AI_SILENCE_MS || 1100),
  prefixPaddingMs: Number(process.env.AI_PREFIX_PADDING_MS || 250),
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
