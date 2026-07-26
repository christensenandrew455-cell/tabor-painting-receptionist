import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identifyQuestion,
  nextConsentRefusalAction,
  parsePreferredScheduleAnswer,
} from '../conversation-command-guard.js';

test('classifies the combined date-and-time question as one schedule field', () => {
  assert.deepEqual(
    identifyQuestion('Next, what exact date or upcoming day and time works best for the estimate?'),
    {
      id: 'estimate_schedule',
      field: 'preferredSchedule',
      stage: 'INTAKE',
    },
  );
});

test('classifies the combined project address before individual location fields', () => {
  assert.deepEqual(
    identifyQuestion('What is the project address?'),
    {
      id: 'project_location',
      field: 'projectLocation',
      stage: 'INTAKE',
    },
  );
});

test('captures Monday at four as both the preferred day and time', () => {
  assert.deepEqual(
    parsePreferredScheduleAnswer('Monday at 4', {
      earliest: '9:00 AM',
      latest: '5:00 PM',
    }),
    {
      preferredDateOrDay: 'Monday',
      preferredTime: '4:00 PM',
    },
  );
});

test('keeps an explicit meridiem and exact date', () => {
  assert.deepEqual(
    parsePreferredScheduleAnswer('07/27/2026 at 10:30 AM', {
      earliest: '9:00 AM',
      latest: '5:00 PM',
    }),
    {
      preferredDateOrDay: '07/27/2026',
      preferredTime: '10:30 AM',
    },
  );
});

test('retries consent once and cancels on the second clear refusal', () => {
  assert.deepEqual(nextConsentRefusalAction(0), { refusalCount: 1, cancel: false });
  assert.deepEqual(nextConsentRefusalAction(1), { refusalCount: 2, cancel: true });
});
