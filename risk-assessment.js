import { cleanText } from './business-context.js';

const TELNYX_NUMBER_LOOKUP_URL = 'https://api.telnyx.com/v2/number_lookup';
const GOOGLE_ADDRESS_VALIDATION_URL = 'https://addressvalidation.googleapis.com/v1:validateAddress';
const DEFAULT_LOOKUP_TIMEOUT_MS = 8_000;
const VERIFIED_ADDRESS_GRANULARITIES = new Set([
  'SUB_PREMISE',
  'PREMISE',
  'PREMISE_PROXIMITY',
]);

const US_STATE_NAMES = Object.freeze({
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas',
  KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts',
  MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico',
  NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
  DC: 'district of columbia',
});

const USELESS_CALLER_NAMES = new Set([
  'anonymous',
  'caller',
  'cell phone',
  'mobile caller',
  'not available',
  'private',
  'private caller',
  'restricted',
  'unknown',
  'unavailable',
  'wireless caller',
]);

function normalized(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LOOKUP_TIMEOUT_MS;
  return Math.max(1_000, Math.min(20_000, Math.round(parsed)));
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function callerNameIsUseful(value) {
  const name = normalized(value);
  return Boolean(name && name.length >= 2 && !USELESS_CALLER_NAMES.has(name));
}

function phoneLineType(data = {}) {
  const types = [data?.portability?.line_type, data?.carrier?.type]
    .map((value) => cleanText(value).toLowerCase())
    .filter(Boolean);
  return types.find((value) => /voip/.test(value)) || types[0] || '';
}

export async function lookupTelnyxPhoneNumber(phoneNumber, {
  fetchImpl = globalThis.fetch,
  apiKey = process.env.TELNYX_API_KEY,
  timeoutMs = process.env.RISK_LOOKUP_TIMEOUT_MS,
} = {}) {
  const phone = cleanText(phoneNumber);
  if (!/^\+\d{8,15}$/.test(phone) || !cleanText(apiKey) || typeof fetchImpl !== 'function') {
    return Object.freeze({ status: 'failed' });
  }

  const url = new URL(`${TELNYX_NUMBER_LOOKUP_URL}/${encodeURIComponent(phone)}`);
  url.searchParams.append('type', 'carrier');
  url.searchParams.append('type', 'caller-name');

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cleanText(apiKey)}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(boundedTimeout(timeoutMs)),
    });
    const body = await responseJson(response);
    const data = body?.data;
    if (
      !response.ok
      || !data
      || cleanText(data.record_type).toLowerCase() !== 'number_lookup'
      || !/^\+\d{8,15}$/.test(cleanText(data.phone_number))
    ) {
      return Object.freeze({ status: 'failed' });
    }

    const callerName = cleanText(data?.caller_name?.caller_name);
    return Object.freeze({
      status: 'verified',
      phoneNumber: cleanText(data.phone_number),
      lineType: phoneLineType(data),
      carrierName: cleanText(data?.carrier?.normalized_carrier || data?.carrier?.name),
      callerName: callerNameIsUseful(callerName) ? callerName : '',
      city: cleanText(data?.portability?.city),
      state: cleanText(data?.portability?.state),
    });
  } catch {
    return Object.freeze({ status: 'failed' });
  }
}

function addressComponent(result = {}, componentType) {
  const component = (result?.address?.addressComponents || []).find(
    (candidate) => cleanText(candidate?.componentType) === componentType,
  );
  return cleanText(component?.componentName?.text);
}

export async function validateGoogleAddress(address, {
  fetchImpl = globalThis.fetch,
  apiKey = process.env.GOOGLE_MAPS_API_KEY,
  regionCode = process.env.GOOGLE_MAPS_REGION_CODE || 'US',
  timeoutMs = process.env.RISK_LOOKUP_TIMEOUT_MS,
} = {}) {
  const input = cleanText(address).slice(0, 280);
  if (!cleanText(apiKey)) return Object.freeze({ status: 'not_configured' });
  if (!input || typeof fetchImpl !== 'function') return Object.freeze({ status: 'error' });

  const url = new URL(GOOGLE_ADDRESS_VALIDATION_URL);
  url.searchParams.set('key', cleanText(apiKey));

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address: {
          regionCode: cleanText(regionCode).toUpperCase() || 'US',
          addressLines: [input],
        },
        enableUspsCass: true,
      }),
      signal: AbortSignal.timeout(boundedTimeout(timeoutMs)),
    });
    const body = await responseJson(response);
    if (!response.ok || !body?.result) return Object.freeze({ status: 'error' });

    const result = body.result;
    const verdict = result.verdict || {};
    const components = result?.address?.addressComponents || [];
    const suspiciousComponent = components.some((component) => (
      cleanText(component?.confirmationLevel) === 'UNCONFIRMED_AND_SUSPICIOUS'
      || component?.unexpected === true
    ));
    const verified = verdict.addressComplete === true
      && VERIFIED_ADDRESS_GRANULARITIES.has(cleanText(verdict.validationGranularity))
      && !suspiciousComponent;

    return Object.freeze({
      status: verified ? 'verified' : 'invalid',
      formattedAddress: cleanText(result?.address?.formattedAddress),
      locality: addressComponent(result, 'locality')
        || cleanText(result?.address?.postalAddress?.locality),
      county: addressComponent(result, 'administrative_area_level_2'),
      state: addressComponent(result, 'administrative_area_level_1')
        || cleanText(result?.address?.postalAddress?.administrativeArea),
      postalCode: addressComponent(result, 'postal_code')
        || cleanText(result?.address?.postalAddress?.postalCode),
      regionCode: cleanText(result?.address?.postalAddress?.regionCode),
      validationGranularity: cleanText(verdict.validationGranularity),
      addressComplete: verdict.addressComplete === true,
    });
  } catch {
    return Object.freeze({ status: 'error' });
  }
}

function canonicalState(value) {
  const state = normalized(value);
  if (!state) return '';
  const abbreviation = state.toUpperCase();
  if (US_STATE_NAMES[abbreviation]) return US_STATE_NAMES[abbreviation];
  return Object.values(US_STATE_NAMES).includes(state) ? state : state;
}

function placeWithoutCounty(value) {
  return normalized(value).replace(/\bcounty\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function serviceAreaMatchesAddress(area, address = {}) {
  const configured = normalized(area);
  if (!configured) return false;

  const configuredState = canonicalState(configured);
  const state = canonicalState(address.state);
  const isStateOnly = configuredState
    && Object.values(US_STATE_NAMES).includes(configuredState)
    && (configured.length === 2 || configured === configuredState);
  if (isStateOnly) return Boolean(state && state === configuredState);

  const postalCode = normalized(address.postalCode);
  if (/^\d{5}(?:\d{4})?$/.test(configured)) {
    return configured === postalCode.replace(/\D/g, '');
  }

  const county = normalized(address.county);
  const countyBase = placeWithoutCounty(address.county);
  const locality = normalized(address.locality);
  return Boolean(
    (county && (configured.includes(county) || county.includes(configured)))
    || (countyBase.length >= 3 && configured.includes(countyBase))
    || (locality.length >= 3 && configured.includes(locality))
  );
}

function configuredServiceAreas(context = {}) {
  const areas = Array.isArray(context.serviceAreas)
    ? context.serviceAreas.map(cleanText).filter(Boolean)
    : [];
  const county = cleanText(context.businessCounty);
  if (county && !areas.some((area) => normalized(area) === normalized(county))) areas.push(county);
  return areas;
}

function resistancePoints(count) {
  if (count >= 6) return 3;
  if (count >= 4) return 2;
  if (count >= 2) return 1;
  return 0;
}

function nameTokens(value) {
  return normalized(value)
    .replace(/\b(?:dr|jr|mr|mrs|ms|sr|ii|iii|iv)\b/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 2);
}

function callerNamesClearlyMismatch(suppliedName, lookupName) {
  const supplied = new Set(nameTokens(suppliedName));
  const lookedUp = nameTokens(lookupName);
  if (!supplied.size || !lookedUp.length) return false;
  return lookedUp.every((token) => !supplied.has(token));
}

function riskLevel(score) {
  if (score >= 9) {
    return { level: 'very_high', label: 'Very high risk', indicator: 'red', emoji: '🔴' };
  }
  if (score >= 6) {
    return { level: 'high', label: 'High risk', indicator: 'orange', emoji: '🟠' };
  }
  if (score >= 3) {
    return { level: 'moderate', label: 'Moderate risk', indicator: 'yellow', emoji: '🟡' };
  }
  return { level: 'low', label: 'Low risk', indicator: 'green', emoji: '🟢' };
}

function factor(code, points, message) {
  return Object.freeze({ code, points, message });
}

export function scoreServiceRequestRisk({
  payload = {},
  context = {},
  phoneLookup = { status: 'failed' },
  addressValidation = { status: 'not_configured' },
  assessedAt = new Date().toISOString(),
} = {}) {
  const factors = [];
  const serviceAreas = configuredServiceAreas(context);
  const addressVerified = addressValidation.status === 'verified';
  const serviceAreaAssessed = addressVerified && serviceAreas.length > 0;
  const addressInsideServiceArea = serviceAreaAssessed
    ? serviceAreas.some((area) => serviceAreaMatchesAddress(area, addressValidation))
    : null;

  if (serviceAreaAssessed && !addressInsideServiceArea) {
    factors.push(factor(
      'outside_service_area',
      1,
      'Service address is outside the configured county or service area.',
    ));
  }

  const addressState = canonicalState(addressValidation.state);
  const phoneState = canonicalState(phoneLookup.state);
  const phoneLocationMismatch = addressVerified
    && phoneLookup.status === 'verified'
    && Boolean(addressState && phoneState && addressState !== phoneState);
  if (phoneLocationMismatch) {
    factors.push(factor(
      'phone_location_mismatch',
      1,
      'Phone-number location does not match the service-address state.',
    ));
  }

  const voip = phoneLookup.status === 'verified' && /voip/.test(phoneLookup.lineType);
  if (voip) factors.push(factor('voip_phone', 1, 'Caller is using a VoIP phone number.'));

  const callerNameAvailable = phoneLookup.status === 'verified'
    && callerNameIsUseful(phoneLookup.callerName);
  if (phoneLookup.status === 'verified' && !callerNameAvailable) {
    factors.push(factor(
      'caller_name_unavailable',
      1,
      'Telnyx returned no useful caller-name information.',
    ));
  }

  const callerNameMismatch = callerNameAvailable
    && callerNamesClearlyMismatch(payload.name || payload.Name, phoneLookup.callerName);
  if (callerNameMismatch) {
    factors.push(factor(
      'caller_name_mismatch',
      2,
      'Telnyx caller name does not match the name supplied for the service request.',
    ));
  }

  if (addressValidation.status === 'invalid') {
    factors.push(factor(
      'address_unverified',
      4,
      'The full service address could not be validated as an actual address.',
    ));
  }

  const customerResistanceCount = Math.max(
    0,
    Math.min(1_000, Math.trunc(Number(payload.customerResistanceCount) || 0)),
  );
  const customerResistancePoints = resistancePoints(customerResistanceCount);
  if (customerResistancePoints) {
    factors.push(factor(
      'customer_resistance',
      customerResistancePoints,
      `Caller resisted required information ${customerResistanceCount} times.`,
    ));
  }

  if (phoneLookup.status !== 'verified') {
    factors.push(factor(
      'phone_lookup_failed',
      4,
      'Phone-number lookup failed or the number appeared invalid.',
    ));
  }

  const score = factors.reduce((total, item) => total + item.points, 0);
  const classification = riskLevel(score);
  const assessment = Object.freeze({
    addressVerified,
    outsideServiceArea: addressInsideServiceArea === false,
    phoneLookupFailed: phoneLookup.status !== 'verified',
    phoneLocationMismatch,
    phoneIsVoip: voip,
    callerNameUnavailable: phoneLookup.status === 'verified' && !callerNameAvailable,
    callerNameMismatch,
    resistanceCount: customerResistanceCount,
  });
  const risk = {
    version: 1,
    score,
    ...classification,
    assessment,
    factors: Object.freeze(factors),
    checks: Object.freeze({
      address: Object.freeze({
        status: addressValidation.status,
        formattedAddress: cleanText(addressValidation.formattedAddress),
        locality: cleanText(addressValidation.locality),
        county: cleanText(addressValidation.county),
        state: cleanText(addressValidation.state),
        postalCode: cleanText(addressValidation.postalCode),
        serviceAreaStatus: addressInsideServiceArea === null
          ? 'not_assessed'
          : (addressInsideServiceArea ? 'inside' : 'outside'),
      }),
      phone: Object.freeze({
        status: phoneLookup.status,
        lineType: cleanText(phoneLookup.lineType),
        carrierName: cleanText(phoneLookup.carrierName),
        callerName: callerNameAvailable ? cleanText(phoneLookup.callerName) : '',
        city: cleanText(phoneLookup.city),
        state: cleanText(phoneLookup.state),
        locationMatchesAddress: phoneLocationMismatch ? false : (
          addressVerified && phoneLookup.status === 'verified' && addressState && phoneState
            ? true
            : null
        ),
        callerNameMatches: callerNameAvailable
          ? !callerNameMismatch
          : null,
      }),
      customerResistance: Object.freeze({
        count: customerResistanceCount,
        points: customerResistancePoints,
      }),
    }),
    assessedAt: cleanText(assessedAt) || new Date().toISOString(),
  };
  return Object.freeze(risk);
}

export async function addRiskAssessmentToServiceRequest({
  payload,
  context,
  phoneLookupPromise,
  fetchImpl = globalThis.fetch,
  googleApiKey = process.env.GOOGLE_MAPS_API_KEY,
  now = () => new Date(),
} = {}) {
  const [phoneLookup, addressValidation] = await Promise.all([
    Promise.resolve(phoneLookupPromise || { status: 'failed' })
      .then((value) => value || { status: 'failed' })
      .catch(() => ({ status: 'failed' })),
    validateGoogleAddress(payload?.address || payload?.Address, {
      fetchImpl,
      apiKey: googleApiKey,
    }),
  ]);
  const risk = scoreServiceRequestRisk({
    payload,
    context,
    phoneLookup,
    addressValidation,
    assessedAt: now().toISOString(),
  });
  const { assessment, ...riskDetails } = risk;
  return Object.freeze({
    ...payload,
    riskAssessment: assessment,
    risk: Object.freeze(riskDetails),
    riskScore: risk.score,
    riskLevel: risk.level,
    riskFactors: risk.factors,
  });
}
