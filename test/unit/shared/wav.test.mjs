import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wavHeader, parseWavHeader, interleaveToInt16, int16Encode, int16ToFloat32, encodeWav,
} from '../../../app/js/shared/wav.js';

const ascii = (buf, off, n) => String.fromCharCode(...new Uint8Array(buf, off, n));

test('wavHeader fields', () => {
  const h = wavHeader(48000, 2, 192000);
  assert.ok(h instanceof ArrayBuffer);
  assert.equal(h.byteLength, 44);
  const v = new DataView(h);
  assert.equal(ascii(h, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 192000);
  assert.equal(ascii(h, 8, 4), 'WAVE');
  assert.equal(ascii(h, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 48000 * 4);
  assert.equal(v.getUint16(32, true), 4);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(ascii(h, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), 192000);
});

test('wavHeader: other bit depths / mono / zero data', () => {
  const h = new DataView(wavHeader(44100, 1, 0, 24));
  assert.equal(h.getUint32(4, true), 36);
  assert.equal(h.getUint16(32, true), 3);
  assert.equal(h.getUint32(28, true), 44100 * 3);
  assert.equal(h.getUint16(34, true), 24);
  assert.equal(h.getUint32(40, true), 0);
  const h8 = new DataView(wavHeader(8000, 1, 7, 8));
  assert.equal(h8.getUint16(32, true), 1);
  assert.equal(h8.getUint32(40, true), 7);
});

test('wavHeader: clamps huge sizes to uint32', () => {
  const v = new DataView(wavHeader(48000, 2, 2 ** 33));
  assert.equal(v.getUint32(4, true), 0xffffffff);
  assert.equal(v.getUint32(40, true), 0xffffffff - 36);
});

test('wavHeader: validation', () => {
  assert.throws(() => wavHeader(0, 2, 0), RangeError);
  assert.throws(() => wavHeader(44100.5, 2, 0), RangeError);
  assert.throws(() => wavHeader(44100, 0, 0), RangeError);
  assert.throws(() => wavHeader(44100, 2, -1), RangeError);
  assert.throws(() => wavHeader(44100, 2, 1.5), RangeError);
  assert.throws(() => wavHeader(44100, 2, 0, 12), RangeError);
});

test('parseWavHeader round-trips wavHeader', () => {
  const info = parseWavHeader(wavHeader(44100, 2, 1000));
  assert.deepEqual(info, {
    format: 1, channels: 2, sampleRate: 44100, byteRate: 176400, blockAlign: 4, bitsPerSample: 16,
    dataBytes: 1000, dataOffset: 44, availableBytes: 0,
  });
});

test('parseWavHeader walks LIST chunks (odd size padded) and accepts typed-array views', () => {
  // RIFF | WAVE | LIST(5 bytes + pad) | fmt | junk(4) | data(4)
  const listSize = 5;
  const bytes = new Uint8Array(12 + 8 + listSize + 1 + 24 + 12 + 8 + 4);
  const v = new DataView(bytes.buffer);
  const put = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, bytes.length - 8, true);
  put(8, 'WAVE');
  let o = 12;
  put(o, 'LIST'); v.setUint32(o + 4, listSize, true); put(o + 8, 'INFOx'); o += 8 + listSize + 1;
  put(o, 'fmt '); v.setUint32(o + 4, 16, true);
  v.setUint16(o + 8, 1, true); v.setUint16(o + 10, 1, true); v.setUint32(o + 12, 22050, true);
  v.setUint32(o + 16, 44100, true); v.setUint16(o + 20, 2, true); v.setUint16(o + 22, 16, true);
  o += 24;
  put(o, 'junk'); v.setUint32(o + 4, 4, true); o += 12;
  put(o, 'data'); v.setUint32(o + 4, 4, true); v.setInt16(o + 8, 1234, true); v.setInt16(o + 10, -1, true);
  const dataOffset = o + 8;
  const info = parseWavHeader(bytes);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataBytes, 4);
  assert.equal(info.dataOffset, dataOffset);
  assert.equal(info.availableBytes, 4);
  // view with a non-zero byteOffset
  const padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes, 3);
  assert.equal(parseWavHeader(padded.subarray(3)).dataOffset, dataOffset);
});

test('parseWavHeader errors', () => {
  assert.throws(() => parseWavHeader(new ArrayBuffer(4)), /not a RIFF/);
  const bad = new Uint8Array(wavHeader(44100, 1, 0));
  bad[8] = 'X'.charCodeAt(0);
  assert.throws(() => parseWavHeader(bad.buffer), /not a RIFF/);
  // no data chunk: truncate after fmt
  assert.throws(() => parseWavHeader(wavHeader(44100, 1, 0).slice(0, 36)), /no data chunk/);
  // no fmt chunk: only RIFF/WAVE
  assert.throws(() => parseWavHeader(wavHeader(44100, 1, 0).slice(0, 12)), /no fmt chunk/);
  // data before fmt
  const h = new Uint8Array(wavHeader(44100, 1, 0));
  const swapped = new Uint8Array(12 + 8 + 24);
  swapped.set(h.subarray(0, 12));
  swapped.set(h.subarray(36, 44), 12);
  swapped.set(h.subarray(12, 36), 20);
  assert.throws(() => parseWavHeader(swapped), /data chunk before fmt/);
  // fmt chunk truncated
  assert.throws(() => parseWavHeader(wavHeader(44100, 1, 0).slice(0, 30)), /no fmt chunk/);
});

test('interleaveToInt16: scaling, clamp, round, NaN', () => {
  const out = interleaveToInt16([new Float32Array([0, 1, -1, 2, -2, 0.5, -0.5, NaN, 1e-6])]);
  assert.deepEqual([...out], [0, 32767, -32768, 32767, -32768, 16384, -16384, 0, 0]);
  assert.equal(int16Encode, interleaveToInt16);
});

test('interleaveToInt16: interleaves, pads shorter channels, odd lengths', () => {
  const L = new Float32Array([0.1, 0.2, 0.3]);
  const R = new Float32Array([-0.1, -0.2]);
  const out = interleaveToInt16([L, R]);
  assert.equal(out.length, 6);
  const f = Math.fround;
  assert.deepEqual([...out], [
    Math.round(f(0.1) * 32767), Math.round(f(-0.1) * 32768), Math.round(f(0.2) * 32767),
    Math.round(f(-0.2) * 32768), Math.round(f(0.3) * 32767), 0,
  ]);
  assert.equal(interleaveToInt16([]).length, 0);
  assert.equal(interleaveToInt16(undefined).length, 0);
  assert.equal(interleaveToInt16([new Float32Array(0)]).length, 0);
});

test('int16ToFloat32: de-interleaves, inverse scaling, drops partial frame', () => {
  const [l, r] = int16ToFloat32(new Int16Array([32767, -32768, 0, 16384, 5]), 2);
  assert.deepEqual([...l], [1, 0]);
  assert.deepEqual([...r], [-1, Math.fround(16384 / 32767)]);
  const [mono] = int16ToFloat32(new Int16Array([-16384]));
  assert.equal(mono[0], -0.5);
  assert.equal(int16ToFloat32(new Int16Array(3), 0).length, 1); // channels < 1 → 1
});

test('float → int16 → float round trip within 1 LSB', () => {
  const n = 1001; // odd
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = Math.sin(i * 0.05);
    R[i] = Math.cos(i * 0.031) * 0.7;
  }
  const [l2, r2] = int16ToFloat32(interleaveToInt16([L, R]), 2);
  assert.equal(l2.length, n);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(l2[i] - L[i]) <= 1 / 32767, `L ${i}`);
    assert.ok(Math.abs(r2[i] - R[i]) <= 1 / 32767, `R ${i}`);
  }
  // int16 → float → int16 is exact
  const all = new Int16Array(65536);
  for (let i = 0; i < 65536; i++) all[i] = i - 32768;
  assert.deepEqual(interleaveToInt16(int16ToFloat32(all, 1)), all);
});

test('encodeWav: header + little-endian data, parses back', () => {
  const L = new Float32Array([0, 0.5, -1]);
  const R = new Float32Array([1, -0.5, 0]);
  const buf = encodeWav([L, R], 48000);
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 44 + 3 * 2 * 2);
  const info = parseWavHeader(buf);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataBytes, 12);
  assert.equal(info.availableBytes, 12);
  assert.equal(new DataView(buf).getUint32(4, true), 36 + 12);
  const v = new DataView(buf, info.dataOffset);
  const samples = Array.from({ length: 6 }, (_, i) => v.getInt16(i * 2, true));
  assert.deepEqual(samples, [0, 32767, 16384, -16384, -32768, 0]);
  const [l2, r2] = int16ToFloat32(new Int16Array(buf.slice(44)), 2);
  assert.ok(Math.abs(l2[1] - 0.5) < 1e-4 && Math.abs(r2[1] + 0.5) < 1e-4);
});

test('encodeWav: mono odd length and errors', () => {
  const buf = encodeWav([new Float32Array(7).fill(0.25)], 44100);
  assert.equal(buf.byteLength, 44 + 14);
  assert.equal(parseWavHeader(buf).channels, 1);
  assert.throws(() => encodeWav([], 44100), RangeError);
  assert.throws(() => encodeWav(null, 44100), RangeError);
  assert.throws(() => encodeWav([new Float32Array(1)], 0), RangeError);
});
