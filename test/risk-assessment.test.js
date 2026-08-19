import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addRiskAssessmentToServiceRequest,
  lookupTelnyxPhoneNumber,
  scoreServiceRequestRisk,
  validateGoogleAddress,
} from '../risk-assessment.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

const VERIFIED_ADDRESS = Object.freeze({
  status: 'verified',
  formattedAddress: '123 Main Street, Albany, NY 12207, USA',
  locality: 'Albany',
  county: 'Albany County',
  state: 'NY',
  postalCode: '12207',
});

const VERIFIED_PHONE = Object.freeze({
  status: 'verified',
  lineType: 'wireless',
  carrierName: 'Example Wireless',
  callerName: 'Jordan Smith',
  city: 'Albany',
  state: 'NY',
});

test('Telnyx lookup requests carrier and caller-name data and keeps the fraud fields', async () => {
  let request;
  const result = await lookupTelnyxPhoneNumber('+15185550123', {
    apiKey: 'test-telnyx-key',
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return jsonResponse({
        data: {
          record_type: 'number_lookup',
          phone_number: '+15185550123',
          carrier: {
            type: 'voip',
            normalized_carrier: 'Example Carrier',
          },
          caller_name: { caller_name: 'Jordan Smith' },
          portability: {
            city: 'Albany',
            state: 'NY',
            line_type: 'wireless',
          },
        },
      });
    },
  });

  assert.equal(request.url.pathname, '/v2/number_lookup/%2B15185550123');
  assert.deepEqual(request.url.searchParams.getAll('type'), ['carrier', 'caller-name']);
  assert.equal(request.options.headers.Authorization, 'Bearer test-telnyx-key');
  assert.equal(result.status, 'verified');
  assert.equal(result.lineType, 'voip');
  assert.equal(result.carrierName, 'Example Carrier');
  assert.equal(result.callerName, 'Jordan Smith');
  assert.equal(result.city, 'Albany');
  assert.equal(result.state, 'NY');
});

test('Telnyx lookup fails closed for an invalid caller number without making a request', async () => {
  let called = false;
  const result = await lookupTelnyxPhoneNumber('anonymous', {
    apiKey: 'test-telnyx-key',
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });

  assert.deepEqual(result, { status: 'failed' });
  assert.equal(called, false);
});

test('Google Address Validation verifies a premise and returns area components', async () => {
  let request;
  const result = await validateGoogleAddress('123 Main Street, Albany, NY 12207', {
    apiKey: 'test-google-key',
    regionCode: 'US',
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return jsonResponse({
        result: {
          verdict: {
            addressComplete: true,
            validationGranularity: 'PREMISE',
          },
          address: {
            formattedAddress: '123 Main Street, Albany, NY 12207-1000, USA',
            postalAddress: {
              locality: 'Albany',
              administrativeArea: 'NY',
              postalCode: '12207-1000',
              regionCode: 'US',
            },
            addressComponents: [
              {
                componentType: 'locality',
                componentName: { text: 'Albany' },
                confirmationLevel: 'CONFIRMED',
              },
              {
                componentType: 'administrative_area_level_2',
                componentName: { text: 'Albany County' },
                confirmationLevel: 'CONFIRMED',
              },
              {
                componentType: 'administrative_area_level_1',
                componentName: { text: 'New York' },
                confirmationLevel: 'CONFIRMED',
              },
              {
                componentType: 'postal_code',
                componentName: { text: '12207-1000' },
                confirmationLevel: 'CONFIRMED',
              },
            ],
          },
        },
      });
    },
  });

  assert.equal(request.url.origin, 'https://addressvalidation.googleapis.com');
  assert.equal(request.url.searchParams.get('key'), 'test-google-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    address: {
      regionCode: 'US',
      addressLines: ['123 Main Street, Albany, NY 12207'],
    },
    enableUspsCass: true,
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.county, 'Albany County');
  assert.equal(result.state, 'New York');
  assert.equal(result.postalCode, '12207-1000');
});

test('Google validation distinguishes an invalid address from an unconfigured check', async () => {
  const invalid = await validateGoogleAddress('Not a real address', {
    apiKey: 'test-google-key',
    fetchImpl: async () => jsonResponse({
      result: {
        verdict: {
          addressComplete: false,
          validationGranularity: 'OTHER',
        },
        address: { addressComponents: [] },
      },
    }),
  });
  assert.equal(invalid.status, 'invalid');

  let called = false;
  const notConfigured = await validateGoogleAddress('123 Main Street', {
    apiKey: '',
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  assert.deepEqual(notConfigured, { status: 'not_configured' });
  assert.equal(called, false);
});

test('a fully verified request has zero points and no warning factors', () => {
  const risk = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith', customerResistanceCount: 1 },
    context: { serviceAreas: ['Albany, New York'] },
    phoneLookup: VERIFIED_PHONE,
    addressValidation: VERIFIED_ADDRESS,
    assessedAt: '2026-08-18T12:00:00.000Z',
  });

  assert.equal(risk.version, 1);
  assert.equal(risk.score, 0);
  assert.equal(risk.level, 'low');
  assert.equal(risk.emoji, '🟢');
  assert.deepEqual(risk.factors, []);
  assert.deepEqual(risk.assessment, {
    addressVerified: true,
    outsideServiceArea: false,
    phoneLookupFailed: false,
    phoneLocationMismatch: false,
    phoneIsVoip: false,
    callerNameUnavailable: false,
    callerNameMismatch: false,
    resistanceCount: 1,
  });
  assert.equal(risk.checks.address.serviceAreaStatus, 'inside');
  assert.equal(risk.checks.phone.locationMatchesAddress, true);
  assert.equal(risk.checks.phone.callerNameMatches, true);
});

test('multiple-state service areas accept any selected state and reject unselected states', () => {
  const context = {
    serviceAreas: ['Massachusetts', 'New York'],
    serviceAreaMode: 'states',
    serviceAreaStates: ['Massachusetts', 'New York'],
    serviceAreaCounties: [],
  };
  const inside = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    context,
    phoneLookup: VERIFIED_PHONE,
    addressValidation: VERIFIED_ADDRESS,
  });
  const outside = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    context,
    phoneLookup: { ...VERIFIED_PHONE, state: 'NJ' },
    addressValidation: { ...VERIFIED_ADDRESS, state: 'New Jersey' },
  });

  assert.equal(inside.checks.address.serviceAreaStatus, 'inside');
  assert.equal(inside.assessment.outsideServiceArea, false);
  assert.equal(outside.checks.address.serviceAreaStatus, 'outside');
  assert.equal(outside.assessment.outsideServiceArea, true);
  assert.equal(outside.factors.some((item) => item.code === 'outside_service_area'), true);
});

test('one-state county mode requires both the selected state and one selected county', () => {
  const context = {
    serviceAreas: ['Massachusetts', 'Worcester County', 'Middlesex County'],
    serviceAreaMode: 'counties',
    serviceAreaStates: ['Massachusetts'],
    serviceAreaCounties: ['Worcester County', 'Middlesex County'],
  };
  const phoneLookup = { ...VERIFIED_PHONE, state: 'MA' };
  const inside = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    context,
    phoneLookup,
    addressValidation: { ...VERIFIED_ADDRESS, state: 'Massachusetts', county: 'Worcester County' },
  });
  const outsideCounty = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    context,
    phoneLookup,
    addressValidation: { ...VERIFIED_ADDRESS, state: 'Massachusetts', county: 'Hampden County' },
  });
  const outsideState = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    context,
    phoneLookup: VERIFIED_PHONE,
    addressValidation: VERIFIED_ADDRESS,
  });

  assert.equal(inside.checks.address.serviceAreaStatus, 'inside');
  assert.equal(outsideCounty.checks.address.serviceAreaStatus, 'outside');
  assert.equal(outsideState.checks.address.serviceAreaStatus, 'outside');
});

test('legacy flat one-state service areas still treat a plain area name as a county restriction', () => {
  const risk = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    context: { serviceAreas: ['Massachusetts', 'Worcester'] },
    phoneLookup: { ...VERIFIED_PHONE, state: 'MA' },
    addressValidation: { ...VERIFIED_ADDRESS, state: 'Massachusetts', county: 'Hampden County' },
  });

  assert.equal(risk.checks.address.serviceAreaStatus, 'outside');
});

test('risk classifications use the requested 0–2, 3–5, 6–8, and 9+ boundaries', () => {
  const low = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    phoneLookup: { ...VERIFIED_PHONE, lineType: 'voip', callerName: '' },
    addressValidation: VERIFIED_ADDRESS,
  });
  assert.equal(low.score, 2);
  assert.equal(low.level, 'low');

  const moderate = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith', customerResistanceCount: 2 },
    phoneLookup: { ...VERIFIED_PHONE, lineType: 'voip', callerName: '' },
    addressValidation: VERIFIED_ADDRESS,
  });
  assert.equal(moderate.score, 3);
  assert.equal(moderate.level, 'moderate');
  assert.equal(moderate.emoji, '🟡');

  const high = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith', customerResistanceCount: 2 },
    context: { serviceAreas: ['Worcester County'] },
    phoneLookup: {
      ...VERIFIED_PHONE,
      lineType: 'voip',
      callerName: 'Alex Taylor',
      state: 'NY',
    },
    addressValidation: {
      ...VERIFIED_ADDRESS,
      locality: 'Springfield',
      county: 'Hampden County',
      state: 'Massachusetts',
    },
  });
  assert.equal(high.score, 6);
  assert.equal(high.level, 'high');
  assert.equal(high.emoji, '🟠');
  assert.deepEqual(high.factors.map((item) => [item.code, item.points]), [
    ['outside_service_area', 1],
    ['phone_location_mismatch', 1],
    ['voip_phone', 1],
    ['caller_name_mismatch', 2],
    ['customer_resistance', 1],
  ]);
  assert.deepEqual(high.assessment, {
    addressVerified: true,
    outsideServiceArea: true,
    phoneLookupFailed: false,
    phoneLocationMismatch: true,
    phoneIsVoip: true,
    callerNameUnavailable: false,
    callerNameMismatch: true,
    resistanceCount: 2,
  });

  const veryHigh = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith', customerResistanceCount: 2 },
    phoneLookup: { status: 'failed' },
    addressValidation: { status: 'invalid' },
  });
  assert.equal(veryHigh.score, 9);
  assert.equal(veryHigh.level, 'very_high');
  assert.equal(veryHigh.emoji, '🔴');
  assert.deepEqual(veryHigh.factors.map((item) => [item.code, item.points]), [
    ['address_unverified', 4],
    ['customer_resistance', 1],
    ['phone_lookup_failed', 4],
  ]);
});

test('customer resistance uses the exact requested count bands', () => {
  const pointsFor = (customerResistanceCount) => scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith', customerResistanceCount },
    phoneLookup: VERIFIED_PHONE,
    addressValidation: VERIFIED_ADDRESS,
  }).checks.customerResistance.points;

  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 12].map(pointsFor),
    [0, 0, 1, 1, 2, 2, 3, 3],
  );
});

test('an unavailable Google key does not falsely add an invalid-address warning', () => {
  const risk = scoreServiceRequestRisk({
    payload: { name: 'Jordan Smith' },
    context: { serviceAreas: ['Worcester County'] },
    phoneLookup: VERIFIED_PHONE,
    addressValidation: { status: 'not_configured' },
  });

  assert.equal(risk.score, 0);
  assert.equal(risk.checks.address.status, 'not_configured');
  assert.equal(risk.checks.address.serviceAreaStatus, 'not_assessed');
  assert.equal(risk.factors.some((item) => item.code === 'address_unverified'), false);
});

test('the receptionist enriches the service-request payload before ARC delivery', async () => {
  const result = await addRiskAssessmentToServiceRequest({
    payload: {
      type: 'service_request',
      name: 'Jordan Smith',
      address: '123 Main Street, Albany, NY 12207',
      customerResistanceCount: 0,
    },
    context: { serviceAreas: ['Albany County'] },
    phoneLookupPromise: Promise.resolve(VERIFIED_PHONE),
    googleApiKey: 'test-google-key',
    now: () => new Date('2026-08-18T12:00:00.000Z'),
    fetchImpl: async () => jsonResponse({
      result: {
        verdict: {
          addressComplete: true,
          validationGranularity: 'PREMISE',
        },
        address: {
          formattedAddress: VERIFIED_ADDRESS.formattedAddress,
          postalAddress: {
            locality: VERIFIED_ADDRESS.locality,
            administrativeArea: VERIFIED_ADDRESS.state,
            postalCode: VERIFIED_ADDRESS.postalCode,
            regionCode: 'US',
          },
          addressComponents: [
            {
              componentType: 'administrative_area_level_2',
              componentName: { text: VERIFIED_ADDRESS.county },
              confirmationLevel: 'CONFIRMED',
            },
          ],
        },
      },
    }),
  });

  assert.equal(result.type, 'service_request');
  assert.equal(result.riskScore, 0);
  assert.equal(result.riskLevel, 'low');
  assert.equal(result.risk.assessedAt, '2026-08-18T12:00:00.000Z');
  assert.deepEqual(result.riskAssessment, {
    addressVerified: true,
    outsideServiceArea: false,
    phoneLookupFailed: false,
    phoneLocationMismatch: false,
    phoneIsVoip: false,
    callerNameUnavailable: false,
    callerNameMismatch: false,
    resistanceCount: 0,
  });
  assert.deepEqual(result.riskFactors, []);
});
