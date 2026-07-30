const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMuLaw(sample) {
  let pcm = Math.max(-32768, Math.min(32767, sample));
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  pcm = Math.min(MULAW_CLIP, pcm) + MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(pcm & mask); exponent -= 1, mask >>= 1) {}
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function pcm24kToPcmu8k(buffer) {
  const sampleCount = Math.floor(buffer.length / 2);
  const output = Buffer.alloc(Math.floor(sampleCount / 3));
  let out = 0;
  for (let index = 0; index + 2 < sampleCount; index += 3) {
    const a = buffer.readInt16LE(index * 2);
    const b = buffer.readInt16LE((index + 1) * 2);
    const c = buffer.readInt16LE((index + 2) * 2);
    output[out] = linearToMuLaw(Math.round((a + b + c) / 3));
    out += 1;
  }
  return output.subarray(0, out);
}

export function splitPcmuFrames(buffer, frameBytes = 160) {
  const frames = [];
  for (let offset = 0; offset < buffer.length; offset += frameBytes) {
    const frame = Buffer.alloc(frameBytes, 0xff);
    buffer.subarray(offset, offset + frameBytes).copy(frame);
    frames.push(frame);
  }
  return frames;
}
