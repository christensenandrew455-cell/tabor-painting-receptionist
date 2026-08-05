const SENSITIVE_KEY = /(authorization|credential|password|secret|token|api[_-]?key)/i;
const CONNECTION_KEY = /^(intakeUrl|mediaWebSocketUrl|runtimeUrl|usageUrl|webSocketUrl)$/i;
const DEFAULT_MAX_KNOWLEDGE_CHARACTERS = 12_000;

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
    if (SENSITIVE_KEY.test(key) || CONNECTION_KEY.test(key)) continue;
    const sanitized = sanitizeKnowledge(child, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
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
    'receptionistName',
    'ownerName',
    'businessPhone',
    'businessEmail',
    'businessHours',
    'hours',
    'timeZone',
    'estimateDays',
    'estimateWeekdays',
    'earliestEstimateStart',
    'latestEstimateStart',
    'businessBase',
    'serviceAreas',
    'about',
    'extraInformation',
  ];
  for (const field of topLevelFields) {
    if (runtime[field] !== undefined) selected[field] = runtime[field];
  }
  return sanitizeKnowledge(selected);
}

export function createBusinessContext(runtime = {}) {
  const normalizedRuntime = {
    ...runtime,
    profile: objectValue(runtime.profile),
    business: objectValue(runtime.business),
    businessInfo: objectValue(runtime.businessInfo),
    website: objectValue(runtime.website || runtime.websiteInfo),
    config: objectValue(runtime.config || runtime.settings),
    receptionist: objectValue(runtime.receptionist),
  };
  const serviceSource = valueAt(normalizedRuntime, 'profile.services')
    ?? valueAt(normalizedRuntime, 'business.services')
    ?? valueAt(normalizedRuntime, 'businessInfo.services')
    ?? valueAt(normalizedRuntime, 'website.services')
    ?? valueAt(normalizedRuntime, 'config.services')
    ?? normalizedRuntime.services;
  const services = normalizeServices(serviceSource);

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

  const receptionistName = firstText(normalizedRuntime, [
    'profile.receptionistName',
    'business.receptionistName',
    'businessInfo.receptionistName',
    'receptionist.name',
    'config.receptionistName',
    'receptionistName',
  ], 'Alex');

  const timeZone = validTimeZone(firstText(normalizedRuntime, [
    'profile.timeZone',
    'business.timeZone',
    'businessInfo.timeZone',
    'config.timeZone',
    'timeZone',
  ])) || validTimeZone(process.env.BUSINESS_TIME_ZONE) || 'America/New_York';

  const voice = firstText(normalizedRuntime, [
    'profile.aiVoice',
    'receptionist.voice',
    'config.aiVoice',
    'aiVoice',
    'voice',
  ], process.env.OPENAI_VOICE || 'marin');

  const publicData = publicRuntimeData(normalizedRuntime, services);
  let knowledgeJson = JSON.stringify(publicData, null, 2);
  const maximumCharacters = knowledgeCharacterLimit();
  if (knowledgeJson.length > maximumCharacters) {
    knowledgeJson = `${knowledgeJson.slice(0, maximumCharacters)}\n[website data truncated for cost control]`;
  }

  return Object.freeze({
    businessName,
    receptionistName,
    timeZone,
    voice,
    clientId: firstText(normalizedRuntime, ['clientId', 'profile.clientId', 'business.clientId']),
    services: Object.freeze(services.map((service) => Object.freeze({ ...service }))),
    knowledgeJson,
  });
}
