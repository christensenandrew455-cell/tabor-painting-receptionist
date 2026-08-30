import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUMMARY_MODEL,
  buildSummaryRequest,
  createServiceRequestSummarizer,
  normalizeSummaryFields,
  parseSummaryResponse,
  summaryInput,
} from '../service-request-summary.js';

const DRAFT = Object.freeze({
  service: 'Exterior Painting',
  name: 'Jordan Smith',
  address: '123 Main Street, Albany, New York',
  preferred_date: 'August 11 2099',
  preferred_time: '2 PM',
  additional_notes: 'Uh, the rear siding is peeling, and, you know, the back gate is locked.',
});

const SOURCE = Object.freeze({
  understoodCallerTurns: [
    'I need the exterior of my house painted.',
    'The rear siding is peeling, and the back gate is locked.',
  ],
  callerTranscripts: [
    'I need the exterior of my house painted.',
    'Uh the rear siding is pealing and you know the back gate is locked.',
  ],
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('the Luna request uses strict structured output and the complete caller evidence', () => {
  const request = buildSummaryRequest({ draft: DRAFT, source: SOURCE });
  assert.equal(request.model, DEFAULT_SUMMARY_MODEL);
  assert.deepEqual(request.reasoning, { effort: 'none' });
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.required, ['service_label', 'notes_summary']);

  const input = JSON.parse(request.input[1].content);
  assert.equal(input.mode, 'regular');
  assert.equal(input.verified_service, 'Exterior Painting');
  assert.deepEqual(input.live_audio_interpretations, SOURCE.understoodCallerTurns);
  assert.deepEqual(input.sidecar_asr_transcripts, SOURCE.callerTranscripts);
  assert.equal(input.structured_fields_read_separately.name, 'Jordan Smith');
  assert.match(request.input[0].content, /live-audio interpretations as the primary evidence/i);
  assert.match(request.input[0].content, /Do not include the caller name, service address, preferred date or time/i);
});

test('regular summaries cannot replace the configured service', () => {
  const summary = parseSummaryResponse({
    output_text: JSON.stringify({
      service_label: 'Lawn mowing',
      notes_summary: 'Rear siding is peeling. The back gate is locked.',
    }),
  }, { draft: DRAFT, demo: false });

  assert.deepEqual(summary, {
    service: 'Exterior Painting',
    notes: 'Rear siding is peeling. The back gate is locked.',
  });
});

test('demo summaries use a concise generated service and normalize empty notes', () => {
  assert.deepEqual(normalizeSummaryFields({
    service_label: 'Burst pipe repair.',
    notes_summary: 'No additional notes.',
  }, { draft: {}, demo: true }), {
    service: 'Burst pipe repair',
    notes: '',
  });
});

test('summary input keeps structured fields separate from summarizable project evidence', () => {
  const input = summaryInput({ draft: DRAFT, source: SOURCE });
  assert.equal(input.current_project_notes, DRAFT.additional_notes);
  assert.equal(input.structured_fields_read_separately.address, DRAFT.address);
  assert.equal(input.structured_fields_read_separately.preferred_time, '2 PM');
});

test('the dedicated summarizer retries a temporary Responses API failure once', async () => {
  const requests = [];
  const summarize = createServiceRequestSummarizer({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        return jsonResponse(500, { error: { message: 'temporary failure' } });
      }
      return jsonResponse(200, {
        output_text: JSON.stringify({
          service_label: 'Exterior Painting',
          notes_summary: 'Rear siding is peeling. The back gate is locked.',
        }),
      });
    },
  });

  const result = await summarize({ draft: DRAFT, source: SOURCE });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(requests[0].options.body).model, DEFAULT_SUMMARY_MODEL);
  assert.deepEqual(result, {
    service: 'Exterior Painting',
    notes: 'Rear siding is peeling. The back gate is locked.',
  });
});

test('the dedicated summarizer does not retry a non-retryable request error', async () => {
  let attempts = 0;
  const summarize = createServiceRequestSummarizer({
    apiKey: 'test-key',
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse(400, { error: { message: 'invalid request' } });
    },
  });

  await assert.rejects(
    summarize({ draft: DRAFT, source: SOURCE }),
    /invalid request/i,
  );
  assert.equal(attempts, 1);
});
