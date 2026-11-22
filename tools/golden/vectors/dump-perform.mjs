// T14 reference vectors for the perform Model (native/core/tests/test_perform*.cpp): touch curves
// (app/js/shared/touch-curve.js compileTouch / touchAt / pedalCurve, via engine/audio.js curveVelocity) and the
// held-chord readout (app/js/shared/chords.js chordName with music.js spellingPreference). The touch values are
// computed in the golden Chromium (lib.mjs openPage): node 22's V8 Math.pow differs from Chromium 157's (std::pow)
// by 1 ulp on some inputs. The chords have no arithmetic and run in node.
// Usage: node tools/golden/vectors/dump-perform.mjs -> data/perform-touch.txt, data/perform-chords.txt
import fs from 'node:fs';
import path from 'node:path';
import { DATA, ROOT, openPage } from './lib.mjs';

const imp = (p) => import(path.join(ROOT, p));
const { chordName } = await imp('app/js/shared/chords.js');
const { spellingPreference } = await imp('app/js/shared/music.js');

const hex = (x) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString('hex');
};

// ---- touch: `named <curve> <vel> <hex>`, `custom <shape> <min> <max> <top> <vel> <hex>`, `pedal <log> <x> <hex>`
const specs = [[1, 0, 1, 127], [0.6, 0, 1, 127], [1.6, 0.1, 0.9, 100], [2.5, 0.8, 0.2, 64], [0.25, 0, 1, 20],
  [4, 0.3, 0.3, 127], [1.65, 0.05, 1, 112], [0.1, -1, 2, 300], [1, 0.5, 1, 90.4]];
const { browser, page, server, version } = await openPage();
const rows = await page.evaluate(async (specs) => {
  const { compileTouch, touchAt, pedalCurve } = await import('/js/shared/touch-curve.js');
  const { curveVelocity } = await import('/js/engine/audio.js');
  const out = [];
  for (const curve of ['soft', 'normal', 'hard', 'fixed']) {
    for (let v = 1; v <= 127; v++) out.push(['named', curve, v, curveVelocity(v, curve)]);
  }
  for (const [shape, min, max, top] of specs) {
    const c = compileTouch({ shape, min, max, top });
    for (const v of [1, 7, 20, 33, 64, 90, 100, 111, 126, 127]) {
      out.push(['custom', shape, min, max, top, v, touchAt(c, v)]);
    }
  }
  for (const log of [0, 1]) {
    for (let i = 0; i <= 20; i++) out.push(['pedal', log, i / 20, pedalCurve(i / 20, log ? 'log' : undefined)]);
  }
  return out;
}, specs);
await browser.close();
server.close();
const touch = [`# T14 perform touch vectors (dump-perform.mjs, ${version}). hex = IEEE-754 double, big-endian`];
for (const r of rows) touch.push([...r.slice(0, -1), hex(r[r.length - 1])].join(' '));
fs.writeFileSync(path.join(DATA, 'perform-touch.txt'), touch.join('\n') + '\n');

// ---- chords: `chord <pc,pc,..> <bass> <sharp 0|1> <name|-> <root> <quality> <bass|-> <omit5 0|1>`
// Held-note sets as the engine names them (sorted MIDI notes -> pcs, bass = lowest), plus spelling per key.
const chords = ['# T14 perform chord vectors (dump-perform.mjs): audio.js heldChord'];
const sets = [];
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
for (let root = 0; root < 12; root++) {
  for (const iv of [[0, 4, 7], [0, 3, 7], [0, 2, 7], [0, 5, 7], [0, 7], [0, 4, 7, 10], [0, 4, 11], [0, 3, 10],
    [0, 3, 6], [0, 4, 8], [0, 2, 4, 7], [0, 4, 7, 9], [0, 2, 4, 10], [0, 5, 7, 10], [0, 3, 6, 9], [0, 3, 6, 10]]) {
    sets.push(iv.map((x) => 48 + root + x));
    sets.push(iv.map((x, j) => 48 + root + x + (j === 0 ? 12 : 0)).sort((a, b) => a - b)); // first inversion
  }
}
for (let k = 0; k < 200; k++) {
  const n = 1 + Math.floor(rnd() * 5);
  const s = new Set();
  while (s.size < n) s.add(36 + Math.floor(rnd() * 48));
  sets.push([...s].sort((a, b) => a - b));
}
for (const notes of sets) {
  for (const sharp of [0, 1]) {
    const pcs = notes.map((x) => x % 12);
    const c = chordName(pcs, notes[0] % 12, sharp ? 'sharp' : 'flat');
    const r = c ? `${c.name} ${c.root} ${c.quality} ${c.bass ?? '-'} ${c.omit5 ? 1 : 0}` : '- 0 - - 0';
    chords.push(`chord ${pcs.join(',')} ${notes[0] % 12} ${sharp} ${r}`);
  }
}
for (let pc = 0; pc < 12; pc++) {
  for (const minor of [0, 1]) {
    chords.push(`spell ${pc} ${minor} ${spellingPreference(pc, !!minor) === 'sharp' ? 1 : 0}`);
  }
}
fs.writeFileSync(path.join(DATA, 'perform-chords.txt'), chords.join('\n') + '\n');
console.log(`perform-touch.txt ${touch.length - 1} lines, perform-chords.txt ${chords.length - 1} lines`);
