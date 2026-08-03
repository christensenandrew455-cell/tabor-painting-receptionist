export function splitPcmuFrames(buffer, frameBytes = 160) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PCMU input must be a Buffer.');
  if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
    throw new Error('frameBytes must be a positive integer.');
  }

  const frames = [];
  for (let offset = 0; offset < buffer.length; offset += frameBytes) {
    const frame = Buffer.alloc(frameBytes, 0xff);
    buffer.subarray(offset, offset + frameBytes).copy(frame);
    frames.push(frame);
  }
  return frames;
}
