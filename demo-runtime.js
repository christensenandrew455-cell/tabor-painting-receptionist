import { cleanText } from './business-context.js';

export const DEFAULT_DEMO_PHONE_NUMBER = '+17742316164';

export const DEMO_PROFILE = Object.freeze({
  businessName: 'AI Receptionist Demo',
  timeZone: 'America/New_York',
  serviceRequestWeekdays: Object.freeze([]),
  earliestServiceRequestStart: '',
  latestServiceRequestStart: '',
  businessType: '',
  serviceAreas: Object.freeze([]),
  services: Object.freeze({}),
  businessInformation: Object.freeze([]),
});

export function normalizePhoneNumber(value) {
  const raw = cleanText(value).replace(/^tel:/i, '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export function isDemoPhoneNumber(
  calledPhone,
  demoPhoneNumber = process.env.DEMO_PHONE_NUMBER || DEFAULT_DEMO_PHONE_NUMBER,
) {
  const called = normalizePhoneNumber(calledPhone);
  const demo = normalizePhoneNumber(demoPhoneNumber);
  return Boolean(called && demo && called === demo);
}

export function runtimeForCalledPhone(runtime = {}, calledPhone, options = {}) {
  if (!isDemoPhoneNumber(calledPhone, options.demoPhoneNumber)) return runtime;
  return {
    demo: true,
    calledPhone: normalizePhoneNumber(calledPhone),
    profile: {
      ...DEMO_PROFILE,
      serviceRequestWeekdays: [...DEMO_PROFILE.serviceRequestWeekdays],
      serviceAreas: [...DEMO_PROFILE.serviceAreas],
      services: { ...DEMO_PROFILE.services },
      businessInformation: [...DEMO_PROFILE.businessInformation],
    },
  };
}

export function isDemoRuntime(runtime = {}) {
  return runtime?.demo === true;
}

export async function loadRuntimeForCalledPhone(calledPhone, {
  loadAccountRuntime,
  demoPhoneNumber,
} = {}) {
  const demoRuntime = runtimeForCalledPhone(
    {},
    calledPhone,
    { demoPhoneNumber },
  );
  if (isDemoRuntime(demoRuntime)) return demoRuntime;
  if (typeof loadAccountRuntime !== 'function') {
    throw new TypeError('loadAccountRuntime is required for non-demo calls.');
  }
  return loadAccountRuntime();
}
