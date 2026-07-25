import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeReceptionistInstructions,
  sanitizeSessionUpdate,
  sanitizeSubmitLeadTool,
} from '../caller-email-guard.js';

test('removes caller email from the estimate lead tool', () => {
  const tool = sanitizeSubmitLeadTool({
    type: 'function',
    name: 'submit_estimate_lead',
    parameters: {
      type: 'object',
      properties: {
        fullName: { type: 'string' },
        email: { type: 'string', description: 'Optional caller email address.' },
        contactMethod: { type: 'string', enum: ['call', 'text', 'email'] },
      },
      required: ['fullName', 'email', 'contactMethod'],
    },
  });

  assert.equal(tool.parameters.properties.email, undefined);
  assert.deepEqual(tool.parameters.properties.contactMethod.enum, ['call', 'text']);
  assert.deepEqual(tool.parameters.required, ['fullName', 'contactMethod']);
});

test('replaces legacy email directions with an explicit prohibition', () => {
  const instructions = sanitizeReceptionistInstructions([
    'Follow the intake script.',
    '- Send email as an empty string when the caller declined it.',
  ].join('\n'));

  assert.doesNotMatch(instructions, /send email as an empty string/i);
  assert.match(instructions, /never ask for, collect, confirm, repeat, or offer to add the caller’s email address/i);
  assert.match(instructions, /call or text only/i);
});

test('sanitizes the complete realtime session update', () => {
  const message = sanitizeSessionUpdate({
    type: 'session.update',
    session: {
      instructions: 'Send email as an empty string when declined.',
      tools: [{
        type: 'function',
        name: 'submit_estimate_lead',
        parameters: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            contactMethod: { type: 'string', enum: ['call', 'text', 'email'] },
          },
          required: ['email', 'contactMethod'],
        },
      }],
      audio: {
        input: {
          transcription: {
            prompt: 'Natural phone calls: names, email addresses, service requests, towns, and times.',
          },
        },
      },
    },
  });

  assert.equal(message.session.tools[0].parameters.properties.email, undefined);
  assert.deepEqual(message.session.tools[0].parameters.properties.contactMethod.enum, ['call', 'text']);
  assert.doesNotMatch(message.session.audio.input.transcription.prompt, /email/i);
  assert.match(message.session.instructions, /CALLER EMAIL — FORBIDDEN/);
});
