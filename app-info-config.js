// Reference map for business information supplied by ARK Websites OCM.
// This file does not control live call behavior yet.

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

export function describeAppInfo(profile = {}) {
  return {
    businessName: profile.businessName || '',
    receptionistName: profile.receptionistName || '',
    ownerName: profile.ownerName || '',
    businessPhone: profile.businessPhone || '',
    businessEmail: profile.businessEmail || '',
    businessHours: profile.businessHours || '',
    timeZone: profile.timeZone || '',
    estimateDays: profile.estimateDays || '',
    estimateWeekdays: Array.isArray(profile.estimateWeekdays) ? profile.estimateWeekdays : [],
    earliestEstimateStart: profile.earliestEstimateStart || '',
    latestEstimateStart: profile.latestEstimateStart || '',
    businessBase: profile.businessBase || '',
    serviceAreas: Array.isArray(profile.serviceAreas) ? profile.serviceAreas : [],
    services: profile.services || {},
    about: Array.isArray(profile.about) ? profile.about : [],
    openingLine: profile.openingLine || '',
    closingLine: profile.closingLine || '',
    extraInformation: profile.extraInformation || '',
    aiModel: profile.aiModel || '',
    aiVoice: profile.aiVoice || '',
    aiSpeechSpeed: profile.aiSpeechSpeed || '',
    aiSilenceMs: profile.aiSilenceMs || '',
  };
}
