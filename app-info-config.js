// Single source of truth for information supplied by ARK Websites OCM.
// The live receptionist imports this file instead of guessing profile field names
// or repeating business-information defaults in several files.

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
  openingLine: 'openingLine',
  closingLine: 'closingLine',
  extraInformation: 'extraInformation',
  aiModel: 'aiModel',
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
  aiModel: 'gpt-realtime-2.1-mini',
  aiVoice: 'alloy',
  aiSpeechSpeed: 0.94,
  aiSilenceMs: 1050,
});

function cleanText(value) {
  return String(value ?? '').trim();
}

function textOrDefault(value, fallback = '') {
  return cleanText(value) || fallback;
}

function listOrDefault(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((item) => cleanText(item)).filter(Boolean);
}

function servicesOrEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([name, description]) => [cleanText(name), cleanText(description)])
      .filter(([name, description]) => name && description),
  );
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function describeAppInfo(profile = {}) {
  const base = textOrDefault(profile[APP_INFO_FIELDS.businessBase], APP_INFO_DEFAULTS.businessBase);
  const configuredAreas = listOrDefault(profile[APP_INFO_FIELDS.serviceAreas]);

  return Object.freeze({
    businessName: textOrDefault(profile[APP_INFO_FIELDS.businessName]),
    receptionistName: textOrDefault(profile[APP_INFO_FIELDS.receptionistName], APP_INFO_DEFAULTS.receptionistName),
    ownerName: textOrDefault(profile[APP_INFO_FIELDS.ownerName]),
    businessPhone: textOrDefault(profile[APP_INFO_FIELDS.businessPhone]),
    businessEmail: textOrDefault(profile[APP_INFO_FIELDS.businessEmail]),
    businessHours: textOrDefault(profile[APP_INFO_FIELDS.businessHours], APP_INFO_DEFAULTS.businessHours),
    timeZone: textOrDefault(profile[APP_INFO_FIELDS.timeZone], APP_INFO_DEFAULTS.timeZone),
    estimateDays: textOrDefault(profile[APP_INFO_FIELDS.estimateDays], APP_INFO_DEFAULTS.estimateDays),
    estimateWeekdays: listOrDefault(profile[APP_INFO_FIELDS.estimateWeekdays]),
    earliestEstimateStart: textOrDefault(
      profile[APP_INFO_FIELDS.earliestEstimateStart],
      APP_INFO_DEFAULTS.earliestEstimateStart,
    ),
    latestEstimateStart: textOrDefault(
      profile[APP_INFO_FIELDS.latestEstimateStart],
      APP_INFO_DEFAULTS.latestEstimateStart,
    ),
    businessBase: base,
    serviceAreas: configuredAreas.length ? configuredAreas : [base],
    services: servicesOrEmpty(profile[APP_INFO_FIELDS.services]),
    about: listOrDefault(profile[APP_INFO_FIELDS.about]),
    openingLine: textOrDefault(profile[APP_INFO_FIELDS.openingLine]),
    closingLine: textOrDefault(profile[APP_INFO_FIELDS.closingLine]),
    extraInformation: textOrDefault(profile[APP_INFO_FIELDS.extraInformation]),
    aiModel: textOrDefault(profile[APP_INFO_FIELDS.aiModel], APP_INFO_DEFAULTS.aiModel),
    aiVoice: textOrDefault(profile[APP_INFO_FIELDS.aiVoice], APP_INFO_DEFAULTS.aiVoice),
    aiSpeechSpeed: finiteNumber(profile[APP_INFO_FIELDS.aiSpeechSpeed], APP_INFO_DEFAULTS.aiSpeechSpeed),
    aiSilenceMs: Math.round(finiteNumber(profile[APP_INFO_FIELDS.aiSilenceMs], APP_INFO_DEFAULTS.aiSilenceMs)),
  });
}

// Maps ARK OCM profile names to the stable names consumed by receptionist-core.js.
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
    openingLine: info.openingLine,
    closingLine: info.closingLine,
    extraInformation: info.extraInformation,
  });
}

// Creates the temporary runtime values used when loading one business receptionist.
export function runtimeEnvironmentFromApp({ profile = {}, clientId = '' } = {}) {
  const info = describeAppInfo(profile);
  return Object.freeze({
    AI_MODEL: info.aiModel,
    AI_VOICE: info.aiVoice,
    AI_SPEECH_SPEED: info.aiSpeechSpeed,
    AI_SILENCE_MS: info.aiSilenceMs,
    BUSINESS_INFO: JSON.stringify(businessInfoFromAppProfile(profile)),
    OCM_CLIENT_ID: cleanText(clientId),
  });
}
