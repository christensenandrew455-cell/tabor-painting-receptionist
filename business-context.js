const SENSITIVE_KEY = /(authorization|credential|password|secret|token|api[_-]?key)/i;
const CONNECTION_KEY = /^(intakeUrl|mediaWebSocketUrl|runtimeUrl|usageUrl|webSocketUrl)$/i;
const RECEPTIONIST_CONTROL_KEY = /^(?:(?:ai[\s_-]*)?receptionist(?:[\s_-]*name)?|ai[\s_-]*voice|voice)$/i;
const PRIVATE_BUSINESS_DATA_KEY = /(?:phone|telephone|email)$/i;
const OBSOLETE_BUSINESS_FACT_KEY = /^(about|extraInformation|businessHours|hours)$/i;
const DEFAULT_MAX_KNOWLEDGE_CHARACTERS = 12_000;
const WEEKDAY_NAMES = Object.freeze([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);
const LEGACY_SCHEDULE_KEYS = Object.freeze({
  estimateDays: 'serviceRequestDays',
  estimateWeekdays: 'serviceRequestWeekdays',
  earliestEstimateStart: 'earliestServiceRequestStart',
  latestEstimateStart: 'latestServiceRequestStart',
});

function knowledgeCharacterLimit() {
  const configured = Number(process.env.MAX_WEBSITE_KNOWLEDGE_CHARACTERS);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_KNOWLEDGE_CHARACTERS;
  return Math.max(2_000, Math.min(50_000, Math.round(configured)));
}

export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function valueAt(root, path) {
  return path.split('.').reduce((value, key) => value?.[key], root);
}

function firstText(root, paths, fallback = '') {
  for (const path of paths) {
    const value = cleanText(valueAt(root, path));
    if (value) return value;
  }
  return fallback;
}

function firstValue(root, paths) {
  for (const path of paths) {
    const value = valueAt(root, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function weekdayName(value) {
  const normalized = cleanText(value).toLowerCase();
  return WEEKDAY_NAMES.find(
    (weekday) => normalized === weekday || normalized === weekday.slice(0, 3),
  ) || '';
}

function normalizeRequestWeekdays(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(weekdayName).filter(Boolean))];
  }

  const text = cleanText(value).toLowerCase();
  if (!text) return [];
  if (/\b(every day|daily|seven days)\b/.test(text)) return [...WEEKDAY_NAMES];
  if (/\bweekdays?\b/.test(text)) return WEEKDAY_NAMES.slice(1, 6);
  if (/\bweekends?\b/.test(text)) return ['saturday', 'sunday'];

  const range = text.match(/\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b\s*(?:through|thru|to|-)\s*\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/);
  if (range) {
    const start = WEEKDAY_NAMES.indexOf(weekdayName(range[1]));
    const end = WEEKDAY_NAMES.indexOf(weekdayName(range[2]));
    if (start >= 0 && end >= 0) {
      const weekdays = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const weekday = WEEKDAY_NAMES[(start + offset) % 7];
        weekdays.push(weekday);
        if (weekday === WEEKDAY_NAMES[end]) break;
      }
      return weekdays;
    }
  }

  return WEEKDAY_NAMES.filter((weekday) => new RegExp(`\\b${weekday}(?:s)?\\b|\\b${weekday.slice(0, 3)}\\b`).test(text));
}

export function normalizeServiceAreas(value) {
  const areas = [];
  const add = (candidate) => {
    const area = cleanText(candidate);
    if (area) areas.push(area);
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') {
        add(item.name || item.label || item.area || item.county || item.city || item.state);
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [name, enabled] of Object.entries(value)) {
      if (enabled === false || enabled === null || enabled === undefined) continue;
      if (typeof enabled === 'string') add(enabled);
      else add(name);
    }
  } else if (typeof value === 'string') {
    value.split(/[;\n|]/).forEach(add);
  }

  const unique = new Map();
  for (const area of areas) {
    const key = area.toLocaleLowerCase('en-US');
    if (!unique.has(key)) unique.set(key, area);
  }
  return [...unique.values()].slice(0, 100);
}

function validTimeZone(value) {
  const timeZone = cleanText(value);
  if (!timeZone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return timeZone;
  } catch {
    return '';
  }
}

function serviceEntry(value, fallbackName = '') {
  if (typeof value === 'string') {
    const name = cleanText(fallbackName || value);
    const description = fallbackName ? cleanText(value) : '';
    return name ? { name, description } : null;
  }

  const service = objectValue(value);
  const name = cleanText(
    service.name || service.title || service.label || service.service || fallbackName,
  );
  if (!name) return null;
  return {
    name,
    description: cleanText(
      service.description || service.details || service.summary || service.content,
    ),
  };
}

export function normalizeServices(value) {
  const entries = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const entry = serviceEntry(item);
      if (entry) entries.push(entry);
    }
  } else if (value && typeof value === 'object') {
    for (const [name, details] of Object.entries(value)) {
      const entry = serviceEntry(details, name);
      if (entry) entries.push(entry);
    }
  } else if (typeof value === 'string') {
    value.split(/[,;\n]/).map(cleanText).filter(Boolean).forEach((name) => {
      entries.push({ name, description: '' });
    });
  }

  const unique = new Map();
  for (const entry of entries) {
    const key = entry.name.toLocaleLowerCase('en-US');
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].slice(0, 100);
}

function businessInformationEntry(value, fallbackTitle = '') {
  if (typeof value === 'string') {
    const title = cleanText(fallbackTitle).slice(0, 120);
    const info = cleanText(value).slice(0, 1_000);
    return title && info ? { title, info } : null;
  }

  const item = objectValue(value);
  const title = cleanText(item.title || item.name || item.label || fallbackTitle).slice(0, 120);
  const info = cleanText(
    item.info || item.information || item.details || item.description || item.value,
  ).slice(0, 1_000);
  return title && info ? { title, info } : null;
}

export function normalizeBusinessInformation(value) {
  const entries = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const entry = businessInformationEntry(item);
      if (entry) entries.push(entry);
    }
  } else if (value && typeof value === 'object') {
    const directEntry = businessInformationEntry(value);
    if (directEntry) {
      entries.push(directEntry);
    } else {
      for (const [title, info] of Object.entries(value)) {
        const entry = businessInformationEntry(info, title);
        if (entry) entries.push(entry);
      }
    }
  }

  const unique = new Map();
  for (const entry of entries) {
    const key = `${entry.title}\u0000${entry.info}`.toLocaleLowerCase('en-US');
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].slice(0, 50);
}

function sanitizeKnowledge(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return cleanText(value).slice(0, 4_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100)
      .map((item) => sanitizeKnowledge(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;

  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 150)) {
    if (
      SENSITIVE_KEY.test(key)
      || CONNECTION_KEY.test(key)
      || RECEPTIONIST_CONTROL_KEY.test(key)
      || PRIVATE_BUSINESS_DATA_KEY.test(key)
      || OBSOLETE_BUSINESS_FACT_KEY.test(key)
    ) continue;
    if (/^businessInformation$/i.test(key)) {
      const businessInformation = normalizeBusinessInformation(child);
      if (businessInformation.length) result.businessInformation = businessInformation;
      continue;
    }
    const sanitized = sanitizeKnowledge(child, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function canonicalizeServiceRequestKnowledge(value) {
  if (Array.isArray(value)) return value.map(canonicalizeServiceRequestKnowledge);
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (LEGACY_SCHEDULE_KEYS[key]) continue;
    result[key] = canonicalizeServiceRequestKnowledge(child);
  }
  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_SCHEDULE_KEYS)) {
    if (value[legacyKey] === undefined || result[canonicalKey] !== undefined) continue;
    result[canonicalKey] = canonicalizeServiceRequestKnowledge(value[legacyKey]);
  }
  return result;
}

function publicRuntimeData(runtime, services) {
  const selected = {
    profile: runtime.profile,
    business: runtime.business || runtime.businessInfo,
    website: runtime.website || runtime.websiteInfo,
    knowledge: runtime.knowledge || runtime.knowledgeBase,
    faq: runtime.faq || runtime.faqs,
    config: runtime.config || runtime.settings,
    services,
  };

  const topLevelFields = [
    'businessName',
    'ownerName',
    'timeZone',
    'estimateDays',
    'estimateWeekdays',
    'earliestEstimateStart',
    'latestEstimateStart',
    'serviceRequestDays',
    'serviceRequestWeekdays',
    'earliestServiceRequestStart',
    'latestServiceRequestStart',
    'businessBase',
    'businessCounty',
    'serviceAreas',
    'serviceAreaMode',
    'serviceAreaStates',
    'serviceAreaCounties',
    'businessInformation',
  ];
  for (const field of topLevelFields) {
    if (runtime[field] !== undefined) selected[field] = runtime[field];
  }
  return canonicalizeServiceRequestKnowledge(sanitizeKnowledge(selected));
}

export function createBusinessContext(runtime = {}) {
  const normalizedRuntime = {
    ...runtime,
    profile: objectValue(runtime.profile),
    business: objectValue(runtime.business),
    businessInfo: objectValue(runtime.businessInfo),
    website: objectValue(runtime.website || runtime.websiteInfo),
    config: objectValue(runtime.config || runtime.settings),
  };
  const serviceSource = valueAt(normalizedRuntime, 'profile.services')
    ?? valueAt(normalizedRuntime, 'business.services')
    ?? valueAt(normalizedRuntime, 'businessInfo.services')
    ?? valueAt(normalizedRuntime, 'website.services')
    ?? valueAt(normalizedRuntime, 'config.services')
    ?? normalizedRuntime.services;
  const services = normalizeServices(serviceSource);
  const businessInformation = normalizeBusinessInformation(
    valueAt(normalizedRuntime, 'profile.businessInformation')
      ?? valueAt(normalizedRuntime, 'business.businessInformation')
      ?? valueAt(normalizedRuntime, 'businessInfo.businessInformation')
      ?? valueAt(normalizedRuntime, 'website.businessInformation')
      ?? valueAt(normalizedRuntime, 'knowledge.businessInformation')
      ?? valueAt(normalizedRuntime, 'config.businessInformation')
      ?? normalizedRuntime.businessInformation,
  );

  const businessName = firstText(normalizedRuntime, [
    'profile.businessName',
    'business.businessName',
    'business.name',
    'businessInfo.businessName',
    'businessInfo.name',
    'website.businessName',
    'config.businessName',
    'businessName',
  ], 'the business');

  const timeZone = validTimeZone(firstText(normalizedRuntime, [
    'profile.timeZone',
    'business.timeZone',
    'businessInfo.timeZone',
    'config.timeZone',
    'timeZone',
  ])) || validTimeZone(process.env.BUSINESS_TIME_ZONE) || 'America/New_York';

  const requestWeekdayPaths = [
    'profile.serviceRequestWeekdays',
    'business.serviceRequestWeekdays',
    'businessInfo.serviceRequestWeekdays',
    'config.serviceRequestWeekdays',
    'serviceRequestWeekdays',
    'profile.estimateWeekdays',
    'business.estimateWeekdays',
    'businessInfo.estimateWeekdays',
    'config.estimateWeekdays',
    'estimateWeekdays',
  ];
  const requestDaysPaths = [
    'profile.serviceRequestDays',
    'business.serviceRequestDays',
    'businessInfo.serviceRequestDays',
    'config.serviceRequestDays',
    'serviceRequestDays',
    'profile.estimateDays',
    'business.estimateDays',
    'businessInfo.estimateDays',
    'config.estimateDays',
    'estimateDays',
  ];
  const serviceRequestWeekdays = normalizeRequestWeekdays(
    firstValue(normalizedRuntime, requestWeekdayPaths)
      ?? firstValue(normalizedRuntime, requestDaysPaths),
  );
  const earliestServiceRequestStart = firstText(normalizedRuntime, [
    'profile.earliestServiceRequestStart',
    'business.earliestServiceRequestStart',
    'businessInfo.earliestServiceRequestStart',
    'config.earliestServiceRequestStart',
    'earliestServiceRequestStart',
    'profile.earliestEstimateStart',
    'business.earliestEstimateStart',
    'businessInfo.earliestEstimateStart',
    'config.earliestEstimateStart',
    'earliestEstimateStart',
  ]);
  const latestServiceRequestStart = firstText(normalizedRuntime, [
    'profile.latestServiceRequestStart',
    'business.latestServiceRequestStart',
    'businessInfo.latestServiceRequestStart',
    'config.latestServiceRequestStart',
    'latestServiceRequestStart',
    'profile.latestEstimateStart',
    'business.latestEstimateStart',
    'businessInfo.latestEstimateStart',
    'config.latestEstimateStart',
    'latestEstimateStart',
  ]);
  const serviceAreas = normalizeServiceAreas(firstValue(normalizedRuntime, [
    'profile.serviceAreas',
    'business.serviceAreas',
    'businessInfo.serviceAreas',
    'config.serviceAreas',
    'serviceAreas',
    'profile.serviceArea',
    'business.serviceArea',
    'businessInfo.serviceArea',
    'serviceArea',
  ]));
  const serviceAreaStates = normalizeServiceAreas(firstValue(normalizedRuntime, [
    'profile.serviceAreaStates',
    'business.serviceAreaStates',
    'businessInfo.serviceAreaStates',
    'config.serviceAreaStates',
    'serviceAreaStates',
  ]));
  const serviceAreaCounties = normalizeServiceAreas(firstValue(normalizedRuntime, [
    'profile.serviceAreaCounties',
    'business.serviceAreaCounties',
    'businessInfo.serviceAreaCounties',
    'config.serviceAreaCounties',
    'serviceAreaCounties',
  ]));
  const serviceAreaMode = firstText(normalizedRuntime, [
    'profile.serviceAreaMode',
    'business.serviceAreaMode',
    'businessInfo.serviceAreaMode',
    'config.serviceAreaMode',
    'serviceAreaMode',
  ]);
  const businessCounty = firstText(normalizedRuntime, [
    'profile.businessCounty',
    'business.businessCounty',
    'businessInfo.businessCounty',
    'config.businessCounty',
    'businessCounty',
    'profile.county',
    'business.county',
    'businessInfo.county',
  ]);

  const publicData = publicRuntimeData(normalizedRuntime, services);
  let knowledgeJson = JSON.stringify(publicData, null, 2);
  const maximumCharacters = knowledgeCharacterLimit();
  if (knowledgeJson.length > maximumCharacters) {
    knowledgeJson = `${knowledgeJson.slice(0, maximumCharacters)}\n[website data truncated for cost control]`;
  }

  return Object.freeze({
    businessName,
    timeZone,
    serviceRequestWeekdays: Object.freeze(serviceRequestWeekdays),
    earliestServiceRequestStart,
    latestServiceRequestStart,
    estimateWeekdays: Object.freeze([...serviceRequestWeekdays]),
    earliestEstimateStart: earliestServiceRequestStart,
    latestEstimateStart: latestServiceRequestStart,
    serviceAreas: Object.freeze(serviceAreas),
    serviceAreaMode,
    serviceAreaStates: Object.freeze(serviceAreaStates),
    serviceAreaCounties: Object.freeze(serviceAreaCounties),
    businessCounty,
    clientId: firstText(normalizedRuntime, ['clientId', 'profile.clientId', 'business.clientId']),
    services: Object.freeze(services.map((service) => Object.freeze({ ...service }))),
    businessInformation: Object.freeze(
      businessInformation.map((item) => Object.freeze({ ...item })),
    ),
    knowledgeJson,
  });
}
