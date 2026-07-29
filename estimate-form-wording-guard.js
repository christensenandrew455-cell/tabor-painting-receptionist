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
    .replace(/What is your full project address\?/gi, 'I need the full address for the project.')
    .replace(/What is the project address\? Please say it in this order: street number, street name, city or town, and state\./gi, 'I need the full address for the project.')
    .replace(/What is the project address\? Please (?:give me|include) the city or town, state, street number, and street name\./gi, 'I need the full address for the project.')
    .replace(/full project address/gi, 'the address')
    .replace(/full address/gi, 'the address');
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
  behavior: 'applies final caller-facing wording without changing the receptionist state machine',
});
