import { HARD_CODED_RECEPTIONIST_SCRIPT } from '../receptionist-script.js';

process.env.AI_MODEL = 'gpt-realtime-mini';
process.env.AI_SILENCE_MS ||= '1200';
process.env.AI_SPEECH_SPEED ||= '0.94';
process.env.AI_VOICE ||= 'alloy';
process.env.OCM_CLIENT_ID ||= 'example-painting';
process.env.PUBLIC_URL ||= 'https://example-receptionist.example.com';
process.env.BUSINESS_INFO ||= JSON.stringify({
  name: 'Example Painting',
  receptionist: 'Alex',
  owner: 'Example Owner',
  phone: '(555) 555-0100',
  email: 'hello@example.com',
  hours: 'Monday through Friday, 8 AM to 5 PM',
  timeZone: 'America/New_York',
  estimateDays: 'Monday through Friday',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '9:00 AM',
  latestEstimateStart: '4:30 PM',
  base: 'Example City',
  serviceAreas: ['Example State'],
  services: {
    'interior painting': 'Interior painting services.',
    'exterior painting': 'Exterior painting services.',
  },
  about: ['Example Painting provides residential painting services.'],
  openingLine: 'Hi, this is {{receptionist_name}} with {{business_name}}. Can I set you up with an estimate today?',
  closingLine: '{{owner_first_name}} will follow up with you shortly. Thanks for calling {{business_name}}. Goodbye.',
  extraInformation: 'Project details are confirmed during the estimate.',
});
process.env.RECEPTIONIST_SCRIPT = HARD_CODED_RECEPTIONIST_SCRIPT;
