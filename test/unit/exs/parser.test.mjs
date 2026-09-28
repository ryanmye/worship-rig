// EXS parser ↔ fixture writer round trips. Both sides share tools/exs/layout.mjs, so these tests prove the parser
// reads what the layout table describes and survives damage — not that the table matches Apple's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExs, detectEndian, readCString, ExsFormatError } from '../../../tools/exs/parser.mjs';
import { writeExs } from '../../../tools/exs/writer.mjs';
import { HEADER_SIZE, ZONE, SAMPLE, MAGIC_OFFSET } from '../../../tools/exs/layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, '../../../tools/exs/fixtures', n), 'utf8'));

test('little-endian piano fixture round-trips', () => {
  const desc = fixture('test-grand-piano.json');
  const p = parseExs(writeExs(desc));
  assert.equal(p.bigEndian, false);
  assert.equal(p.magic, 'TBOS');
  assert.equal(p.name, 'Test Grand Piano');
  assert.equal(p.zones.length, desc.zones.length);
  assert.equal(p.samples.length, desc.samples.length);
  assert.equal(p.groups.length, 2);
  assert.deepEqual(p.warnings, []);
  const z = p.zones[0];
  assert.equal(z.name, 'TP 48 v1');
  assert.equal(z.rootNote, 48);
  assert.equal(z.keyLow, 36);
  assert.equal(z.keyHigh, 49);
  assert.equal(z.velLow, 1);
  assert.equal(z.velHigh, 50);
  assert.equal(z.velRangeOn, true);
  assert.equal(z.pitch, true);
  assert.equal(z.groupIndex, 0);
  assert.equal(z.sampleIndex, 0);
  const rel = p.zones.find((x) => x.name === 'rel 60');
  assert.equal(rel.velRangeOn, false);
  assert.equal(rel.groupIndex, 1);
  assert.equal(p.groups[1].name, 'Key Off');
  assert.equal(p.groups[1].trigger, 1);
  assert.equal(p.groups[0].trigger, 0);
  assert.equal(p.groups[0].polyphony, 64);
  const s = p.samples[0];
  assert.equal(s.fileName, 'TP 48 v1.wav');
  assert.equal(s.path, '/Library/Application Support/Logic/EXS Factory Samples/Test Piano');
  assert.equal(s.length, 44100);
  assert.equal(s.sampleRate, 44100);
  assert.equal(s.bitDepth, 24);
  assert.equal(s.channels, 2);
  assert.equal(s.type, 'WAVE');
  assert.ok(p.chunks.some((c) => c.typeName === 'params'), 'params chunk walked and ignored');
});

test('big-endian strings fixture round-trips (loops, coarse tune, slice, HFS path)', () => {
  const desc = fixture('test-strings.json');
  const buf = writeExs(desc);
  assert.equal(buf.toString('latin1', MAGIC_OFFSET, MAGIC_OFFSET + 4), 'SOBT');
  const p = parseExs(buf);
  assert.equal(p.bigEndian, true);
  assert.equal(p.zones.length, 7);
  assert.equal(p.zones[0].loopOn, true);
  assert.equal(p.zones[0].loopStart, 22050);
  assert.equal(p.zones[0].loopEnd, 80000);
  assert.equal(p.zones[1].coarseTune, -1);
  assert.equal(p.zones[2].sampleStart, 4410);
  assert.equal(p.zones[2].sampleEnd, 48510);
  assert.equal(p.zones[3].groupIndex, -1);
  assert.equal(p.samples[0].path, 'Macintosh HD:Library:Application Support:Logic:EXS Factory Samples:Test Strings');
  assert.equal(p.samples[0].bitDepth, 16);
  assert.equal(p.samples[0].type, 'AIFF');
  assert.equal(p.samples[6].length, 88200);
});

test('same description gives identical parse in both endiannesses', () => {
  const desc = fixture('test-grand-piano.json');
  const a = parseExs(writeExs({ ...desc, endian: 'little' }));
  const b = parseExs(writeExs({ ...desc, endian: 'big' }));
  const strip = (p) => ({ ...p, bigEndian: null, magic: null, chunks: null, zones: p.zones.map(({ offset, ...z }) => z), groups: p.groups.map(({ offset, ...g }) => g), samples: p.samples.map(({ offset, ...s }) => s) });
  assert.deepEqual(strip(a), strip(b));
});

test('old short sample chunk (no file-name field) falls back to the chunk name', () => {
  const p = parseExs(writeExs({ name: 'x', zones: [{ root: 60 }], samples: [{ name: 'Old Name.aif', short: true, path: '/a/b' }] }));
  assert.equal(p.samples[0].fileName, 'Old Name.aif');
  assert.equal(p.samples[0].path, '/a/b');
  assert.deepEqual(p.warnings, []);
});

test('truncated file: keeps complete chunks, warns, does not throw', () => {
  const buf = writeExs(fixture('test-grand-piano.json'));
  const cut = buf.subarray(0, HEADER_SIZE + 3 * (HEADER_SIZE + ZONE.WRITE_DATA_SIZE) + 120);
  const p = parseExs(cut);
  assert.equal(p.zones.length, 3);
  assert.ok(p.warnings.some((w) => /runs past end of file/.test(w)));
  assert.ok(p.warnings.some((w) => /sample index .* out of range/.test(w)));
  assert.ok(p.zones.every((z) => z.invalid));
});

test('garbage after valid chunks stops the walk with a warning', () => {
  const buf = Buffer.concat([writeExs({ name: 'x', zones: [{ root: 60, sample: 0 }], samples: [{ fileName: 'a.wav' }] }), Buffer.alloc(100, 0x41)]);
  const p = parseExs(buf);
  assert.equal(p.zones.length, 1);
  assert.equal(p.samples.length, 1);
  assert.ok(p.warnings.some((w) => /unexpected magic/.test(w)));
});

test('not an EXS file → ExsFormatError', () => {
  assert.throws(() => parseExs(Buffer.from('hello')), ExsFormatError);
  assert.throws(() => parseExs(Buffer.alloc(200)), /not an EXS file/);
  assert.throws(() => detectEndian(Buffer.alloc(10)), /too short/);
});

test('JBOS / SOBJ magic variants are accepted', () => {
  const le = writeExs({ name: 'x', zones: [{ root: 60 }], samples: [{ fileName: 'a.wav' }] });
  for (let off = 0; off < le.length; ) {
    const size = le.readUInt32LE(off + 4);
    le.write('JBOS', off + MAGIC_OFFSET, 'latin1');
    off += HEADER_SIZE + size;
  }
  const p = parseExs(le);
  assert.equal(p.bigEndian, false);
  assert.equal(p.zones.length, 1);
  assert.equal(p.samples[0].fileName, 'a.wav');
});

test('out-of-range values are clamped/sanitised', () => {
  const buf = writeExs({ name: 'x', zones: [{ root: 60, keyLow: 70, keyHigh: 50, velLow: 90, velHigh: 20, sample: 5 }], samples: [{ fileName: 'a.wav', sampleRate: 1, bitDepth: 999, channels: 77 }] });
  const p = parseExs(buf);
  const z = p.zones[0];
  assert.equal(z.keyLow, 50);
  assert.equal(z.keyHigh, 70);
  assert.equal(z.velLow, 20);
  assert.equal(z.velHigh, 90);
  assert.equal(z.invalid, true);
  assert.equal(p.samples[0].sampleRate, 0);
  assert.equal(p.samples[0].bitDepth, 0);
  assert.equal(p.samples[0].channels, 0);
});

test('bit depth stored as a single byte at offset 96 is still found', () => {
  const buf = writeExs({ name: 'x', zones: [{ root: 60 }], samples: [{ fileName: 'a.wav', bitDepth: 0 }] });
  const sampleOff = buf.length - (HEADER_SIZE + SAMPLE.WRITE_DATA_SIZE);
  buf.writeUInt32LE(0x18000000, sampleOff + SAMPLE.BIT_DEPTH); // LE u32 → bytes 00 00 00 18
  assert.equal(parseExs(buf).samples[0].bitDepth, 24);
});

test('readCString: NUL-terminated, UTF-8 when valid else latin1', () => {
  assert.equal(readCString(Buffer.from('abc\0def'), 0, 7), 'abc');
  assert.equal(readCString(Buffer.from('Bösendorfer', 'utf8'), 0, 20), 'Bösendorfer');
  assert.equal(readCString(Buffer.from([0x42, 0xf6, 0x73, 0]), 0, 4), 'Bös');
  assert.equal(readCString(Buffer.alloc(4), 10, 4), '');
});
