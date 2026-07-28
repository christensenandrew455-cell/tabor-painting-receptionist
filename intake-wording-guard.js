import { WebSocket } from 'ws';

const previousSend = WebSocket.prototype.send;

const STATE_MARKER = 'CURRENT TURN WORDING COMMANDS';
const SESSION_MARKER = 'STRICT INTAKE WORDING RULES';

const RETRY_QUESTIONS = Object.freeze({
  fullName: 'What is your first and last name?',
  serviceType: 'What service were you looking for?',
  projectLocation: 'What is the project address? Please say it in this order: street number, street name, city or town, and state.',
  cityOrTown: 'What city or town is the project in?',
  state: 'What state is the project in?',
  streetNumber: 'What is the street number?',
  streetName: 'What is the street name?',
  preferredSchedule: 'What day works best for you, and what time?',
  preferredDateOrDay: 'What day works best for you?',
  preferredTime: 'What time works best for you?',
  additionalNotesRequested: 'Do you have any additional notes for the business?',
  additionalNotes: 'What additional notes would you like me to include?',
  contactConsent: 'Do you agree to be contacted about this estimate request?',
});

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

function fieldFromState(value) {
  const source = clean(value);
  const lastQuestion = source.match(/^Last question:\s*(.+)$/im)?.[1]?.trim() || '';
  if (/project address/i.test(lastQuestion)) return 'projectLocation';
  if (/(?:date|day).*time|time.*(?:date|day)/i.test(lastQuestion)) return 'preferredSchedule';
  return source.match(/^Current field:\s*(.+)$/im)?.[1]?.trim() || '';
}

function lastQuestionFromState(value) {
  return clean(value).match(/^Last question:\s*(.+)$/im)?.[1]?.trim() || '';
}

function retryQuestionFor(field, lastQuestion = '') {
  return RETRY_QUESTIONS[field] || (clean(lastQuestion).endsWith('?') ? clean(lastQuestion) : 'Could you repeat that?');
}

function businessNameFromInstructions(value = '') {
  return clean(value).match(/^- Business name:\s*(.+)$/im)?.[1]?.trim() || 'The business';
}

export function rewritePrimaryIntakeQuestions(value = '') {
  const source = clean(value);
  return source
    .replace(
      /What is the project address\? Please (?:give me|include) the city or town, state, street number, and street name\./gi,
      'What is the project address? Please say it in this order: street number, street name, city or town, and state.',
    )
    .replace(
      /Next,\s*what exact date or upcoming day and time works best for the estimate\?\s*We offer estimates\s+([^\n.]+?)\s+from\s+([^\n.]+?)\s+through\s+([^\n.]+?)\./gi,
      (_match, estimateDays, earliestTime, latestTime) => (
        `What day works best for you, and what time? We schedule estimates ${estimateDays} from ${earliestTime} to ${latestTime}.`
      ),
    )
    .replace(
      /Next,\s*we need a time for the estimate\.\s*[^\n.]+? schedules estimates\s+([^\n.]+?)\s+from\s+([^\n.]+?)\s+through\s+([^\n.]+?)\.\s*What exact date or upcoming day and time works best for you\?/gi,
      (_match, estimateDays, earliestTime, latestTime) => (
        `What day works best for you, and what time? We schedule estimates ${estimateDays} from ${earliestTime} to ${latestTime}.`
      ),
    )
    .replace(
      /We offer estimates\s+([^\n.;]+?)\s+from\s+([^\n.;]+?)\s+through\s+([^\n.;]+?);\s*what exact date or upcoming day and time works best for you\?/gi,
      (_match, estimateDays, earliestTime, latestTime) => (
        `What day works best for you, and what time? We schedule estimates ${estimateDays} from ${earliestTime} to ${latestTime}.`
      ),
    )
    .replace(
      /What day works best for you, and what time\?\s*We schedule estimates\s+([^\n.]+?)\s+from\s+([^\n.]+?)\s+to\s+([^\n.]+?)\.\s*What day(?: and time)? works best for you\?/gi,
      (_match, estimateDays, earliestTime, latestTime) => (
        `What day works best for you, and what time? We schedule estimates ${estimateDays} from ${earliestTime} to ${latestTime}.`
      ),
    );
}

export function augmentCallStateText(value = '') {
  const source = clean(value);
  if (!source || !/^CURRENT CALL STATE\b/im.test(source) || source.includes(STATE_MARKER)) return source;

  const field = fieldFromState(source);
  const lastQuestion = lastQuestionFromState(source);
  const retryQuestion = retryQuestionFor(field, lastQuestion);
  const businessName = businessNameFromInstructions(source);
  const nameRule = field === 'fullName'
    ? '- "Nice to meet you, [first name]" is allowed once only when the newest caller response provides a valid first and last name. Use it immediately after that name, then ask the service question once.'
    : '- "Nice to meet you" is forbidden on this turn. Do not use the caller’s name in an acknowledgment. The caller’s name may still appear later in the final summary or closing.';
  const groupedRule = field === 'projectLocation'
    ? '- Treat one normal address response as capable of supplying street number, street name, city or town, and state. Ask only for a missing part after evaluating the complete answer.'
    : field === 'preferredSchedule'
      ? `- Treat one normal scheduling response as capable of supplying both a day or date and a time. After both are usable, say exactly: "The date and time you requested is a request. ${businessName} might ask to reschedule." Then continue to the next intake question. Do not ask a separate date-confirmation question.`
      : '- Do not combine this missing-part question with another intake question.';

  return `${source}\n\n${STATE_MARKER}\n- Ask at most one question, one time, in this response. Never repeat the same question or place a long version and a short version together.\n- Use "I'm sorry, I didn't get that" only when the newest caller statement is complete but unusable for the current field. In that case say exactly: "I'm sorry, I didn't get that. ${retryQuestion}" Then stop and listen.\n- Silence, background noise, filler sounds, and unfinished speech are not invalid answers. Do not use the apology for those; the server handles them separately.\n${nameRule}\n${groupedRule}\n- After any usable answer other than the full-name step, use no more than one neutral acknowledgment: "Okay." "Thanks." or "Got it." Do not attach the caller’s name or repeat their answer unless confirmation is necessary.\n- Never begin an acknowledgment with an exclamation mark or an emphatic shouted word.\n- Never invent a waiting phrase or latency filler. Remain silent while waiting.`;
}

export function applyIntakeWordingSessionRules(message = {}) {
  if (message?.type !== 'session.update' || !message.session) return message;

  const session = { ...message.session };
  let instructions = rewritePrimaryIntakeQuestions(session.instructions);
  if (instructions.includes(SESSION_MARKER)) return { ...message, session: { ...session, instructions } };
  const businessName = businessNameFromInstructions(instructions);

  const strictBlock = `${SESSION_MARKER}\n- "Nice to meet you" may be spoken only once, immediately after the caller supplies a valid first and last name. It is forbidden after service, location, date, time, notes, consent, business questions, or any later step.\n- The first service question must include the complete configured service list and briefly identify the best matching configured service when the caller describes the problem in ordinary language. Do not skip directly to the address after a service description.\n- Ask for the full project address in one natural question using this order: street number, street name, city or town, and state. Ask individual address parts only when missing or unclear.\n- The first combined scheduling question must say exactly: "What day works best for you, and what time? We schedule estimates [configured estimate days] from [configured earliest estimate time] to [configured latest estimate time]." Ask it once.\n- Accept a weekday, a calendar date, or a day number when it can be resolved to one future date. After the caller gives a usable day and time, say exactly: "The date and time you requested is a request. ${businessName} might ask to reschedule." Then continue to the next intake question. Do not ask a separate date-confirmation question.\n- Ask for the preferred day and time in one natural question before asking for either part separately. Ask individual schedule parts only when missing or invalid.\n- Ask each question only once per response. Never repeat a question back-to-back and never say both the full question and its simplified retry in the same response.\n- When a complete answer does not fit the current field, use one short retry: "I'm sorry, I didn't get that," followed by the simplified current question. Do not repeat service lists or scheduling ranges in a retry.\n- Do not use "I'm sorry, I didn't get that" merely because the caller is silent, paused, unfinished, interrupted, or surrounded by noise.\n- Acknowledgments must be quiet and neutral, with no exclamation marks. Outside the name step, do not attach the caller’s name to an acknowledgment.\n- There is no separate latency cue or secondary voice. While waiting, say nothing.`;
  const replacement = `RESPONSIVE ACKNOWLEDGMENTS\nImmediately after a valid full name only, you may say "Thanks, [first name]" or "Nice to meet you, [first name]" once, then ask the service question once.\nAfter every other usable intake answer, you may say only one neutral acknowledgment: "Okay." "Thanks." or "Got it." Never use the caller’s name in those acknowledgments.\nDo not repeat an answer unless a confirmation is required.\nDo not use exclamation marks.\nDo not say "take your time," "no rush," "whenever you're ready," or similar reassurance.\nRemain silent while waiting for the caller.\n\nRESTRICTED OUTPUT`;
  if (/RESPONSIVE ACKNOWLEDGMENTS[\s\S]*?\n\nRESTRICTED OUTPUT/i.test(instructions)) {
    instructions = instructions.replace(/RESPONSIVE ACKNOWLEDGMENTS[\s\S]*?\n\nRESTRICTED OUTPUT/i, replacement);
  }
  session.instructions = `${instructions}\n\n${strictBlock}`.trim();
  return { ...message, session };
}

export function rewriteSilenceReaskMessage(message = {}) {
  if (message?.type !== 'response.create') return message;
  const instructions = clean(message?.response?.instructions);
  if (!/Do not add reassurance, filler, or the next intake question/i.test(instructions)) return message;

  const rewritten = instructions
    .replace(/I'm sorry, I didn't get that\.\s*/gi, '')
    .replace(/What service do you need\?/gi, 'What service were you looking for?')
    .replace(
      /What is the project's street address\?/gi,
      'What is the project address? Please say it in this order: street number, street name, city or town, and state.',
    )
    .replace(
      /What is the project address\? Please include the city or town, state, street number, and street name\./gi,
      'What is the project address? Please say it in this order: street number, street name, city or town, and state.',
    )
    .replace(
      /What exact date or upcoming day and time works best for the estimate\?/gi,
      'What day works best for you, and what time?',
    );

  if (rewritten === instructions) return message;
  return {
    ...message,
    response: {
      ...(message.response || {}),
      instructions: rewritten,
    },
  };
}

WebSocket.prototype.send = function intakeWordingSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return previousSend.call(this, data, ...args);
  const message = parseJson(data);
  if (!message) return previousSend.call(this, data, ...args);

  let outgoing = applyIntakeWordingSessionRules(message);

  if (outgoing?.type === 'conversation.item.create' && outgoing?.item?.role === 'system') {
    const content = Array.isArray(outgoing.item.content) ? outgoing.item.content : [];
    const nextContent = content.map((entry) => {
      if (entry?.type !== 'input_text') return entry;
      return { ...entry, text: augmentCallStateText(entry.text) };
    });
    outgoing = { ...outgoing, item: { ...outgoing.item, content: nextContent } };
  }

  outgoing = rewriteSilenceReaskMessage(outgoing);
  return previousSend.call(this, JSON.stringify(outgoing), ...args);
};

console.log('[Intake wording guard]', {
  enabled: true,
  behavior: 'keeps service classification and grouped address intake, asks scheduling once, gives the request-and-reschedule disclaimer, and keeps waiting silent',
});