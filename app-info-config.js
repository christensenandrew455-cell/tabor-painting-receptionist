export const APP_INFO_FIELDS = Object.freeze({
  businessName: 'businessName',
  receptionistName: 'receptionistName',
  ownerName: 'ownerName',
  businessPhone: 'businessPhone',
  businessEmail: 'businessEmail',
  businessHours: 'businessHours',
  timeZone: 'timeZone',
  estimateDays: 'estimateDays',
  estimateWeekdays: 'estimateWeekdays',
  earliestEstimateStart: 'earliestEstimateStart',
  latestEstimateStart: 'latestEstimateStart',
  businessBase: 'businessBase',
  serviceAreas: 'serviceAreas',
  services: 'services',
  about: 'about',
  extraInformation: 'extraInformation',
  aiVoice: 'aiVoice',
  aiSpeechSpeed: 'aiSpeechSpeed',
  aiSilenceMs: 'aiSilenceMs',
});

export const APP_INFO_DEFAULTS = Object.freeze({
  receptionistName: 'Alex',
  businessHours: 'Monday through Friday, 9:00 AM to 5:00 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:30 PM',
  businessBase: 'the local service area',
  aiVoice: 'alloy',
  aiSpeechSpeed: 0.94,
  aiSilenceMs: 1050,
});

function clean(value) {
  return String(value ?? '').trim();
}

function text(value, fallback = '') {
  return clean(value) || fallback;
}

function spokenBusinessName(value) {
  return clean(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function list(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map(clean).filter(Boolean);
}

function services(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([name, description]) => [clean(name), clean(description)])
      .filter(([name, description]) => name && description),
  );
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function describeAppInfo(profile = {}) {
  const base = text(profile[APP_INFO_FIELDS.businessBase], APP_INFO_DEFAULTS.businessBase);
  const areas = list(profile[APP_INFO_FIELDS.serviceAreas]);
  return Object.freeze({
    businessName: spokenBusinessName(profile[APP_INFO_FIELDS.businessName]),
    receptionistName: text(profile[APP_INFO_FIELDS.receptionistName], APP_INFO_DEFAULTS.receptionistName),
    ownerName: text(profile[APP_INFO_FIELDS.ownerName]),
    businessPhone: text(profile[APP_INFO_FIELDS.businessPhone]),
    businessEmail: text(profile[APP_INFO_FIELDS.businessEmail]),
    businessHours: text(profile[APP_INFO_FIELDS.businessHours], APP_INFO_DEFAULTS.businessHours),
    timeZone: text(profile[APP_INFO_FIELDS.timeZone], APP_INFO_DEFAULTS.timeZone),
    estimateDays: text(profile[APP_INFO_FIELDS.estimateDays], APP_INFO_DEFAULTS.estimateDays),
    estimateWeekdays: list(profile[APP_INFO_FIELDS.estimateWeekdays]),
    earliestEstimateStart: text(
      profile[APP_INFO_FIELDS.earliestEstimateStart],
      APP_INFO_DEFAULTS.earliestEstimateStart,
    ),
    latestEstimateStart: text(
      profile[APP_INFO_FIELDS.latestEstimateStart],
      APP_INFO_DEFAULTS.latestEstimateStart,
    ),
    businessBase: base,
    serviceAreas: areas.length ? areas : [base],
    services: services(profile[APP_INFO_FIELDS.services]),
    about: list(profile[APP_INFO_FIELDS.about]),
    extraInformation: text(profile[APP_INFO_FIELDS.extraInformation]),
    aiVoice: text(profile[APP_INFO_FIELDS.aiVoice], APP_INFO_DEFAULTS.aiVoice),
    aiSpeechSpeed: number(profile[APP_INFO_FIELDS.aiSpeechSpeed], APP_INFO_DEFAULTS.aiSpeechSpeed),
    aiSilenceMs: Math.round(number(profile[APP_INFO_FIELDS.aiSilenceMs], APP_INFO_DEFAULTS.aiSilenceMs)),
  });
}

export function businessInfoFromAppProfile(profile = {}) {
  const info = describeAppInfo(profile);
  return Object.freeze({
    name: info.businessName,
    receptionist: info.receptionistName,
    owner: info.ownerName,
    phone: info.businessPhone,
    email: info.businessEmail,
    hours: info.businessHours,
    timeZone: info.timeZone,
    estimateDays: info.estimateDays,
    estimateWeekdays: info.estimateWeekdays,
    earliestEstimateStart: info.earliestEstimateStart,
    latestEstimateStart: info.latestEstimateStart,
    base: info.businessBase,
    serviceAreas: info.serviceAreas,
    services: info.services,
    about: info.about,
    extraInformation: info.extraInformation,
  });
}

export function runtimeEnvironmentFromApp({ profile = {}, clientId = '' } = {}) {
  const info = describeAppInfo(profile);
  return Object.freeze({
    AI_VOICE: info.aiVoice,
    AI_SPEECH_SPEED: info.aiSpeechSpeed,
    AI_SILENCE_MS: info.aiSilenceMs,
    BUSINESS_INFO: JSON.stringify(businessInfoFromAppProfile(profile)),
    OCM_CLIENT_ID: clean(clientId),
  });
}
