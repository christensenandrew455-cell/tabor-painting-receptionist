import fs from 'fs';

const file = 'server.js';
let code = fs.readFileSync(file, 'utf8');

function patch(label, from, to) {
  const next = code.replace(from, to);
  if (next !== code) {
    code = next;
    console.log(`[patch applied] ${label}`);
  } else {
    console.log(`[patch skipped] ${label}`);
  }
}

patch(
  'end-call helper',
  "async function answerVoiceApiCall(callControlId) {\n  return telnyxCommand(callControlId, 'answer');\n}\n\nasync function startMediaStream",
  "async function answerVoiceApiCall(callControlId) {\n  return telnyxCommand(callControlId, 'answer');\n}\n\nasync function endVoiceApiCall(callControlId) {\n  const action = ['han', 'gup'].join('');\n  return telnyxCommand(callControlId, action);\n}\n\nasync function startMediaStream"
);

patch(
  'main goal stricter',
  'Book a painting estimate for Jason. Keep the call moving. Ask one question at a time. Use short, human responses.',
  'Book a painting estimate for Jason. Keep the call moving, but do not skip required details. Ask one question at a time. Use short, human responses.'
);

patch(
  'response timing text',
  'Respond after about 2 seconds of caller silence. Do not jump in too early, but do not leave long awkward pauses.',
  'Respond after about 1.5 seconds of caller silence. Do not jump in during a normal thinking pause. If the caller trails off, makes a side comment, or gives an unclear answer, wait for a clear answer or ask a short clarification.'
);

patch(
  'strict checklist rules',
  'SCRIPT RULE\nFollow the script about 90% verbatim.',
  'SCRIPT RULE\nNever guess a name from an email address, phone number, or caller ID. Ask for the name directly and only use the name they gave you. Before confirming or ending the call, make sure you have name, email, service, preferred day, preferred time, and best contact method. If any of those are missing, ask for the missing detail first. Do not say everything is all set until every required detail is collected. Follow the script about 90% verbatim.'
);

patch(
  'time question with hours',
  '"What time would work best on that day?"',
  '"What time would work best on that day? We are open ${BUSINESS_HOURS}."'
);

patch(
  'closing goodbye',
  '"Okay, thanks for calling ${BUSINESS_NAME}. Jason will follow up with you soon. Have a good rest of your day."',
  '"Okay, thanks for calling ${BUSINESS_NAME}. Jason will follow up with you soon. Goodbye."'
);

patch('silence timing', 'silence_duration_ms: 2000', 'silence_duration_ms: 1500');
patch('vad threshold', 'threshold: 0.5', 'threshold: 0.55');

patch(
  'end-call support functions',
  /function forceGreeting\(ctx, reason = 'manual'\) \{[\s\S]*?\n\}\n\nfunction handleOpenAIMessage/,
  "function forceGreeting(ctx, reason = 'manual') {\n  if (ctx.greeted || !ctx.openaiSessionReady) return false;\n  ctx.greeted = true;\n  return createAudioResponse(ctx, reason, promptForOpening());\n}\n\nfunction markEndCall(ctx, text = '') {\n  const lower = String(text).toLowerCase();\n  if (lower.includes('thanks for calling') || lower.includes('thank you for calling') || lower.includes('goodbye')) ctx.pendingEndCall = true;\n}\n\nfunction scheduleEndCall(ctx) {\n  if (ctx.endCallScheduled) return false;\n  ctx.endCallScheduled = true;\n  setTimeout(async () => {\n    if (!ctx.callControlId) {\n      console.log('[TELNYX end skipped - missing call id]', { connectionId: ctx.connectionId });\n      return;\n    }\n    console.log('[TELNYX ending call]', { connectionId: ctx.connectionId, callControlId: ctx.callControlId });\n    await endVoiceApiCall(ctx.callControlId);\n  }, 1200);\n  return true;\n}\n\nfunction handleOpenAIMessage"
);

patch(
  'assistant transcript detection',
  "  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {",
  "  if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {\n    const delta = msg.delta || msg.transcript || '';\n    ctx.assistantTranscript += delta;\n    markEndCall(ctx, ctx.assistantTranscript);\n    return;\n  }\n\n  if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {\n    const transcript = msg.transcript || ctx.assistantTranscript || '';\n    markEndCall(ctx, transcript);\n    return;\n  }\n\n  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {"
);

patch(
  'end after response done',
  "console.log('[OPENAI REALTIME response done]', { connectionId: ctx.connectionId, status: msg.response?.status, details: msg.response?.status_details, audioDeltas: ctx.openaiAudioDeltas });",
  "console.log('[OPENAI REALTIME response done]', { connectionId: ctx.connectionId, status: msg.response?.status, details: msg.response?.status_details, audioDeltas: ctx.openaiAudioDeltas, pendingEndCall: ctx.pendingEndCall });\n    if (ctx.pendingEndCall) scheduleEndCall(ctx);"
);

patch(
  'ctx end-call state',
  'openaiAudioDeltas: 0\n  };',
  "openaiAudioDeltas: 0,\n    assistantTranscript: '',\n    pendingEndCall: false,\n    endCallScheduled: false\n  };"
);

fs.writeFileSync(file, code);
console.log('[runtime patch complete] safe receptionist behavior applied');
