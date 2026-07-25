import { WebSocket } from 'ws';

const originalSend = WebSocket.prototype.send;

function clean(value) {
  return String(value || '').trim();
}

function parseJson(value) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  } catch {
    return null;
  }
}

function isOpenAiRealtimeSocket(socket) {
  return clean(socket?.url || socket?._url).includes('api.openai.com/v1/realtime');
}

function withoutCallerEmailProperty(properties = {}) {
  return Object.fromEntries(
    Object.entries(properties).filter(([name]) => !['email', 'callerEmail', 'emailAddress'].includes(name)),
  );
}

export function sanitizeSubmitLeadTool(tool = {}) {
  const functionStyle = tool?.function && typeof tool.function === 'object';
  const definition = functionStyle ? tool.function : tool;
  if (definition?.name !== 'submit_estimate_lead') return tool;

  const parameters = definition.parameters || {};
  const properties = withoutCallerEmailProperty(parameters.properties || {});
  const contactMethod = properties.contactMethod;
  if (contactMethod && Array.isArray(contactMethod.enum)) {
    properties.contactMethod = {
      ...contactMethod,
      enum: contactMethod.enum.filter((value) => !/^e-?mail$/i.test(clean(value))),
    };
  }

  const sanitizedDefinition = {
    ...definition,
    parameters: {
      ...parameters,
      properties,
      required: Array.isArray(parameters.required)
        ? parameters.required.filter((name) => !['email', 'callerEmail', 'emailAddress'].includes(name))
        : parameters.required,
    },
  };

  return functionStyle
    ? { ...tool, function: sanitizedDefinition }
    : sanitizedDefinition;
}

export function sanitizeReceptionistInstructions(value = '') {
  const raw = String(value || '');
  const withoutLegacyEmailDirections = raw
    .replace(/^.*Send email as an empty string.*(?:\r?\n|$)/gim, '')
    .replace(/^.*optional caller email address.*(?:\r?\n|$)/gim, '')
    .trimEnd();

  const callerEmailRule = [
    'CALLER EMAIL — FORBIDDEN',
    '- Never ask for, collect, confirm, repeat, or offer to add the caller’s email address.',
    '- The caller’s contact method must be call or text only.',
    '- Do not include an email field when submitting an estimate lead.',
  ].join('\n');

  if (/CALLER EMAIL — FORBIDDEN/i.test(withoutLegacyEmailDirections)) {
    return withoutLegacyEmailDirections;
  }
  return `${withoutLegacyEmailDirections}\n\n${callerEmailRule}`.trim();
}

export function sanitizeSessionUpdate(message = {}) {
  if (message?.type !== 'session.update' || !message.session) return message;

  const session = { ...message.session };
  session.instructions = sanitizeReceptionistInstructions(session.instructions);
  if (Array.isArray(session.tools)) {
    session.tools = session.tools.map(sanitizeSubmitLeadTool);
  }

  const transcription = session?.audio?.input?.transcription;
  if (transcription?.prompt) {
    session.audio = {
      ...session.audio,
      input: {
        ...session.audio.input,
        transcription: {
          ...transcription,
          prompt: String(transcription.prompt)
            .replace(/\bemail addresses?,?\s*/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim(),
        },
      },
    };
  }

  return { ...message, session };
}

WebSocket.prototype.send = function callerEmailGuardedSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return originalSend.call(this, data, ...args);

  const message = parseJson(data);
  if (message?.type !== 'session.update') return originalSend.call(this, data, ...args);

  const sanitized = sanitizeSessionUpdate(message);
  console.log('[Caller email guard]', {
    enabled: true,
    behavior: 'caller email removed from receptionist instructions and lead tool',
  });
  return originalSend.call(this, JSON.stringify(sanitized), ...args);
};
