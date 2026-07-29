import { WebSocket } from 'ws';

const previousSend = WebSocket.prototype.send;

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

export function rewriteEstimateFormWording(value = '') {
  return String(value || '')
    .replace(/Would you like me to help you submit an estimate request\?/gi, 'Would you like to fill out an estimate request form?')
    .replace(/Would you like to submit an estimate request\?/gi, 'Would you like to fill out an estimate request form?')
    .replace(/Would you like to set up an estimate\?/gi, 'Would you like to fill out an estimate request form?')
    .replace(/Okay, great\. I['’]ll collect your name, the service you need, the project address, your preferred estimate date and time, and any optional notes\. Let['’]s get started\./gi, "I just need a couple of details. Let's get started.")
    .replace(/2\. Ask exactly: "\$\{q\.service_type\.text\}"[\s\S]*?3\. Ask exactly: "\$\{q\.project_location\.text\}"/g,
      '2. Ask exactly: "${q.project_location.text}"\nTreat one normal answer as capable of supplying street number, street name, city or town, and state. Extract and retain every part the caller actually provides. If a part is missing or unclear, ask only for the missing part, one question at a time. Never fill in or guess a missing address part.\n3. Ask exactly: "${q.service_type.text}"')
    .replace(/What is your full project address\?/gi, 'I need the full address for the project.')
    .replace(/What is the project address\? Please say it in this order: street number, street name, city or town, and state\./gi, 'I need the full address for the project.')
    .replace(/What is the project address\? Please (?:give me|include) the city or town, state, street number, and street name\./gi, 'I need the full address for the project.')
    .replace(/summary of the caller's full address/gi, 'summary of the address')
    .replace(/summarize the caller's full address/gi, 'summarize the address')
    .replace(/Ask one natural question at a time and stop to listen\./gi, 'Ask one natural question at a time and stop to listen. Follow this intake order: full name, full project address, service, preferred date and time, additional notes, consent, confirmation, save.')
    .replace(/Never ask again for information that has already been collected\./gi, 'Never ask again for information that has already been collected. If the caller asks a business question, answer it briefly using the configured business information, then return to the same unanswered intake question.')
    .replace(/When waiting for the caller, remain silent\./gi, 'When waiting for the caller, remain silent. Never interrupt or talk over the caller. Wait for a complete caller turn and clear silence before responding.');
}

function rewriteMessage(message) {
  if (message?.type === 'session.update' && message.session) {
    return {
      ...message,
      session: {
        ...message.session,
        instructions: rewriteEstimateFormWording(message.session.instructions),
      },
    };
  }

  if (message?.type === 'response.create' && message.response) {
    return {
      ...message,
      response: {
        ...message.response,
        instructions: rewriteEstimateFormWording(message.response.instructions),
      },
    };
  }

  if (message?.type === 'conversation.item.create' && message?.item?.role === 'system') {
    const content = Array.isArray(message.item.content) ? message.item.content : [];
    return {
      ...message,
      item: {
        ...message.item,
        content: content.map((entry) => entry?.type === 'input_text'
          ? { ...entry, text: rewriteEstimateFormWording(entry.text) }
          : entry),
      },
    };
  }

  return message;
}

WebSocket.prototype.send = function estimateFormWordingSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return previousSend.call(this, data, ...args);
  const message = parseJson(data);
  if (!message) return previousSend.call(this, data, ...args);
  return previousSend.call(this, JSON.stringify(rewriteMessage(message)), ...args);
};

console.log('[Estimate form wording guard]', {
  enabled: true,
  behavior: 'keeps the existing state machine, uses name-address-service scheduling order, prevents repeated questions, resumes after caller questions, and avoids talking over callers',
});
