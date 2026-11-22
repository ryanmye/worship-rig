// T16 reference vectors for the drone's pure pieces (native/core/tests/test_drone_vectors.cpp): drone.js
// staticVoicing / followVoicing / Drone.loopRegion and shared/keydetect.js detectKeyFromName. No floating-point
// transcendentals are involved (integer voicing, the loop region is min / sums of the duration), so they run in node.
// Usage: node tools/golden/vectors/dump-drone.mjs -> data/drone.json
import fs from 'node:fs';
import path from 'node:path';
import { DATA, ROOT } from './lib.mjs';

const imp = (p) => import(path.join(ROOT, p));
const { staticVoicing, followVoicing, Drone } = await imp('app/js/engine/drone.js');
const { detectKeyFromName } = await imp('app/js/shared/keydetect.js');

const out = { static: [], follow: [], region: [], key: [] };
for (let pc = -13; pc <= 25; pc++) {
  for (const b of [0, 0.5, 0.6, 0.61, 1]) out.static.push([pc, b, staticVoicing(pc, b)]);
}

let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const held = [[50, 54, 57], [43, 47, 50, 79], [50, 62], [60], [], [36, 40, 43, 46], [45, 48, 52, 55, 59],
  [41, 45, 48, 50], [38, 45, 50, 53, 57], [40, 44, 47, 50], [48, 51, 55, 58, 62], [44, 49, 53], [47, 50, 53, 57]];
for (let i = 0; i < 300; i++) {
  const n = 2 + Math.floor(rnd() * 5);
  const h = [];
  for (let k = 0; k < n; k++) h.push(33 + Math.floor(rnd() * 40));
  held.push(h);
}
const prevs = [null, [55, 60, 64], [50, 57, 62], [52, 55, 60], [48, 53, 57], [55, 59, 62, 67]];
for (const h of held) for (const p of prevs) out.follow.push([h, p, followVoicing(h, p)]);

for (const d of [0, 1, 5, 11.99, 12, 12.01, 13, 20, 24, 31.5, 47.3, 48, 60, 95.123, 180, 600]) {
  out.region.push([d, Drone.loopRegion(d)]);
}

const names = ['Pad - C.mp3', 'Ambient_Pad_-_F#m.mp3', 'Pad E flat.mp3', 'random.mp3', 'A Pad in D.wav',
  'Warm Pad (Bb).m4a', 'Key of G minor - pad.mp3', 'pad_c#m_long.wav', 'Pads/Am Shimmer.mp3', 'Shimmer A.mp3',
  'A minor.mp3', 'A shimmer in F.mp3', 'Pad C3.wav', 'Pad C3 E3.wav', 'Ebmaj7 pad.mp3', 'F sharp minor.aiff',
  'B♭ pad.mp3', 'C♯m pad.mp3', 'Gm7 swell.wav', 'DM7.wav', 'Cminor.mp3', 'C Minor.mp3', 'E flat major.mp3',
  'pad.C.D.mp3', 'C and G.mp3', 'G (live) G.mp3', 'C:\\pads\\D Pad.wav', 'Fsharp.mp3', 'Dflat Pad.mp3',
  'in Ab - wash.mp3', 'key of e.mp3', 'Key of E.mp3', 'B-3.wav', 'A.mp3', 'A A.mp3', 'C Bm.mp3', 'Bbm.ogg',
  'Pad_[F#].flac', 'Worship Pad - Db Major.mp3', 'Gb.mp3', 'E.m.mp3', 'C#.mp3', 'H.mp3'];
for (const n of names) out.key.push([n, detectKeyFromName(n)]);

fs.writeFileSync(path.join(DATA, 'drone.json'), JSON.stringify(out) + '\n');
const { static: st, follow, region, key } = out;
console.log(`static ${st.length}, follow ${follow.length}, region ${region.length}, key ${key.length}`);
