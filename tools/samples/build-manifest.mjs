#!/usr/bin/env node
// Builds app/samples/manifest.json from the files actually present on disk (SPEC.md §3.5/§9).
//   - Existing `gainTrim` values are carried over from the current manifest (tools/calibrate.mjs owns them; new
//     instruments start at 0 until calibrated: `node tools/calibrate.mjs --only <ids>`).
//   - Instruments whose directory holds no .mp3 files are left out.
//   - `category` is one of piano / ep / mallet / guitar / pluck. The engine maps category -> UI group
//     (sampler.js CATEGORY_GROUP); it has no entry for `pluck` yet, so pluck instruments also carry an explicit
//     `group` naming the closest existing UI group.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = join(__dirname, '..', '..', 'app', 'samples');
const MANIFEST_PATH = join(SAMPLES_ROOT, 'manifest.json');

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToMidi(name) {
  const m = /^([A-G])(b|#)?(-?\d+)$/.exec(name);
  if (!m) throw new Error(`bad note name: ${name}`);
  const [, letter, acc, octStr] = m;
  let pc = PC[letter];
  if (acc === 'b') pc -= 1;
  if (acc === '#') pc += 1;
  return (parseInt(octStr, 10) + 1) * 12 + pc;
}

async function listNotes(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.mp3'))
    .map((f) => f.replace(/\.mp3$/, ''))
    .sort((a, b) => noteToMidi(a) - noteToMidi(b));
}

// ---- sources ------------------------------------------------------------------------------------------------------
// License: the gleitz/midi-js-soundfonts LICENSE.txt (MIT) covers that repository's code; its README states the
// rendered Musyng Kite samples are "Released under Creative Commons Attribution Share-Alike 3.0 license"
// (verified 2026-09-28 at https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/master/README.md).
// Our processed files are adaptations and are therefore distributed under CC BY-SA 3.0 too (see LICENSES.md).
const MUSYNGKITE = {
  license: 'CC-BY-SA-3.0',
  source: 'https://github.com/gleitz/midi-js-soundfonts (MusyngKite)',
  attribution:
    'Musyng Kite soundfont samples, rendered to MP3 by gleitz/midi-js-soundfonts, licensed under CC BY-SA 3.0 ' +
    '(https://creativecommons.org/licenses/by-sa/3.0/). Modified: DC removed (10 Hz high-pass), level-normalized ' +
    '(some sets key-level matched), 0.4 s tail fade, re-encoded to MP3; the modified files are CC BY-SA 3.0.',
};
const SALAMANDER = {
  license: 'CC-BY-3.0',
  source: 'https://github.com/sfzinstruments/SalamanderGrandPiano',
  attribution:
    'Salamander Grand Piano V3 by Alexander Holm, licensed under CC-BY 3.0 ' +
    '(https://creativecommons.org/licenses/by/3.0/). Samples transcoded to MP3 and trimmed.',
};
const VSCO = {
  license: 'CC0-1.0',
  source: 'https://github.com/sgossner/VSCO-2-CE (Keys/Upright Piano)',
  attribution:
    'Upright Piano from VS Chamber Orchestra 2: Community Edition by Versilian Studios (Sam Gossner) and ' +
    'Simon Dalzell (Ivy Audio), CC0 1.0 (http://vis.versilstudios.net/vsco-community.html). ' +
    'Layer levels baked from the library SFZ, normalized, tail-trimmed and transcoded to MP3.',
};

// ---- instrument table (order = picker order) -------------------------------------------------------------------
// release = τ in seconds (sampler `release` param; notes >= 90 ignore it). Damped keyboards get short τ; undamped
// struck/plucked instruments (bells, mallets, harp, kalimba) get long τ so key-up does not choke them.
const MULTI_LAYER = {
  'salamander-piano': {
    ...SALAMANDER,
    layers: [
      { vel: [0, 52], dir: 'v4' },
      { vel: [53, 96], dir: 'v9' },
      { vel: [97, 127], dir: 'v14' },
    ],
  },
  'upright-piano': {
    ...VSCO,
    // velocity splits from the library's own SFZ (lovel/hivel)
    layers: [
      { vel: [0, 60], dir: 'dyn1' },
      { vel: [61, 110], dir: 'dyn2' },
      { vel: [111, 127], dir: 'dyn3' },
    ],
  },
};

const INSTRUMENTS = [
  // piano
  { id: 'salamander-piano', name: 'Grand Piano (Salamander)', category: 'piano', release: 0.12 },
  { id: 'upright-piano', name: 'Upright Piano (VSCO)', category: 'piano', release: 0.12 },
  { id: 'bright-piano', name: 'Bright Piano', category: 'piano', release: 0.12, ...MUSYNGKITE },
  { id: 'honky-tonk', name: 'Honky-Tonk Piano', category: 'piano', release: 0.12, ...MUSYNGKITE },
  { id: 'harpsichord', name: 'Harpsichord', category: 'piano', release: 0.08, ...MUSYNGKITE },
  // ep
  { id: 'ep-rhodes', name: 'Rhodes (MusyngKite)', category: 'ep', release: 0.15, ...MUSYNGKITE },
  { id: 'ep-wurli', name: 'Wurlitzer (MusyngKite)', category: 'ep', release: 0.15, ...MUSYNGKITE },
  { id: 'electric-grand', name: 'Electric Grand', category: 'ep', release: 0.12, ...MUSYNGKITE },
  { id: 'clavinet', name: 'Clavinet', category: 'ep', release: 0.05, ...MUSYNGKITE },
  // mallet
  { id: 'vibes', name: 'Vibraphone', category: 'mallet', release: 0.3, ...MUSYNGKITE },
  { id: 'celesta', name: 'Celesta', category: 'mallet', release: 0.25, ...MUSYNGKITE },
  { id: 'music-box', name: 'Music Box', category: 'mallet', release: 0.3, ...MUSYNGKITE },
  { id: 'marimba', name: 'Marimba', category: 'mallet', release: 0.4, ...MUSYNGKITE },
  { id: 'xylophone', name: 'Xylophone', category: 'mallet', release: 0.3, ...MUSYNGKITE },
  { id: 'glockenspiel', name: 'Glockenspiel', category: 'mallet', release: 0.8, ...MUSYNGKITE },
  { id: 'tubular-bells', name: 'Tubular Bells', category: 'mallet', release: 1.2, ...MUSYNGKITE },
  { id: 'steel-drums', name: 'Steel Drums', category: 'mallet', release: 0.5, ...MUSYNGKITE },
  // guitar
  { id: 'nylon-guitar', name: 'Nylon Guitar', category: 'guitar', release: 0.12, ...MUSYNGKITE },
  { id: 'steel-guitar', name: 'Steel-String Guitar', category: 'guitar', release: 0.15, ...MUSYNGKITE },
  { id: 'clean-guitar', name: 'Clean Electric Guitar', category: 'guitar', release: 0.1, ...MUSYNGKITE },
  // pluck (explicit group until the engine maps `pluck`)
  { id: 'harp', name: 'Harp', category: 'pluck', group: 'Guitar', release: 0.8, ...MUSYNGKITE },
  { id: 'dulcimer', name: 'Dulcimer', category: 'pluck', group: 'Guitar', release: 0.6, ...MUSYNGKITE },
  { id: 'kalimba', name: 'Kalimba', category: 'pluck', group: 'Mallets & Bells', release: 0.6, ...MUSYNGKITE },
];

async function buildOne(def, prevTrims) {
  const multi = MULTI_LAYER[def.id];
  const src = multi || def;
  const layers = [];
  if (multi) {
    for (const l of multi.layers) {
      const notes = await listNotes(join(SAMPLES_ROOT, def.id, l.dir));
      if (notes.length) layers.push({ vel: l.vel, dir: `${def.id}/${l.dir}`, notes });
    }
  } else {
    const notes = await listNotes(join(SAMPLES_ROOT, def.id));
    if (notes.length) layers.push({ vel: [0, 127], dir: def.id, notes });
  }
  if (!layers.length) return null;
  const out = { id: def.id, name: def.name, category: def.category };
  if (def.group) out.group = def.group;
  Object.assign(out, {
    ext: 'mp3',
    layers,
    release: def.release,
    gainTrim: prevTrims.get(def.id) ?? 0,
    license: src.license,
    source: src.source,
    attribution: src.attribution,
  });
  return out;
}

async function main() {
  const prevTrims = new Map();
  try {
    const prev = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    for (const i of prev.instruments || []) if (Number.isFinite(i.gainTrim)) prevTrims.set(i.id, i.gainTrim);
  } catch {
    /* first build */
  }
  const instruments = [];
  for (const def of INSTRUMENTS) {
    const inst = await buildOne(def, prevTrims);
    if (inst) instruments.push(inst);
  }
  const manifest = { instruments };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((manifest) => {
      for (const inst of manifest.instruments) {
        const counts = inst.layers.map((l) => `${l.dir}:${l.notes.length}`).join(' ');
        console.log(`${inst.id.padEnd(17)} ${inst.category.padEnd(7)} trim=${String(inst.gainTrim).padEnd(5)} ${counts}`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { main, noteToMidi, INSTRUMENTS };
