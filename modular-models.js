export const MODELS = Object.freeze({
  transcriptionSession: process.env.TRANSCRIPTION_SESSION_MODEL || 'gpt-realtime-mini',
  transcription: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  brain: process.env.BRAIN_MODEL || 'gpt-4.1-mini',
  speech: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
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
