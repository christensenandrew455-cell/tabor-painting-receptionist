const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const INPUT_RATE = 24000;
const OUTPUT_RATE = 8000;
const DECIMATION = INPUT_RATE / OUTPUT_RATE;
const FILTER_TAPS = 15;
const FILTER_CUTOFF_HZ = 3400;
const OUTPUT_HEADROOM = 0.92;

function buildLowPassFilter() {
  const coefficients = [];
  const center = (FILTER_TAPS - 1) / 2;
  const normalizedCutoff = FILTER_CUTOFF_HZ / INPUT_RATE;

  for (let index = 0; index < FILTER_TAPS; index += 1) {
    const offset = index - center;
    const sinc = offset === 0
      ? 2 * normalizedCutoff
      : Math.sin(2 * Math.PI * normalizedCutoff * offset) / (Math.PI * offset);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (FILTER_TAPS - 1));
    coefficients.push(sinc * hamming);
  }

  const sum = coefficients.reduce((total, value) => total + value, 0);
  return coefficients.map((value) => value / sum);
}

const LOW_PASS_FILTER = Object.freeze(buildLowPassFilter());

function linearToMuLaw(sample) {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  pcm = Math.min(MULAW_CLIP, pcm) + MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(pcm & mask); exponent -= 1, mask >>= 1) {}
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function readClampedSample(buffer, sampleCount, index) {
  const clamped = Math.max(0, Math.min(sampleCount - 1, index));
  return buffer.readInt16LE(clamped * 2);
}

export function pcm24kToPcmu8k(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PCM input must be a Buffer.');
  if (buffer.length % 2 !== 0) throw new Error('PCM input must contain complete 16-bit samples.');

  const sampleCount = buffer.length / 2;
  if (!sampleCount) return Buffer.alloc(0);

  const outputSamples = Math.floor(sampleCount / DECIMATION);
  const output = Buffer.alloc(outputSamples);
  const filterCenter = (LOW_PASS_FILTER.length - 1) / 2;

  for (let outputIndex = 0; outputIndex < outputSamples; outputIndex += 1) {
    const sourceCenter = outputIndex * DECIMATION;
    let filtered = 0;

    for (let tap = 0; tap < LOW_PASS_FILTER.length; tap += 1) {
      const sourceIndex = sourceCenter + tap - filterCenter;
      filtered += readClampedSample(buffer, sampleCount, sourceIndex) * LOW_PASS_FILTER[tap];
    }

    output[outputIndex] = linearToMuLaw(filtered * OUTPUT_HEADROOM);
  }

  return output;
}

export function splitPcmuFrames(buffer, frameBytes = 160) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PCMU input must be a Buffer.');
  if (!Number.isInteger(frameBytes) || frameBytes <= 0) throw new Error('frameBytes must be a positive integer.');

  const frames = [];
  for (let offset = 0; offset < buffer.length; offset += frameBytes) {
    const frame = Buffer.alloc(frameBytes, 0xff);
    buffer.subarray(offset, offset + frameBytes).copy(frame);
    frames.push(frame);
  }
  return frames;
}
