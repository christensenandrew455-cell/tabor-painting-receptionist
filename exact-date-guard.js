import { WebSocket } from 'ws';

const previousSend = WebSocket.prototype.send;
const previousEmit = WebSocket.prototype.emit;
const socketStates = new WeakMap();
const WEEKDAYS = Object.freeze({ sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 });

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

function stateFor(socket) {
  if (!socketStates.has(socket)) {
    socketStates.set(socket, {
      timeZone: 'America/New_York',
      currentBusinessDate: '',
      exactScheduleDate: '',
    });
  }
  return socketStates.get(socket);
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value;
  } catch {
    return 'America/New_York';
  }
}

function datePartsInTimeZone(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function normalizeUsDate(value) {
  const match = clean(value).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return '';
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const candidate = `${year}-${String(Number(match[1])).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
  return validIsoDate(candidate) ? candidate : '';
}

function resolveDate(text, state) {
  const input = clean(text).toLowerCase();
  if (!input) return '';
  const baseIso = validIsoDate(state.currentBusinessDate)
    ? state.currentBusinessDate
    : datePartsInTimeZone(state.timeZone);
  const base = new Date(`${baseIso}T12:00:00Z`);

  if (/\btomorrow\b/.test(input)) {
    base.setUTCDate(base.getUTCDate() + 1);
    return base.toISOString().slice(0, 10);
  }

  const weekday = Object.keys(WEEKDAYS).find((name) => new RegExp(`\\b${name}\\b`, 'i').test(input));
  if (weekday) {
    const delta = (WEEKDAYS[weekday] - base.getUTCDay() + 7) % 7 || 7;
    base.setUTCDate(base.getUTCDate() + delta);
    return base.toISOString().slice(0, 10);
  }

  const iso = input.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || '';
  if (validIsoDate(iso)) return iso;
  const us = input.match(/\b\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})\b/)?.[0] || '';
  return normalizeUsDate(us);
}

function dateDisplay(iso) {
  if (!validIsoDate(iso)) return '';
  const [year, month, day] = iso.split('-');
  return `${Number(month)}/${Number(day)}/${year.slice(-2)}`;
}

function sessionFacts(instructions, state) {
  const raw = clean(instructions);
  const zone = raw.match(/^- Time zone:\s*(.+)$/im)?.[1];
  if (zone) state.timeZone = validTimeZone(clean(zone));
  const dateLabel = raw.match(/CURRENT BUSINESS DATE[\s\S]*?current date is\s+(.+?)\s+in\s+/i)?.[1]
    || raw.match(/The current date is\s+(.+?)\s+in\s+/i)?.[1];
  if (dateLabel) {
    const parsed = new Date(dateLabel);
    if (!Number.isNaN(parsed.getTime())) state.currentBusinessDate = datePartsInTimeZone(state.timeZone, parsed);
  }
}

function injectExactDateContext(socket, state, exactDate) {
  if (!exactDate || socket.readyState !== WebSocket.OPEN) return;
  previousSend.call(socket, JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: `Exact schedule date resolved by the server: ${exactDate}. Use ${dateDisplay(exactDate)} when speaking the summary. Use ${exactDate} for preferredDateOrDay in submit_estimate_lead. Never replace it with only a weekday name.`,
      }],
    },
  }));
}

function rewriteToolMessage(message, state) {
  if (message?.type !== 'response.function_call_arguments.done' && message?.type !== 'response.output_item.done') return message;
  const item = message.item || message.output_item || {};
  const name = clean(message.name || item.name);
  if (name !== 'submit_estimate_lead') return message;
  const rawArguments = message.arguments || item.arguments || '{}';
  let args;
  try {
    args = JSON.parse(rawArguments || '{}');
  } catch {
    return message;
  }
  const exactDate = resolveDate(args.preferredDateOrDay, state) || state.exactScheduleDate;
  if (!exactDate) return message;
  state.exactScheduleDate = exactDate;
  args.preferredDateOrDay = exactDate;
  const rewrittenArguments = JSON.stringify(args);
  if (message.arguments !== undefined) return { ...message, arguments: rewrittenArguments };
  if (message.item) return { ...message, item: { ...item, arguments: rewrittenArguments } };
  return { ...message, output_item: { ...item, arguments: rewrittenArguments } };
}

WebSocket.prototype.send = function exactDateSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return previousSend.call(this, data, ...args);
  const message = parseJson(data);
  if (message?.type === 'session.update') sessionFacts(message?.session?.instructions, stateFor(this));
  return previousSend.call(this, data, ...args);
};

WebSocket.prototype.emit = function exactDateEmit(eventName, ...args) {
  if (eventName !== 'message' || !isOpenAiRealtimeSocket(this) || !args[0]) {
    return previousEmit.call(this, eventName, ...args);
  }

  const message = parseJson(args[0]);
  if (!message) return previousEmit.call(this, eventName, ...args);
  const state = stateFor(this);

  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    const exactDate = resolveDate(message.transcript, state);
    if (exactDate) {
      state.exactScheduleDate = exactDate;
      injectExactDateContext(this, state, exactDate);
    }
  }

  const rewritten = rewriteToolMessage(message, state);
  if (rewritten !== message) {
    args[0] = Buffer.from(JSON.stringify(rewritten));
  }
  return previousEmit.call(this, eventName, ...args);
};

console.log('[Exact date guard]', {
  enabled: true,
  behavior: 'resolves spoken weekdays and relative dates without replacing the existing receptionist state machine',
});
