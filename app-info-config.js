// Single source of truth for business information supplied by ARK Websites OCM.
// Model selection, script wording, workflow rules, and memory behavior stay inside this receptionist repository.

import { RECEPTIONIST_SCRIPT_SECTIONS } from './receptionist-script.js';

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

function renderScript(value, replacements = {}) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const replacement = replacements[String(key).toLowerCase()];
    return replacement === undefined ? match : replacement;
  }).replace(/\s+/g, ' ').trim();
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
    extraInformation: textOrDefault(profile[APP_INFO_FIELDS.extraInformation]),
    aiVoice: textOrDefault(profile[APP_INFO_FIELDS.aiVoice], APP_INFO_DEFAULTS.aiVoice),
    aiSpeechSpeed: finiteNumber(profile[APP_INFO_FIELDS.aiSpeechSpeed], APP_INFO_DEFAULTS.aiSpeechSpeed),
    aiSilenceMs: Math.round(finiteNumber(profile[APP_INFO_FIELDS.aiSilenceMs], APP_INFO_DEFAULTS.aiSilenceMs)),
  });
}

// Maps OCM business facts to the stable names consumed by receptionist-core.js.
// Opening and closing wording always come from the Tabor receptionist script below.
export function businessInfoFromAppProfile(profile = {}) {
  const info = describeAppInfo(profile);
  const replacements = {
    business_name: info.businessName,
    ai_name: info.receptionistName,
    receptionist_name: info.receptionistName,
  };
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
    openingLine: renderScript(RECEPTIONIST_SCRIPT_SECTIONS.opening, replacements),
    closingLine: renderScript(RECEPTIONIST_SCRIPT_SECTIONS.closing, replacements),
    extraInformation: info.extraInformation,
  });
}

// Creates temporary runtime values for business-specific information only.
// AI_MODEL is a local legacy compatibility value; the modular models are fixed in modular-models.js.
export function runtimeEnvironmentFromApp({ profile = {}, clientId = '' } = {}) {
  const info = describeAppInfo(profile);
  return Object.freeze({
    AI_MODEL: 'gpt-realtime-mini',
    AI_VOICE: info.aiVoice,
    AI_SPEECH_SPEED: info.aiSpeechSpeed,
    AI_SILENCE_MS: info.aiSilenceMs,
    BUSINESS_INFO: JSON.stringify(businessInfoFromAppProfile(profile)),
    OCM_CLIENT_ID: cleanText(clientId),
  });
}

export function serviceListFromBusiness(services = {}) {
  const names = Object.keys(services);
  if (names.length <= 1) return names[0] || 'the configured services';
  return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
}

export function buildBusinessKnowledge(business = {}) {
  const services = Object.entries(business.services || {})
    .map(([name, description]) => `- ${name}: ${description}`)
    .join('\n') || '- No services were configured.';
  const about = Array.isArray(business.about) && business.about.length
    ? `- About: ${business.about.join(' ')}\n`
    : '';
  const extra = cleanText(business.extraInformation)
    ? `- Additional information: ${cleanText(business.extraInformation)}\n`
    : '';
  return [
    'BUSINESS INFORMATION',
    `- Business name: ${cleanText(business.name)}`,
    `- Receptionist name: ${cleanText(business.receptionist)}`,
    `- Owner and main contact: ${cleanText(business.owner)}`,
    `- Business phone: ${cleanText(business.phone)}`,
    `- Business email: ${cleanText(business.email)}`,
    `- Hours: ${cleanText(business.hours)}`,
    `- Estimate days: ${cleanText(business.estimateDays)}`,
    `- Estimate request times: ${cleanText(business.earliestEstimateStart)} through ${cleanText(business.latestEstimateStart)}`,
    `- Time zone: ${cleanText(business.timeZone)}`,
    `- Based in: ${cleanText(business.base)}`,
    `- Common service areas: ${(business.serviceAreas || []).join(', ')}`,
    '- Services:',
    services,
    about.trimEnd(),
    extra.trimEnd(),
    '- Never quote an unconfigured price, promise availability, or invent information.',
  ].filter(Boolean).join('\n');
}
