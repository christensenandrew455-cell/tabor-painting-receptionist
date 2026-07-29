import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConfirmedSummarySaveInstructions,
  shouldTriggerConfirmedSummarySave,
} from '../summary-save-guard.js';

test('only triggers the save after an affirmative final-summary confirmation', () => {
  assert.equal(shouldTriggerConfirmedSummarySave({ awaitingSummaryConfirmation: true, transcript: 'Yes, that is correct' }), true);
  assert.equal(shouldTriggerConfirmedSummarySave({ awaitingSummaryConfirmation: true, transcript: 'No, the date is wrong' }), false);
  assert.equal(shouldTriggerConfirmedSummarySave({ awaitingSummaryConfirmation: false, transcript: 'Yes' }), false);
});

test('builds one complete submit command without caller ID or email', () => {
  const instructions = buildConfirmedSummarySaveInstructions({
    fullName: 'Taylor Morgan',
    serviceType: 'interior painting',
    cityOrTown: 'Example City',
    state: 'Massachusetts',
    streetNumber: '12',
    streetName: 'Main Street',
    preferredDateOrDay: 'Tuesday',
    preferredTime: '4:30 PM',
    additionalNotes: '',
    contactConsent: true,
  });
  assert.match(instructions, /submit the estimate request now/i);
  assert.match(instructions, /submit_estimate_lead exactly once/i);
  assert.match(instructions, /"contactConsent":true/);
  assert.doesNotMatch(instructions, /callerPhone|email/i);
});
