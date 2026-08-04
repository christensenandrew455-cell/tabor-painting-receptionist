import { businessInfoFromAppProfile, describeAppInfo } from './app-info-config.js';
import {
  clean,
  matchConfiguredService,
  normalizeEstimateTime,
  normalizePhone,
  parseProjectAddress,
  resolveEstimateDate,
  validateClientId,
  validateIntakeLead,
} from './intake-schema.js';

function requiredText(config, field) {
  const value = clean(config[field]);
  if (!value) throw new Error(`Business profile ${field} is required.`);
  return value;
}

function requiredList(config, field) {
  const values = Array.isArray(config[field])
    ? config[field].map(clean).filter(Boolean)
    : [];
  if (!values.length) throw new Error(`Business profile ${field} must contain at least one value.`);
  return values;
}

function requiredServices(config) {
  if (!config.services || typeof config.services !== 'object' || Array.isArray(config.services)) {
    throw new Error('Business profile services must be an object.');
  }
  const entries = Object.entries(config.services)
    .map(([name, description]) => [clean(name), clean(description)])
    .filter(([name, description]) => name && description);
  if (!entries.length) throw new Error('Business profile services must contain at least one service.');
  return Object.fromEntries(entries);
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a number from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function validateTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new Error('Business profile timeZone must be a valid IANA time zone.');
  }
}

function serviceList(services) {
  const values = Object.keys(services);
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}

function weekdayList(weekdays) {
  const labels = weekdays.map((day) => day.charAt(0).toUpperCase() + day.slice(1));
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
}

export function createReceptionistCore({ profile = {}, clientId = '' } = {}) {
  const appInfo = describeAppInfo(profile);
  const configured = businessInfoFromAppProfile(profile);
  const CLIENT_ID = validateClientId(clientId);

  const BUSINESS = Object.freeze({
    name: requiredText(configured, 'name'),
    receptionist: requiredText(configured, 'receptionist'),
    owner: clean(configured.owner),
    phone: clean(configured.phone),
    email: clean(configured.email),
    hours: requiredText(configured, 'hours'),
    timeZone: requiredText(configured, 'timeZone'),
    estimateDays: requiredText(configured, 'estimateDays'),
    estimateWeekdays: requiredList(configured, 'estimateWeekdays').map((day) => day.toLowerCase()),
    earliestEstimateStart: requiredText(configured, 'earliestEstimateStart'),
    latestEstimateStart: requiredText(configured, 'latestEstimateStart'),
    base: requiredText(configured, 'base'),
    serviceAreas: requiredList(configured, 'serviceAreas'),
    services: requiredServices(configured),
    about: Array.isArray(configured.about) ? configured.about.map(clean).filter(Boolean) : [],
    extraInformation: clean(configured.extraInformation),
  });

  validateTimeZone(BUSINESS.timeZone);

  const REALTIME_VOICE = requiredText(appInfo, 'aiVoice');
  const SPEECH_SPEED = boundedNumber(appInfo.aiSpeechSpeed, 0.94, 0.25, 1.5, 'AI speech speed');
  const SILENCE_DURATION_MS = Math.round(
    boundedNumber(appInfo.aiSilenceMs, 1050, 300, 3000, 'AI silence duration'),
  );

  function normalizePreferredTime(value = '') {
    return normalizeEstimateTime(value, {
      earliest: BUSINESS.earliestEstimateStart,
      latest: BUSINESS.latestEstimateStart,
    });
  }

  if (!normalizePreferredTime(BUSINESS.earliestEstimateStart)
    || !normalizePreferredTime(BUSINESS.latestEstimateStart)) {
    throw new Error('The configured estimate time window is invalid.');
  }

  function resolvePreferredDate(value = '', now = new Date()) {
    return resolveEstimateDate(value, {
      now,
      timeZone: BUSINESS.timeZone,
      allowedWeekdays: BUSINESS.estimateWeekdays,
    });
  }

  function validateLead(rawLead = {}, nowOrOptions = new Date()) {
    const options = nowOrOptions instanceof Date ? { now: nowOrOptions } : (nowOrOptions || {});
    const validation = validateIntakeLead(rawLead, {
      business: BUSINESS,
      callerPhone: options.callerPhone,
      now: options.now || new Date(),
    });
    if (!validation.lead.serviceType) {
      validation.errors = validation.errors.map((error) => (
        error === 'one configured service'
          ? `one configured service: ${serviceList(BUSINESS.services)}`
          : error
      ));
    }
    if (!validation.lead.preferredDate) {
      validation.errors = validation.errors.map((error) => (
        error === 'an upcoming configured estimate date'
          ? `an upcoming configured estimate date or weekday: ${weekdayList(BUSINESS.estimateWeekdays)}`
          : error
      ));
    }
    return validation;
  }

  function buildOcmPayload(callerPhone, lead) {
    const phone = normalizePhone(lead.callbackPhone || callerPhone);
    if (!phone) throw new Error('A valid callback phone number is required.');
    const [FirstName, ...lastParts] = clean(lead.fullName).split(/\s+/);
    const LastName = lastParts.join(' ');
    const streetAddress = clean(`${lead.streetNumber} ${lead.streetName}`);
    const address = [
      streetAddress,
      clean(lead.unit),
      clean(lead.cityOrTown),
      clean(`${lead.state}${lead.postalCode ? ` ${lead.postalCode}` : ''}`),
    ].filter(Boolean).join(', ');

    return {
      clientId: CLIENT_ID,
      FirstName,
      LastName,
      Name: clean(lead.fullName),
      Phone: phone,
      Job: clean(lead.serviceType),
      ServiceType: clean(lead.serviceType),
      StreetAddress: streetAddress,
      Unit: clean(lead.unit),
      TownOrCity: clean(lead.cityOrTown),
      State: clean(lead.state),
      PostalCode: clean(lead.postalCode),
      Address: address,
      PreferredDate: clean(lead.preferredDate),
      EstimateDate: clean(lead.preferredDate),
      PreferredDay: clean(lead.preferredDateOrDay),
      PreferredTime: clean(lead.preferredTime),
      Notes: clean(lead.additionalNotes) || 'none',
      source: `${CLIENT_ID}-receptionist`,
    };
  }

  return Object.freeze({
    BUSINESS,
    CLIENT_ID,
    REALTIME_VOICE,
    SPEECH_SPEED,
    SILENCE_DURATION_MS,
    buildOcmPayload,
    matchService: (value) => matchConfiguredService(value, BUSINESS.services),
    normalizePhone,
    normalizePreferredTime,
    parseProjectAddress,
    resolvePreferredDate,
    validateLead,
  });
}
