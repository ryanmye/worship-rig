// WAV I/O for the golden harness (node, no deps): writes 32-bit IEEE float (format 3, with a `fact` chunk); reads
// float32, float64, PCM 16/24/32 and WAVE_FORMAT_EXTENSIBLE wrappers of those.
import fs from 'node:fs';

/**
 * Encode channels as a 32-bit float WAV.
 * @param {Float32Array[]} chs one array per channel, equal lengths
 * @param {number} sr
 * @returns {Buffer}
 */
export function encodeWavF32(chs, sr) {
  const nch = chs.length;
  const n = chs[0].length;
  const dataBytes = n * nch * 4;
  const b = Buffer.alloc(12 + 26 + 12 + 8 + dataBytes);
  let o = 0;
  const str = (s) => {
    b.write(s, o, 'ascii');
    o += 4;
  };
  const u32 = (v) => {
    b.writeUInt32LE(v, o);
    o += 4;
  };
  const u16 = (v) => {
    b.writeUInt16LE(v, o);
    o += 2;
  };
  str('RIFF');
  u32(b.length - 8);
  str('WAVE');
  str('fmt ');
  u32(18);
  u16(3); // WAVE_FORMAT_IEEE_FLOAT
  u16(nch);
  u32(sr);
  u32(sr * nch * 4);
  u16(nch * 4);
  u16(32);
  u16(0); // cbSize
  str('fact');
  u32(4);
  u32(n);
  str('data');
  u32(dataBytes);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      b.writeFloatLE(chs[c][i], o);
      o += 4;
    }
  }
  return b;
}

/**
 * @param {string} file
 * @param {Float32Array[]} chs
 * @param {number} sr
 */
export function writeWavF32(file, chs, sr) {
  fs.writeFileSync(file, encodeWavF32(chs, sr));
}

/**
 * Decode a WAV buffer.
 * @param {Buffer} b
 * @returns {{sr:number, chs:Float32Array[], format:string}}
 */
export function decodeWav(b) {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let o = 12;
  let fmt = null;
  let data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      let tag = b.readUInt16LE(body);
      const bits = b.readUInt16LE(body + 14);
      if (tag === 0xfffe && size >= 40) tag = b.readUInt16LE(body + 24); // EXTENSIBLE: first 2 bytes of the GUID
      fmt = { tag, nch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits };
    } else if (id === 'data') {
      data = { off: body, len: Math.min(size, b.length - body) };
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const { tag, nch, bits, sr } = fmt;
  const bps = bits / 8;
  const n = Math.floor(data.len / (bps * nch));
  const chs = Array.from({ length: nch }, () => new Float32Array(n));
  let read;
  if (tag === 3 && bits === 32) read = (p) => b.readFloatLE(p);
  else if (tag === 3 && bits === 64) read = (p) => b.readDoubleLE(p);
  else if (tag === 1 && bits === 16) read = (p) => b.readInt16LE(p) / 32768;
  else if (tag === 1 && bits === 24) read = (p) => b.readIntLE(p, 3) / 8388608;
  else if (tag === 1 && bits === 32) read = (p) => b.readInt32LE(p) / 2147483648;
  else throw new Error(`unsupported WAV format tag ${tag} / ${bits} bit`);
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) chs[c][i] = read(data.off + (i * nch + c) * bps);
  return { sr, chs, format: `${tag === 3 ? 'float' : 'pcm'}${bits}` };
}

/**
 * @param {string} file
 * @returns {{sr:number, chs:Float32Array[], format:string}}
 */
export function readWav(file) {
  return decodeWav(fs.readFileSync(file));
}
