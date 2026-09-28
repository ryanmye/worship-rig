#!/usr/bin/env node
// Synthetic .exs writer for tests and for exercising --dump / --list without a Mac.
//   node tools/exs/writer.mjs <description.json> <out.exs>
// Uses the same offset table as the parser (./layout.mjs), so a round trip proves the two agree with each other —
// NOT that either matches Apple's files. See layout.mjs for provenance.
//
// Description (all fields optional except zones/samples):
// { "name": "Test Piano", "endian": "little"|"big",
//   "groups":  [{ "name", "volume", "pan", "polyphony", "mute", "minVel", "maxVel", "trigger": 0|1, "keyLow", "keyHigh",
//                "selectCC": { "number": 64, "low": 64, "high": 127 } }],
//   "samples": [{ "fileName", "name", "path", "length", "sampleRate", "bitDepth", "channels", "type", "short": bool }],
//   "zones":   [{ "name", "root", "fineTune", "coarseTune", "pan", "volume", "keyLow", "keyHigh",
//                "velLow", "velHigh", "velRangeOn" (default: true iff velLow/velHigh given), "oneShot", "pitchOff",
//                "reverse", "sampleStart", "sampleEnd", "loopStart", "loopEnd", "loopOn", "group", "sample",
//                "segment2": { "start", "end" } }],
//   "extraChunks": [{ "type": 4, "size": 16, "name": "params" }] }
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HEADER_SIZE, NAME_OFFSET, NAME_LEN, MAGIC_OFFSET, HEADER, CHUNK, ZONE, ZONE_OPT, LOOP_OPT, GROUP, GROUP_OPT, GROUP_SELECT, SAMPLE } from './layout.mjs';

function chunk(type, index, name, dataSize, bigEndian) {
  const b = Buffer.alloc(HEADER_SIZE + dataSize);
  const w32 = (o, v) => (bigEndian ? b.writeUInt32BE(v >>> 0, o) : b.writeUInt32LE(v >>> 0, o));
  w32(0, ((type & 0x0f) << 24) | 0x0101);
  w32(4, dataSize);
  w32(8, index);
  w32(12, 0);
  b.write(bigEndian ? 'SOBT' : 'TBOS', MAGIC_OFFSET, 'latin1');
  writeStr(b, NAME_OFFSET, NAME_LEN, name || '');
  return b;
}

function writeStr(b, off, len, s) {
  const bytes = Buffer.from(String(s), 'utf8').subarray(0, len - 1);
  bytes.copy(b, off);
}

function writers(b, bigEndian) {
  return {
    u8: (o, v) => b.writeUInt8((v ?? 0) & 0xff, o),
    i8: (o, v) => b.writeInt8(Math.max(-128, Math.min(127, v ?? 0)), o),
    u32: (o, v) => (bigEndian ? b.writeUInt32BE((v ?? 0) >>> 0, o) : b.writeUInt32LE((v ?? 0) >>> 0, o)),
    i32: (o, v) => (bigEndian ? b.writeInt32BE(v ?? 0, o) : b.writeInt32LE(v ?? 0, o)),
  };
}

/**
 * @param {object} desc see header comment
 * @returns {Buffer}
 */
export function writeExs(desc) {
  const bigEndian = desc.endian === 'big';
  const head = chunk(CHUNK.HEADER, 0, desc.name || 'Untitled', HEADER.MIN_LENGTH - HEADER_SIZE, bigEndian);
  if (!desc.noCounts) {
    const hw = writers(head, bigEndian);
    hw.u32(HEADER.ZONE_COUNT, (desc.zones || []).length);
    hw.u32(HEADER.GROUP_COUNT, (desc.groups || []).length);
    hw.u32(HEADER.SAMPLE_COUNT, (desc.samples || []).length);
    hw.u32(HEADER.PARAM_COUNT, (desc.extraChunks || []).filter((x) => (x.type ?? CHUNK.PARAMS) === CHUNK.PARAMS).length);
  }
  const parts = [head];
  (desc.zones || []).forEach((z, i) => {
    const b = chunk(CHUNK.ZONE, i, z.name ?? `zone${i}`, z.segment2 ? ZONE.SEGMENT2_END + 4 - HEADER_SIZE : ZONE.WRITE_DATA_SIZE, bigEndian);
    const w = writers(b, bigEndian);
    const velGiven = z.velLow != null || z.velHigh != null;
    const velOn = z.velRangeOn ?? velGiven;
    let opts = 0;
    if (z.oneShot) opts |= ZONE_OPT.ONESHOT;
    if (z.pitchOff) opts |= ZONE_OPT.PITCH_OFF;
    if (z.reverse) opts |= ZONE_OPT.REVERSE;
    if (velOn) opts |= ZONE_OPT.VEL_RANGE_ON;
    w.u8(ZONE.OPTIONS, opts);
    w.u8(ZONE.ROOT, z.root ?? 60);
    w.i8(ZONE.FINE_TUNE, z.fineTune);
    w.i8(ZONE.PAN, z.pan);
    w.i8(ZONE.VOLUME, z.volume);
    w.u8(ZONE.KEY_LOW, z.keyLow ?? z.root ?? 60);
    w.u8(ZONE.KEY_HIGH, z.keyHigh ?? z.root ?? 60);
    w.u8(ZONE.VEL_LOW, z.velLow ?? 0);
    w.u8(ZONE.VEL_HIGH, z.velHigh ?? 127);
    w.u32(ZONE.SAMPLE_START, z.sampleStart);
    w.u32(ZONE.SAMPLE_END, z.sampleEnd);
    w.u32(ZONE.LOOP_START, z.loopStart);
    w.u32(ZONE.LOOP_END, z.loopEnd);
    w.u8(ZONE.LOOP_OPTIONS, z.loopOn ? LOOP_OPT.ON : 0);
    w.i8(ZONE.COARSE_TUNE, z.coarseTune);
    w.i32(ZONE.GROUP_INDEX, z.group ?? -1);
    w.u32(ZONE.SAMPLE_INDEX, z.sample ?? i);
    if (z.segment2) {
      w.u32(ZONE.SEGMENT2_START, z.segment2.start);
      w.u32(ZONE.SEGMENT2_END, z.segment2.end);
    }
    parts.push(b);
  });
  (desc.groups || []).forEach((g, i) => {
    const b = chunk(CHUNK.GROUP, i, g.name ?? `group${i}`, g.short ? GROUP.WRITE_DATA_SIZE : GROUP.KEY_HIGH + 4 - HEADER_SIZE, bigEndian);
    const w = writers(b, bigEndian);
    w.i8(GROUP.VOLUME, g.volume);
    w.i8(GROUP.PAN, g.pan);
    w.u8(GROUP.POLYPHONY, g.polyphony ?? 16);
    w.u8(GROUP.OPTIONS, g.mute ? GROUP_OPT.MUTE : 0);
    w.u8(GROUP.MIN_VEL, g.minVel ?? 0);
    w.u8(GROUP.MAX_VEL, g.maxVel ?? 127);
    w.u8(GROUP.TRIGGER, g.trigger ?? 0);
    if (!g.short) {
      if (g.selectCC) {
        w.u8(GROUP.SELECT_TYPE, GROUP_SELECT.CONTROLLER);
        w.u8(GROUP.SELECT_NUMBER, g.selectCC.number ?? 64);
        w.u8(GROUP.SELECT_LOW, g.selectCC.low ?? 0);
        w.u8(GROUP.SELECT_HIGH, g.selectCC.high ?? 127);
      }
      w.u8(GROUP.KEY_LOW, g.keyLow ?? 0);
      w.u8(GROUP.KEY_HIGH, g.keyHigh ?? 127);
    }
    parts.push(b);
  });
  (desc.samples || []).forEach((s, i) => {
    const size = s.short ? SAMPLE.FILE_NAME - HEADER_SIZE : SAMPLE.WRITE_DATA_SIZE;
    const b = chunk(CHUNK.SAMPLE, i, s.name ?? s.fileName ?? `sample${i}`, size, bigEndian);
    const w = writers(b, bigEndian);
    w.u32(SAMPLE.LENGTH, s.length ?? 44100);
    w.u32(SAMPLE.SAMPLE_RATE, s.sampleRate ?? 44100);
    w.u32(SAMPLE.BIT_DEPTH, s.bitDepth ?? 16);
    w.u32(SAMPLE.CHANNELS, s.channels ?? 2);
    const t = (s.type || 'WAVE').slice(0, 4).padEnd(4, ' ');
    b.write(bigEndian ? t : t.split('').reverse().join(''), SAMPLE.TYPE, 'latin1'); // 4CC as a u32 in file byte order
    writeStr(b, SAMPLE.PATH, SAMPLE.PATH_LEN, s.path ?? '');
    if (!s.short) writeStr(b, SAMPLE.FILE_NAME, SAMPLE.FILE_NAME_LEN, s.fileName ?? s.name ?? '');
    parts.push(b);
  });
  for (const x of desc.extraChunks || []) parts.push(chunk(x.type ?? CHUNK.PARAMS, 0, x.name ?? '', x.size ?? 0, bigEndian));
  return Buffer.concat(parts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [inp, out] = process.argv.slice(2);
  if (!inp || !out) {
    console.error('usage: node tools/exs/writer.mjs <description.json> <out.exs>');
    process.exit(2);
  }
  fs.writeFileSync(out, writeExs(JSON.parse(fs.readFileSync(inp, 'utf8'))));
  console.log(`wrote ${out}`);
}
