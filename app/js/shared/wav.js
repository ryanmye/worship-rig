// WAV (RIFF PCM) helpers for the recorder (SPEC §0.7, §7). Little-endian regardless of platform.

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function writeAscii(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
function readAscii(view, offset, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * Canonical 44-byte PCM WAV header. RIFF size = 36 + dataBytes (both clamped to uint32).
 * Re-call with the final byte count to patch a streamed file's header.
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} dataBytes size of the sample data that follows
 * @param {number} [bitsPerSample=16]
 * @returns {ArrayBuffer} 44 bytes
 */
export function wavHeader(sampleRate, channels, dataBytes, bitsPerSample = 16) {
  if (!(Number.isInteger(sampleRate) && sampleRate > 0)) throw new RangeError(`wavHeader: bad sampleRate ${sampleRate}`);
  if (!(Number.isInteger(channels) && channels > 0 && channels < 65536)) throw new RangeError(`wavHeader: bad channels ${channels}`);
  if (![8, 16, 24, 32].includes(bitsPerSample)) throw new RangeError(`wavHeader: bad bitsPerSample ${bitsPerSample}`);
  if (!(Number.isInteger(dataBytes) && dataBytes >= 0)) throw new RangeError(`wavHeader: bad dataBytes ${dataBytes}`);
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const blockAlign = (channels * bitsPerSample) / 8;
  const data = Math.min(dataBytes, 0xffffffff - 36);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true); // byte rate
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  writeAscii(v, 36, 'data');
  v.setUint32(40, data, true);
  return buf;
}

/**
 * @typedef {object} WavInfo
 * @property {number} format         1 = PCM, 3 = float, 0xFFFE = extensible
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample
 * @property {number} byteRate
 * @property {number} blockAlign
 * @property {number} dataBytes      as declared in the data chunk header
 * @property {number} dataOffset     byte offset of the first sample
 * @property {number} availableBytes data bytes actually present in this buffer (≤ dataBytes)
 */

/**
 * Parse a RIFF/WAVE header by walking chunks (skips LIST/fact/etc., honours odd-size padding).
 * @param {ArrayBuffer|ArrayBufferView} arrayBuffer
 * @returns {WavInfo}
 * @throws {Error} not a WAV / missing fmt or data chunk
 */
export function parseWavHeader(arrayBuffer) {
  const view = ArrayBuffer.isView(arrayBuffer)
    ? new DataView(arrayBuffer.buffer, arrayBuffer.byteOffset, arrayBuffer.byteLength)
    : new DataView(arrayBuffer);
  if (view.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('parseWavHeader: not a RIFF/WAVE file');
  }
  let fmt = null;
  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = readAscii(view, off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      if (off + 8 + 16 > view.byteLength) break;
      fmt = {
        format: view.getUint16(off + 8, true),
        channels: view.getUint16(off + 10, true),
        sampleRate: view.getUint32(off + 12, true),
        byteRate: view.getUint32(off + 16, true),
        blockAlign: view.getUint16(off + 20, true),
        bitsPerSample: view.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('parseWavHeader: data chunk before fmt chunk');
      const dataOffset = off + 8;
      return {
        ...fmt,
        dataBytes: size,
        dataOffset,
        availableBytes: Math.max(0, Math.min(size, view.byteLength - dataOffset)),
      };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(fmt ? 'parseWavHeader: no data chunk' : 'parseWavHeader: no fmt chunk');
}

/**
 * Interleave float channels to Int16 (clamp ±1, NaN → 0, round; −1 → −32768, +1 → 32767).
 * Frame count = longest channel; shorter channels are padded with 0.
 * @param {Float32Array[]} channelsFloat32
 * @returns {Int16Array}
 */
export function interleaveToInt16(channelsFloat32) {
  const chs = channelsFloat32 || [];
  const nch = chs.length;
  let frames = 0;
  for (const c of chs) frames = Math.max(frames, c.length);
  const out = new Int16Array(frames * nch);
  for (let c = 0; c < nch; c++) {
    const src = chs[c];
    const n = src.length;
    for (let i = 0, j = c; i < n; i++, j += nch) {
      let s = src[i];
      if (!(s === s)) s = 0; // NaN
      else if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[j] = Math.round(s < 0 ? s * 32768 : s * 32767);
    }
  }
  return out;
}
/** SPEC §1 name. */
export const int16Encode = interleaveToInt16;

/**
 * De-interleave Int16 samples to float channels (inverse scaling of interleaveToInt16).
 * Trailing samples that don't fill a whole frame are dropped.
 * @param {Int16Array} int16
 * @param {number} [channels=1]
 * @returns {Float32Array[]}
 */
export function int16ToFloat32(int16, channels = 1) {
  const nch = Math.max(1, Math.floor(channels));
  const frames = Math.floor(int16.length / nch);
  const out = Array.from({ length: nch }, () => new Float32Array(frames));
  for (let c = 0; c < nch; c++) {
    const dst = out[c];
    for (let i = 0, j = c; i < frames; i++, j += nch) {
      const s = int16[j];
      dst[i] = s < 0 ? s / 32768 : s / 32767;
    }
  }
  return out;
}

/**
 * Encode float channels as a complete 16-bit PCM WAV file.
 * @param {Float32Array[]} channelsFloat32 at least one channel
 * @param {number} sampleRate
 * @returns {ArrayBuffer} header + little-endian Int16 data
 */
export function encodeWav(channelsFloat32, sampleRate) {
  if (!channelsFloat32 || channelsFloat32.length === 0) throw new RangeError('encodeWav: need at least one channel');
  const pcm = interleaveToInt16(channelsFloat32);
  const dataBytes = pcm.length * 2;
  const out = new ArrayBuffer(44 + dataBytes);
  new Uint8Array(out, 0, 44).set(new Uint8Array(wavHeader(sampleRate, channelsFloat32.length, dataBytes, 16)));
  if (LITTLE_ENDIAN) {
    new Uint8Array(out, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes));
  } else {
    const v = new DataView(out, 44);
    for (let i = 0; i < pcm.length; i++) v.setInt16(i * 2, pcm[i], true);
  }
  return out;
}
