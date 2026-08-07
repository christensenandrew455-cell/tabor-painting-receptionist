import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReceptionistInstructions,
  ESTIMATE_TOOLS,
} from '../openai-receptionist.js';

const CONTEXT = Object.freeze({
  businessName: 'Tabor Painting',
  timeZone: 'America/New_York',
  clientId: 'client-123',
  estimateWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  earliestEstimateStart: '09:00',
  latestEstimateStart: '16:00',
  services: [{ name: 'Interior Painting', description: 'Walls and ceilings' }],
  knowledgeJson: '{"businessHours":"Monday through Friday"}',
});

test('locks the August 7 conversational intake regressions', () => {
  const prompt = buildReceptionistInstructions(CONTEXT);

  assert.match(prompt, /5-out-of-10 conversational level/i);
  assert.match(prompt, /exactly one spoken utterance per caller turn/i);
  assert.match(prompt, /do not assume they want an estimate/i);
  assert.match(prompt, /Are you looking to request an estimate, or do you have a question about the business/i);
  assert.match(prompt, /do not say "that sounds like," "sounds like," "it sounds like,"/i);
  assert.match(prompt, /Do not create a separate transition message/i);
  assert.match(prompt, /let me take a moment/i);
  assert.match(prompt, /do not repeat the full date and time back/i);
  assert.match(prompt, /Do not say "I've got Monday at 3:00 PM"/i);
  assert.match(prompt, /not "Bobby, 197 Lancaster Road"/i);
  assert.match(prompt, /not "197 Lancaster Road, Berlin, MA"/i);
  assert.match(prompt, /The first spoken word must be "I'm"/i);
  assert.match(prompt, /Do not say "Great," "Okay," "Thanks," or anything else before it/i);
});

test('estimate tool descriptions preserve caller-provided values', () => {
  const prepare = ESTIMATE_TOOLS.find((tool) => tool.name === 'prepare_estimate_summary');
  const submit = ESTIMATE_TOOLS.find((tool) => tool.name === 'submit_estimate_request');

  assert.match(
    prepare.parameters.properties.address.description,
    /Never add a person name, label, inferred word, abbreviation, or other text/i,
  );
  assert.match(
    prepare.parameters.properties.additional_notes.description,
    /do not embellish or invent details/i,
  );
  assert.match(submit.description, /first spoken word must be "I'm"/i);
  assert.match(submit.description, /Do not say "Great," "Okay," "Thanks,"/i);
});
