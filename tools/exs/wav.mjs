// Minimal PCM WAV read/slice/write, used to cut a zone's sampleStart..sampleEnd out of a file that afconvert has
// already turned into 16-bit little-endian WAV (so only integer PCM needs handling).

/** @returns {{ format:number, channels:number, sampleRate:number, bitsPerSample:number, blockAlign:number, dataOffset:number, dataLength:number }} */
export function readWavInfo(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      const dataLength = Math.min(size, buf.length - body);
      return { ...fmt, dataOffset: body, dataLength };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

/** Canonical 44-byte PCM header + data. */
export function buildWav({ channels, sampleRate, bitsPerSample }, data) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * Frames [start, end) of a PCM WAV as a new WAV. end null/0/past-the-end → to the end.
 * If `rateScale` is given, frame numbers are multiplied by it first (EXS offsets are in the source file's rate;
 * afconvert keeps the rate, so normally 1).
 */
export function sliceWav(buf, start, end, rateScale = 1) {
  const info = readWavInfo(buf);
  if (info.format !== 1 && info.format !== 0xfffe) throw new Error(`sliceWav: only PCM supported (format ${info.format})`);
  const total = Math.floor(info.dataLength / info.blockAlign);
  const s = Math.max(0, Math.min(total, Math.round((start || 0) * rateScale)));
  const e = end ? Math.max(s, Math.min(total, Math.round(end * rateScale))) : total;
  const data = buf.subarray(info.dataOffset + s * info.blockAlign, info.dataOffset + e * info.blockAlign);
  return buildWav(info, Buffer.from(data));
}

/**
 * Frames of several [start, end) ranges of a PCM WAV, joined in order, as one new WAV (end null = to the end).
 * Used for two-segment zones in consolidated CAFs (layout.mjs ZONE.SEGMENT2_*) on the afconvert path.
 */
export function sliceWavSegments(buf, segments, gainDb = 0) {
  const info = readWavInfo(buf);
  if (info.format !== 1 && info.format !== 0xfffe) throw new Error(`sliceWavSegments: only PCM supported (format ${info.format})`);
  const total = Math.floor(info.dataLength / info.blockAlign);
  const parts = [];
  for (const sg of segments) {
    const s = Math.max(0, Math.min(total, Math.round(sg.start || 0)));
    const e = sg.end != null ? Math.max(s, Math.min(total, Math.round(sg.end))) : total;
    parts.push(buf.subarray(info.dataOffset + s * info.blockAlign, info.dataOffset + e * info.blockAlign));
  }
  const data = Buffer.concat(parts);
  if (gainDb && info.bitsPerSample === 16) {
    const k = Math.pow(10, gainDb / 20);
    for (let i = 0; i + 1 < data.length; i += 2) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data.readInt16LE(i) * k))), i);
  }
  return buildWav(info, data);
}
