#!/usr/bin/env node
// T07: reference vectors for the native MIDI byte parser (native/core/src/midi/midi_parser.h): the REAL
// app/js/midi.js MidiInput (_parseBytes, _noteInput, _dispatch, bendValue) fed with random byte streams on two ports
// (running status per port, SysEx, realtime bytes inside messages, system common, stray data bytes, aftertouch,
// chunk boundaries anywhere). Pure JS (node), no Web MIDI.
//
//   node tools/golden/vectors/dump-midi.mjs   → tools/golden/vectors/data/midi-parse.txt
//
// Format (hex = exact binary64 bit pattern):
//   chunk <port> <bytes as hex pairs>   one _parseBytes call, followed by the events it emitted, in order:
//   input <port>                        the lowres2 'input' wake signal
//   noteon <note> <velocity> <channel> | noteoff <note> <velocity> <channel> | cc <cc> <value> <hex value01> <channel>
//   bend <hex value> <raw> <channel>   | program <program> <channel>
//   bendvalue <lsb> <msb> <hex>         bendValue()
//   velsens <sens> <hex v> <out>        app/js/controller.js applyVelocitySens(v, sens) (the direct path's velocity)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(HERE, 'data', 'midi-parse.txt');

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const hex64 = (x) => {
  f64[0] = x;
  return u64[0].toString(16).padStart(16, '0');
};
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { MidiInput, bendValue } = await import(path.join(ROOT, 'app/js/midi.js'));
const lines = [];
const m = new MidiInput({ nav: null, now: () => 0, warn: () => {} });
m._emit = (type, d) => {
  if (type === 'input') lines.push(`input ${d.inputId}`);
  else if (type === 'noteon' || type === 'noteoff') lines.push(`${type} ${d.note} ${d.velocity} ${d.channel}`);
  else if (type === 'cc') lines.push(`cc ${d.cc} ${d.value} ${hex64(d.value01)} ${d.channel}`);
  else if (type === 'bend') lines.push(`bend ${hex64(d.value)} ${d.raw} ${d.channel}`);
  else if (type === 'program') lines.push(`program ${d.program} ${d.channel}`);
  // 'activity' follows every dispatched message: not a separate vector
};

const r = mulberry32(0x0d1d1);
const pick = (a) => a[Math.floor(r() * a.length)];
function randomByte() {
  const x = r();
  if (x < 0.5) return Math.floor(r() * 128); // data
  if (x < 0.8) return pick([0x80, 0x90, 0xb0, 0xc0, 0xe0, 0x90, 0x90]) | Math.floor(r() * 16); // channel status
  if (x < 0.86) return pick([0xa0, 0xd0]) | Math.floor(r() * 16); // aftertouch
  if (x < 0.93) return pick([0xf8, 0xfa, 0xfb, 0xfc, 0xfe, 0xff, 0xf9, 0xfd]); // realtime
  if (x < 0.97) return pick([0xf0, 0xf7]); // sysex
  return pick([0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6]); // system common
}
function musicalMessage() {
  const ch = Math.floor(r() * 16);
  const t = pick(['on', 'on', 'off', 'cc', 'bend', 'prog', 'vel0', 'run']);
  const d = () => Math.floor(r() * 128);
  if (t === 'on') return [0x90 | ch, d(), 1 + Math.floor(r() * 127)];
  if (t === 'off') return [0x80 | ch, d(), d()];
  if (t === 'cc') return [0xb0 | ch, pick([1, 7, 11, 64, 64, 120, 123, d()]), d()];
  if (t === 'bend') return [0xe0 | ch, pick([0, 127, d()]), pick([0, 64, 127, d()])];
  if (t === 'prog') return [0xc0 | ch, d()];
  if (t === 'vel0') return [0x90 | ch, d(), 0];
  return [d(), d()]; // running status continuation
}

const header = [
  '# MIDI parser vectors from the real app/js/midi.js (tools/golden/vectors/dump-midi.mjs, node ' + process.version + ')',
];
for (let n = 0; n < 1200; n++) {
  const port = r() < 0.7 ? 'a' : 'b';
  const bytes = [];
  const len = 1 + Math.floor(r() * 9);
  for (let i = 0; i < len; i++) {
    if (r() < 0.6) bytes.push(...musicalMessage());
    else bytes.push(randomByte());
  }
  if (r() < 0.05) bytes.length = 0; // empty chunk
  lines.push(`chunk ${port} ${bytes.map((b) => b.toString(16).padStart(2, '0')).join('') || '-'}`);
  m._parseBytes(Uint8Array.from(bytes), 0, port);
}
// bendValue over the whole 14-bit range corners
for (const [l, h] of [[0, 0], [127, 127], [0, 64], [127, 63], [1, 64], [0, 1], [100, 20]]) {
  lines.push(`bendvalue ${l} ${h} ${hex64(bendValue(l, h))}`);
}
const { applyVelocitySens } = await import(path.join(ROOT, 'app/js/controller.js'));
for (const sens of ['soft', 'hard', 'normal', 'fixed']) {
  const vs = [];
  for (let v = 0; v <= 130; v++) vs.push(v);
  for (let i = 0; i < 40; i++) vs.push(r() * 140 - 5);
  for (const v of vs) lines.push(`velsens ${sens} ${hex64(v)} ${applyVelocitySens(v, sens)}`);
}
fs.writeFileSync(OUT, [...header, ...lines].join('\n') + '\n');
console.log(`wrote ${OUT}: ${lines.length} lines`);
