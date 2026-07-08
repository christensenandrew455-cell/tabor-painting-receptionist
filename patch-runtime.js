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
  'ocm constants',
  "const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Monday through Friday, 8 AM to 5 PM';\nconst resend",
  "const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Monday through Friday, 8 AM to 5 PM';\nconst OCM_WEBHOOK_URL = process.env.OCM_WEBHOOK_URL || 'https://ark-websites-ocm.vercel.app/api/intake';\nconst resend"
);

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
  'business knowledge and ocm instructions',
  'Business hours: ${BUSINESS_HOURS}.\n\nPricing rule:',
  'Business hours: ${BUSINESS_HOURS}.\nPhone: (774)-245-3383.\nEmail: Taborpainting508@gmail.com.\nBased in Berlin, Massachusetts. Serves Berlin and nearby Central Massachusetts communities, including Berlin, Bolton, Hudson, Clinton, Marlborough, Northborough, Boylston, West Boylston, Sterling, Lancaster, and Worcester.\nAbout: Tabor Painting was founded by Jason Beirne after working with Student Painters. The company focuses on hard work, quality craftsmanship, careful prep, clean work areas, steady communication, and attention to detail.\nServices: interior painting, exterior painting, residential painting, wall painting, trim painting, door painting, touch-ups, repainting, full home refreshes, and wood staining. Interior painting can include walls, rooms, trim, doors, touch-ups, and repainting. Exterior painting focuses on surface preparation, clean coverage, curb appeal, and protecting the home. Wood staining refreshes and helps protect wood surfaces.\n\nOCM RULE: After the caller confirms the details are correct, call the submit_estimate_lead tool with the collected details. Do not say the lead was submitted out loud. After the tool finishes, say the normal goodbye line.\n\nPricing rule:'
);

patch(
  'openai tool definition',
  "max_output_tokens: 'inf',\n        audio:",
  "max_output_tokens: 'inf',\n        tools: [{\n          type: 'function',\n          name: 'submit_estimate_lead',\n          description: 'Submit the confirmed painting estimate request to the ARK OCM.',\n          parameters: {\n            type: 'object',\n            properties: {\n              name: { type: 'string' },\n              phone: { type: 'string' },\n              email: { type: 'string' },\n              address: { type: 'string' },\n              service: { type: 'string' },\n              preferredDay: { type: 'string' },\n              preferredTime: { type: 'string' },\n              contactMethod: { type: 'string' },\n              notes: { type: 'string' }\n            },\n            required: ['name', 'service', 'preferredDay', 'preferredTime', 'contactMethod']\n          }\n        }],\n        tool_choice: 'auto',\n        audio:"
);

patch(
  'realtime input transcription',
  "format: { type: 'audio/pcmu' },\n            turn_detection:",
  "format: { type: 'audio/pcmu' },\n            transcription: { model: 'whisper-1' },\n            turn_detection:"
);

patch(
  'ocm functions before greeting helper',
  /function forceGreeting\(ctx, reason = 'manual'\) \{[\s\S]*?\n\}\n\nfunction handleOpenAIMessage/,
  "function forceGreeting(ctx, reason = 'manual') {\n  if (ctx.greeted || !ctx.openaiSessionReady) return false;\n  ctx.greeted = true;\n  return createAudioResponse(ctx, reason, promptForOpening());\n}\n\nfunction cleanText(value = '') {\n  return String(value || '').trim();\n}\n\nfunction buildOcmPayload(args = {}) {\n  const notes = [\n    cleanText(args.notes),\n    args.preferredDay ? `Preferred day: ${cleanText(args.preferredDay)}` : '',\n    args.preferredTime ? `Preferred time: ${cleanText(args.preferredTime)}` : '',\n    args.contactMethod ? `Best contact method: ${cleanText(args.contactMethod)}` : ''\n  ].filter(Boolean).join('\\n');\n  return {\n    clientId: 'tabor-painting',\n    sectionKey: 'contactedMe',\n    Name: cleanText(args.name || args.fullName),\n    Phone: cleanText(args.phone || args.phoneNumber),\n    Email: cleanText(args.email),\n    Address: cleanText(args.address),\n    Job: cleanText(args.service || args.jobType || args.job),\n    Notes: notes,\n    source: 'taborpainting-receptionist',\n    rawSubmission: args\n  };\n}\n\nasync function sendLeadToOcm(ctx, args = {}) {\n  if (ctx.ocmLeadSent) return { ok: true, skipped: true, reason: 'already-sent' };\n  const payload = buildOcmPayload(args);\n  try {\n    const response = await fetch(OCM_WEBHOOK_URL, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify(payload)\n    });\n    const text = await response.text();\n    let body = text;\n    try { body = JSON.parse(text); } catch {}\n    ctx.ocmLeadSent = response.ok;\n    console.log('[OCM lead submit]', { connectionId: ctx.connectionId, ok: response.ok, status: response.status, body });\n    return { ok: response.ok, status: response.status, body };\n  } catch (error) {\n    console.error('[OCM lead submit failed]', { connectionId: ctx.connectionId, message: error?.message || String(error) });\n    return { ok: false, error: error?.message || String(error) };\n  }\n}\n\nfunction markEndCall(ctx, text = '') {\n  const lower = String(text).toLowerCase();\n  if (lower.includes('thanks for calling') || lower.includes('thank you for calling') || lower.includes('goodbye')) ctx.pendingEndCall = true;\n}\n\nfunction scheduleEndCall(ctx) {\n  if (ctx.endCallScheduled) return false;\n  ctx.endCallScheduled = true;\n  setTimeout(async () => {\n    if (!ctx.callControlId) {\n      console.log('[TELNYX end skipped - missing call id]', { connectionId: ctx.connectionId });\n      return;\n    }\n    console.log('[TELNYX ending call]', { connectionId: ctx.connectionId, callControlId: ctx.callControlId });\n    await endVoiceApiCall(ctx.callControlId);\n  }, 1200);\n  return true;\n}\n\nfunction finishAfterOcm(ctx) {\n  ctx.pendingEndCall = true;\n  if (!ctx.openaiResponseActive) {\n    createAudioResponse(ctx, 'ocm-complete', `Say exactly: \"Okay, thanks for calling ${BUSINESS_NAME}. Jason will follow up with you soon. Goodbye.\"`);\n  } else {\n    ctx.sayGoodbyeAfterResponse = true;\n  }\n}\n\nfunction getFunctionCall(msg) {\n  const item = msg.item || msg.output_item || {};\n  const name = msg.name || item.name;\n  const callId = msg.call_id || item.call_id || item.id;\n  const rawArgs = msg.arguments || item.arguments || '{}';\n  if (name !== 'submit_estimate_lead') return null;\n  try { return { callId, args: JSON.parse(rawArgs || '{}') }; } catch { return { callId, args: {} }; }\n}\n\nfunction handleOpenAIMessage"
);

patch(
  'tool call handling',
  "  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {",
  "  if (type === 'response.function_call_arguments.done' || type === 'response.output_item.done') {\n    const call = getFunctionCall(msg);\n    if (call) {\n      sendLeadToOcm(ctx, call.args).then((result) => {\n        if (call.callId) {\n          sendOpenAI(ctx.openaiWs, {\n            type: 'conversation.item.create',\n            item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(result) }\n          });\n        }\n        finishAfterOcm(ctx);\n      });\n      return;\n    }\n  }\n\n  if (type === 'conversation.item.input_audio_transcription.completed') {\n    const transcript = msg.transcript || '';\n    if (transcript) {\n      ctx.userTranscript += `${transcript}\\n`;\n      console.log('[USER transcript]', { connectionId: ctx.connectionId, transcript });\n    }\n    return;\n  }\n\n  if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {\n    const delta = msg.delta || msg.transcript || '';\n    ctx.assistantTranscript += delta;\n    markEndCall(ctx, ctx.assistantTranscript);\n    return;\n  }\n\n  if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {\n    const transcript = msg.transcript || ctx.assistantTranscript || '';\n    markEndCall(ctx, transcript);\n    return;\n  }\n\n  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {"
);

patch(
  'end after response done',
  "console.log('[OPENAI REALTIME response done]', { connectionId: ctx.connectionId, status: msg.response?.status, details: msg.response?.status_details, audioDeltas: ctx.openaiAudioDeltas });",
  "console.log('[OPENAI REALTIME response done]', { connectionId: ctx.connectionId, status: msg.response?.status, details: msg.response?.status_details, audioDeltas: ctx.openaiAudioDeltas, pendingEndCall: ctx.pendingEndCall, ocmLeadSent: ctx.ocmLeadSent });\n    if (ctx.sayGoodbyeAfterResponse) {\n      ctx.sayGoodbyeAfterResponse = false;\n      createAudioResponse(ctx, 'ocm-complete', `Say exactly: \"Okay, thanks for calling ${BUSINESS_NAME}. Jason will follow up with you soon. Goodbye.\"`);\n      return;\n    }\n    if (ctx.pendingEndCall) scheduleEndCall(ctx);"
);

patch(
  'ctx ocm state',
  'openaiAudioDeltas: 0\n  };',
  "openaiAudioDeltas: 0,\n    assistantTranscript: '',\n    userTranscript: '',\n    pendingEndCall: false,\n    endCallScheduled: false,\n    ocmLeadSent: false,\n    sayGoodbyeAfterResponse: false\n  };"
);

fs.writeFileSync(file, code);
console.log('[runtime patch complete] receptionist OCM + business info applied');
