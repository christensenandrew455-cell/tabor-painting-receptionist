import { decideReceptionistTurn, emptyLead } from './receptionist-brain.js';
import { createTranscriber, synthesizePcmu } from './openai-voice.js';

function clean(value) {
  return String(value ?? '').trim();
}

export function createVoicePipeline({ runtime, callerPhone, sendAudioFrame, clearAudio, saveLead, endCall, log = console }) {
  const state = {
    lead: emptyLead(),
    history: [],
    leadSaved: false,
    speaking: false,
    stopped: false,
    generation: 0,
    audioTimer: null,
    queuedFrames: [],
  };

  function remember(role, text) {
    const content = clean(text);
    if (!content) return;
    state.history.push({ role, content });
    if (state.history.length > 24) state.history.splice(0, state.history.length - 24);
  }

  function stopSpeaking() {
    state.generation += 1;
    state.speaking = false;
    state.queuedFrames = [];
    if (state.audioTimer) clearTimeout(state.audioTimer);
    state.audioTimer = null;
    clearAudio?.();
  }

  function pumpFrames(generation) {
    if (state.stopped || generation !== state.generation) return;
    const frame = state.queuedFrames.shift();
    if (!frame) {
      state.speaking = false;
      state.audioTimer = null;
      return;
    }
    sendAudioFrame(frame);
    state.audioTimer = setTimeout(() => pumpFrames(generation), 20);
  }

  async function speak(text) {
    const reply = clean(text);
    if (!reply || state.stopped) return;
    stopSpeaking();
    remember('assistant', reply);
    const generation = state.generation;
    const frames = await synthesizePcmu(reply);
    if (state.stopped || generation !== state.generation) return;
    state.queuedFrames = frames;
    state.speaking = true;
    pumpFrames(generation);
  }

  async function processTranscript(transcript) {
    const text = clean(transcript);
    if (!text || state.stopped) return;
    remember('caller', text);

    try {
      const turn = await decideReceptionistTurn({
        core: runtime.core,
        transcript: text,
        lead: state.lead,
        history: state.history,
        leadSaved: state.leadSaved,
      });
      state.lead = { ...state.lead, ...(turn.updatedLead || {}) };

      if (turn.submitLead && !state.leadSaved) {
        const validation = runtime.core.validateLead(state.lead);
        if (validation.valid) {
          await saveLead({
            callerPhone,
            lead: validation.lead,
            payload: runtime.core.buildOcmPayload(callerPhone, validation.lead),
          });
          state.leadSaved = true;
        } else {
          log.warn('[Brain requested invalid lead submission]', validation.errors);
        }
      }

      await speak(turn.spokenReply);
      if (turn.endCall) {
        const delay = Math.max(600, clean(turn.spokenReply).length * 55);
        setTimeout(() => endCall?.('completed'), delay);
      }
    } catch (error) {
      log.error('[Voice pipeline turn failed]', error);
      await speak("I'm sorry, I didn't catch that correctly. Could you say that again?");
    }
  }

  const transcriber = createTranscriber({
    onSpeechStarted: () => {
      if (state.speaking) stopSpeaking();
    },
    onTranscript: (transcript) => {
      processTranscript(transcript).catch((error) => log.error('[Transcript processing failed]', error));
    },
    onError: (error) => log.error('[Transcriber failed]', error),
  });

  return {
    async start() {
      await speak(runtime.core.openingLine);
    },
    appendCallerAudio(base64Pcmu) {
      if (!state.stopped) transcriber.append(base64Pcmu);
    },
    stop(reason = 'stopped') {
      state.stopped = true;
      stopSpeaking();
      transcriber.close();
      log.log('[Voice pipeline stopped]', reason);
    },
    snapshot() {
      return {
        lead: { ...state.lead },
        leadSaved: state.leadSaved,
        history: [...state.history],
        speaking: state.speaking,
      };
    },
  };
}
