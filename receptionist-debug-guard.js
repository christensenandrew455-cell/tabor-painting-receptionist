import { WebSocket } from 'ws';

// Read-only OpenAI Realtime diagnostics for Railway.
// This guard never changes, cancels, deletes, or creates a conversation event.
// Disable all diagnostics with RECEPTIONIST_DEBUG=false.
// Disable transcript and tool-detail logging with RECEPTIONIST_DEBUG_TRANSCRIPTS=false.
// Enable the full session prompt only when needed with RECEPTIONIST_DEBUG_SESSION_PROMPT=true.

const DEBUG_ENABLED = String(process.env.RECEPTIONIST_DEBUG ?? 'true').toLowerCase() !== 'false';
const TRANSCRIPT_DEBUG_ENABLED = String(process.env.RECEPTIONIST_DEBUG_TRANSCRIPTS ?? 'true').toLowerCase() !== 'false';
const SESSION_PROMPT_DEBUG_ENABLED = String(process.env.RECEPTIONIST_DEBUG_SESSION_PROMPT ?? 'false').toLowerCase() === 'true';

const originalSend = WebSocket.prototype.send;
const originalEmit = WebSocket.prototype.emit;
const socketStates = new WeakMap();
let socketSequence = 0;

function clean(value) {
  return String(value ?? '').trim();
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

function modelFromSocket(socket) {
  try {
    return new URL(clean(socket?.url || socket?._url)).searchParams.get('model') || '';
  } catch {
    return '';
  }
}

function safetyIdentifier(socket) {
  const request = socket?._req;
  return clean(
    request?.getHeader?.('OpenAI-Safety-Identifier')
    || request?.getHeader?.('openai-safety-identifier')
    || request?._headers?.['openai-safety-identifier'],
  );
}

function stateFor(socket) {
  if (!socketStates.has(socket)) {
    socketSequence += 1;
    socketStates.set(socket, {
      socketId: `realtime-${socketSequence}`,
      createdAt: Date.now(),
      eventSequence: 0,
      requestSequence: 0,
      responseId: '',
      responseActive: false,
      responseMode: '',
      responseInstructions: '',
      assistantTranscript: '',
      lastCallerTranscript: '',
      speechStartedAt: 0,
      speechStartedDuringAssistant: false,
      lastSpeechDurationMs: 0,
      audioChunkCount: 0,
      audioBase64Characters: 0,
    });
  }
  return socketStates.get(socket);
}

function debugValue(value) {
  if (TRANSCRIPT_DEBUG_ENABLED) return value;
  if (typeof value === 'string') return value ? `[hidden ${value.length} chars]` : '';
  if (Array.isArray(value)) return `[hidden ${value.length} items]`;
  if (value && typeof value === 'object') return '[hidden object]';
  return value;
}

function logEvent(socket, event, details = {}) {
  if (!DEBUG_ENABLED) return;
  const state = stateFor(socket);
  state.eventSequence += 1;
  const payload = {
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - state.createdAt,
    socketId: state.socketId,
    eventSequence: state.eventSequence,
    model: modelFromSocket(socket),
    safetyIdentifier: safetyIdentifier(socket),
    responseId: state.responseId,
    responseActive: state.responseActive,
    event,
    ...details,
  };
  console.log('[Receptionist debug]', JSON.stringify(payload));
}

function contentText(content = []) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => clean(part?.text || part?.transcript || part?.input_text || part?.output_text))
    .filter(Boolean)
    .join(' ');
}

function itemTranscript(item = {}) {
  return clean(item?.transcript || item?.text || contentText(item?.content));
}

function responseTranscript(response = {}) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.map((item) => itemTranscript(item)).filter(Boolean).join(' ');
}

function toolCallFromMessage(message = {}) {
  const item = message.item || message.output_item || {};
  const name = clean(message.name || item.name);
  if (!name) return null;
  return {
    name,
    callId: clean(message.call_id || item.call_id || item.id),
    arguments: debugValue(clean(message.arguments || item.arguments || '')),
  };
}

function summarizeConversationItem(item = {}) {
  const summary = {
    id: clean(item.id),
    type: clean(item.type),
    role: clean(item.role),
  };
  const text = itemTranscript(item);
  if (text) summary.text = debugValue(text);
  if (item.type === 'function_call_output') {
    summary.callId = clean(item.call_id);
    summary.output = debugValue(clean(item.output));
  }
  if (item.type === 'function_call') {
    summary.name = clean(item.name);
    summary.callId = clean(item.call_id);
    summary.arguments = debugValue(clean(item.arguments));
  }
  return summary;
}

function responseCreateSummary(message = {}) {
  const instructions = clean(message?.response?.instructions);
  return {
    mode: instructions ? 'fixed-instructions' : 'natural',
    instructions: debugValue(instructions),
    outputModalities: message?.response?.output_modalities || [],
  };
}

WebSocket.prototype.send = function receptionistDebugSend(data, ...args) {
  if (!isOpenAiRealtimeSocket(this)) return originalSend.call(this, data, ...args);

  const message = parseJson(data);
  if (!message) return originalSend.call(this, data, ...args);
  const state = stateFor(this);

  if (message.type === 'session.update') {
    const session = message.session || {};
    const turnDetection = session?.audio?.input?.turn_detection || {};
    const prompt = clean(session.instructions);
    logEvent(this, 'openai.session.update.sent', {
      voice: clean(session?.audio?.output?.voice),
      speechSpeed: session?.audio?.output?.speed ?? null,
      maxOutputTokens: session.max_output_tokens ?? null,
      vad: {
        type: clean(turnDetection.type),
        threshold: turnDetection.threshold ?? null,
        silenceDurationMs: turnDetection.silence_duration_ms ?? null,
        createResponse: turnDetection.create_response ?? null,
        interruptResponse: turnDetection.interrupt_response ?? null,
      },
      tools: Array.isArray(session.tools) ? session.tools.map((tool) => clean(tool?.name)).filter(Boolean) : [],
      instructionCharacters: prompt.length,
      instructions: SESSION_PROMPT_DEBUG_ENABLED ? debugValue(prompt) : '[set RECEPTIONIST_DEBUG_SESSION_PROMPT=true to print]',
    });
  }

  if (message.type === 'response.create') {
    state.requestSequence += 1;
    state.responseMode = clean(message?.response?.instructions) ? 'fixed-instructions' : 'natural';
    state.responseInstructions = clean(message?.response?.instructions);
    logEvent(this, 'openai.response.create.sent', {
      requestSequence: state.requestSequence,
      ...responseCreateSummary(message),
      lastCallerTranscript: debugValue(state.lastCallerTranscript),
    });
  }

  if (message.type === 'response.cancel') {
    logEvent(this, 'openai.response.cancel.sent', {
      assistantTranscriptSoFar: debugValue(state.assistantTranscript),
    });
  }

  if (message.type === 'conversation.item.create') {
    logEvent(this, 'openai.conversation.item.create.sent', {
      item: summarizeConversationItem(message.item || {}),
    });
  }

  if (message.type === 'conversation.item.delete') {
    logEvent(this, 'openai.conversation.item.delete.sent', {
      itemId: clean(message.item_id),
      lastCallerTranscript: debugValue(state.lastCallerTranscript),
    });
  }

  const result = originalSend.call(this, data, ...args);
  return result;
};

WebSocket.prototype.emit = function receptionistDebugEmit(eventName, ...args) {
  if (eventName !== 'message' || !isOpenAiRealtimeSocket(this) || !args[0]) {
    return originalEmit.call(this, eventName, ...args);
  }

  const message = parseJson(args[0]);
  if (!message) return originalEmit.call(this, eventName, ...args);
  const state = stateFor(this);

  if (message.type === 'session.updated') {
    logEvent(this, 'openai.session.updated.received');
  }

  if (message.type === 'input_audio_buffer.speech_started') {
    state.speechStartedAt = Date.now();
    state.speechStartedDuringAssistant = state.responseActive;
    logEvent(this, 'caller.speech.started', {
      startedDuringAssistant: state.speechStartedDuringAssistant,
      itemId: clean(message.item_id),
    });
  }

  if (message.type === 'input_audio_buffer.speech_stopped') {
    state.lastSpeechDurationMs = state.speechStartedAt ? Math.max(0, Date.now() - state.speechStartedAt) : 0;
    state.speechStartedAt = 0;
    logEvent(this, 'caller.speech.stopped', {
      durationMs: state.lastSpeechDurationMs,
      startedDuringAssistant: state.speechStartedDuringAssistant,
      itemId: clean(message.item_id),
    });
  }

  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    state.lastCallerTranscript = clean(message.transcript);
    logEvent(this, 'caller.transcript.completed', {
      itemId: clean(message.item_id),
      transcript: debugValue(state.lastCallerTranscript),
      speechDurationMs: state.lastSpeechDurationMs,
      startedDuringAssistant: state.speechStartedDuringAssistant,
    });
    state.speechStartedDuringAssistant = false;
  }

  if (message.type === 'conversation.item.input_audio_transcription.failed') {
    logEvent(this, 'caller.transcript.failed', {
      itemId: clean(message.item_id),
      error: message.error || null,
      speechDurationMs: state.lastSpeechDurationMs,
      startedDuringAssistant: state.speechStartedDuringAssistant,
    });
    state.speechStartedDuringAssistant = false;
  }

  if (message.type === 'response.created') {
    const response = message.response || {};
    state.responseId = clean(response.id || message.response_id);
    state.responseActive = true;
    state.assistantTranscript = '';
    state.audioChunkCount = 0;
    state.audioBase64Characters = 0;
    logEvent(this, 'assistant.response.created', {
      requestSequence: state.requestSequence,
      mode: state.responseMode,
      instructions: debugValue(state.responseInstructions),
    });
  }

  if (
    message.type === 'response.audio_transcript.delta'
    || message.type === 'response.output_audio_transcript.delta'
  ) {
    state.assistantTranscript += String(message.delta || '');
  }

  if (
    message.type === 'response.audio_transcript.done'
    || message.type === 'response.output_audio_transcript.done'
  ) {
    const transcript = clean(message.transcript);
    if (transcript) state.assistantTranscript = transcript;
    logEvent(this, 'assistant.transcript.completed', {
      transcript: debugValue(state.assistantTranscript),
    });
  }

  if (message.type === 'response.audio.delta' || message.type === 'response.output_audio.delta') {
    const audio = clean(message.delta || message.audio);
    state.audioChunkCount += 1;
    state.audioBase64Characters += audio.length;
  }

  if (message.type === 'response.function_call_arguments.done' || message.type === 'response.output_item.done') {
    const toolCall = toolCallFromMessage(message);
    if (toolCall) logEvent(this, 'assistant.tool.call', toolCall);
  }

  if (message.type === 'response.done') {
    const response = message.response || {};
    const finalTranscript = clean(state.assistantTranscript || responseTranscript(response));
    logEvent(this, 'assistant.response.done', {
      status: clean(response.status || message.status || 'unknown'),
      reason: clean(response.status_details?.reason || message.status_details?.reason),
      transcript: debugValue(finalTranscript),
      outputTokens: response.usage?.output_tokens ?? null,
      inputTokens: response.usage?.input_tokens ?? null,
      audioChunkCount: state.audioChunkCount,
      audioBase64Characters: state.audioBase64Characters,
      responseMode: state.responseMode,
    });
    state.responseActive = false;
    state.responseMode = '';
    state.responseInstructions = '';
  }

  if (message.type === 'response.cancelled') {
    logEvent(this, 'assistant.response.cancelled', {
      reason: clean(message.reason || message.status_details?.reason || message.response?.status_details?.reason),
      transcript: debugValue(state.assistantTranscript),
      audioChunkCount: state.audioChunkCount,
      responseMode: state.responseMode,
    });
    state.responseActive = false;
    state.responseMode = '';
    state.responseInstructions = '';
  }

  if (message.type === 'error') {
    logEvent(this, 'openai.error', { error: message.error || message });
  }

  const emitted = originalEmit.call(this, eventName, ...args);
  if (emitted === false && [
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'conversation.item.input_audio_transcription.completed',
    'conversation.item.input_audio_transcription.failed',
    'response.audio_transcript.delta',
    'response.output_audio_transcript.delta',
    'response.audio.delta',
    'response.output_audio.delta',
  ].includes(message.type)) {
    logEvent(this, 'openai.event.blocked_by_guard', {
      messageType: message.type,
      itemId: clean(message.item_id),
      transcript: debugValue(clean(message.transcript || state.lastCallerTranscript || state.assistantTranscript)),
      startedDuringAssistant: state.speechStartedDuringAssistant,
    });
  }
  return emitted;
};

if (DEBUG_ENABLED) {
  console.log('[Receptionist debug]', JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'debug.guard.enabled',
    transcripts: TRANSCRIPT_DEBUG_ENABLED,
    fullSessionPrompt: SESSION_PROMPT_DEBUG_ENABLED,
    behavior: 'read-only; logs OpenAI Realtime turns without changing call behavior',
  }));
}
