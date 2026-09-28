import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavHeader, parseWavHeader } from '../../../app/js/shared/wav.js';
import { ElectronSink, MemorySink, recordingFilename } from '../../../app/js/recorder.js';

test('recordingFilename: "Rig YYYY-MM-DD HHmm.wav"', () => {
  assert.equal(recordingFilename(new Date(2026, 8, 7, 9, 5)), 'Rig 2026-09-07 0905.wav');
});

test('wav header for a stereo 16-bit 48 kHz stream', () => {
  const h = parseWavHeader(wavHeader(48000, 2, 192000));
  assert.equal(h.format, 1);
  assert.equal(h.channels, 2);
  assert.equal(h.sampleRate, 48000);
  assert.equal(h.bitsPerSample, 16);
  assert.equal(h.blockAlign, 4);
  assert.equal(h.byteRate, 192000);
  assert.equal(h.dataBytes, 192000);
  assert.equal(h.dataOffset, 44);
});

/** Mock window.rig that behaves like main.js (positional file with header patches). */
function mockRig() {
  const files = new Map();
  let next = 1;
  const log = [];
  return {
    isElectron: true,
    files,
    log,
    streamOpen: async (name) => { const id = next++; files.set(id, { name, bytes: new Uint8Array(0), closed: false }); log.push(['open', name]); return { id, path: `/Music/Worship Rig/${name}` }; },
    streamWrite: async (id, buf) => {
      const f = files.get(id);
      const b = new Uint8Array(buf);
      const out = new Uint8Array(f.bytes.length + b.length);
      out.set(f.bytes);
      out.set(b, f.bytes.length);
      f.bytes = out;
      log.push(['write', b.length]);
      return { bytes: out.length };
    },
    streamPatchHeader: async (id, buf) => { files.get(id).bytes.set(new Uint8Array(buf), 0); log.push(['patch', new DataView(buf).getUint32(40, true)]); return { ok: true }; },
    streamClose: async (id) => { const f = files.get(id); f.closed = true; log.push(['close']); return { path: `/Music/Worship Rig/${f.name}`, bytes: f.bytes.length }; },
  };
}

test('ElectronSink: provisional header, batched writes, periodic header patch, final header', async () => {
  const rig = mockRig();
  const sink = new ElectronSink(rig, 'Rig test.wav', { flushBytes: 32768 });
  await sink.open(48000, 2);
  assert.equal(parseWavHeader(rig.files.get(1).bytes).dataBytes, 0, 'provisional header says 0 bytes');
  const chunk = () => {
    const a = new Int16Array(4096 * 2);
    for (let i = 0; i < a.length; i++) a[i] = (i % 200) - 100;
    return a.buffer;
  };
  let bytes = 0;
  for (let i = 0; i < 5; i++) {
    sink.write(chunk());
    bytes += 16384;
  }
  await sink.patchHeader(bytes);
  assert.equal(parseWavHeader(rig.files.get(1).bytes).dataBytes, bytes, 'mid-recording patch (crash safety)');
  sink.write(chunk());
  bytes += 16384;
  const res = await sink.close(bytes);
  const f = rig.files.get(1);
  assert.equal(f.closed, true);
  assert.equal(res.path, '/Music/Worship Rig/Rig test.wav');
  const h = parseWavHeader(f.bytes);
  assert.equal(h.dataBytes, bytes);
  assert.equal(f.bytes.length, 44 + bytes);
  assert.ok(rig.log.filter((l) => l[0] === 'write').length <= 5, 'writes are batched');
  const pcm = new Int16Array(f.bytes.buffer, 44, bytes / 2);
  assert.equal(pcm[0], -100);
  assert.equal(pcm[199], 99);
});

test('ElectronSink surfaces streamOpen errors', async () => {
  const sink = new ElectronSink({ streamOpen: async () => ({ error: 'path not allowed' }) }, 'x.wav');
  await assert.rejects(sink.open(44100, 2), /path not allowed/);
});

test('MemorySink produces a complete WAV blob', async () => {
  const s = new MemorySink('m.wav');
  await s.open(44100, 2);
  s.write(new Int16Array([1, 2, 3, 4]).buffer);
  const r = await s.close(8);
  const buf = await r.blob.arrayBuffer();
  const h = parseWavHeader(buf);
  assert.equal(h.sampleRate, 44100);
  assert.equal(h.dataBytes, 8);
  assert.deepEqual([...new Int16Array(buf, 44, 4)], [1, 2, 3, 4]);
  assert.equal(r.blob.type, 'audio/wav');
});
