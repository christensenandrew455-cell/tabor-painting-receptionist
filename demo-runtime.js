import { cleanText } from './business-context.js';

export const DEFAULT_DEMO_PHONE_NUMBER = '+17742316164';

export const DEMO_PROFILE = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  estimateWeekdays: Object.freeze([
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ]),
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:30 PM',
  businessType: 'Painting company',
  serviceAreas: Object.freeze(['Massachusetts']),
  services: Object.freeze({
    'Interior Painting': 'Interior painting services.',
    'Exterior Painting': 'Exterior painting services.',
    'Wood Staining': 'Wood staining services.',
  }),
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
    ...runtime,
    demo: true,
    calledPhone: normalizePhoneNumber(calledPhone),
    profile: {
      ...DEMO_PROFILE,
      estimateWeekdays: [...DEMO_PROFILE.estimateWeekdays],
      serviceAreas: [...DEMO_PROFILE.serviceAreas],
      services: { ...DEMO_PROFILE.services },
      businessInformation: [...DEMO_PROFILE.businessInformation],
    },
  };
}
