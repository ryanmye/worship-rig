#!/usr/bin/env node
// Downloads MusyngKite (MIT, gleitz/midi-js-soundfonts) mp3 samples, A0..C8,
// flat note names (VERIFY.md Q3: flat names confirmed; sharp names 404), into
// the raw scratch dir tools/samples/.scratch-musyngkite/<id>/. The files are
// NOT used as-is: process-musyngkite.mjs drops silent notes, removes DC,
// normalizes and fades the hard-cut tail, and writes app/samples/<id>/.
//
// Usage: node tools/samples/download-musyngkite.mjs [--only id,id]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchToFile, runPool } from './fetch-utils.mjs';
import { chromaticRange, flatName } from './notenames.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/MusyngKite';
export const RAW_ROOT = join(__dirname, '.scratch-musyngkite');

// id -> MusyngKite folder name (without "-mp3" suffix)
export const INSTRUMENTS = {
  // SPEC §9 originals
  'ep-rhodes': 'electric_piano_1',
  'ep-wurli': 'electric_piano_2',
  vibes: 'vibraphone',
  celesta: 'celesta',
  'music-box': 'music_box',
  'nylon-guitar': 'acoustic_guitar_nylon',
  // samples-2 additions
  clavinet: 'clavinet',
  harpsichord: 'harpsichord',
  'electric-grand': 'electric_grand_piano',
  'bright-piano': 'bright_acoustic_piano',
  'honky-tonk': 'honkytonk_piano',
  marimba: 'marimba',
  xylophone: 'xylophone',
  'tubular-bells': 'tubular_bells',
  'steel-drums': 'steel_drums',
  kalimba: 'kalimba',
  glockenspiel: 'glockenspiel',
  harp: 'orchestral_harp',
  'steel-guitar': 'acoustic_guitar_steel',
  'clean-guitar': 'electric_guitar_clean',
  dulcimer: 'dulcimer',
};

async function downloadInstrument(id, folder, notes) {
  const destDir = join(RAW_ROOT, id);
  const missing = [];
  const present = [];
  const tasks = notes.map((midi) => async () => {
    const note = flatName(midi);
    const url = `${BASE}/${folder}-mp3/${note}.mp3`;
    const result = await fetchToFile(url, join(destDir, `${note}.mp3`));
    if (result.ok) present.push({ note, bytes: result.bytes });
    else missing.push(note);
    return result;
  });
  await runPool(tasks, 6);
  return { id, folder, present, missing };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
  const notes = chromaticRange(); // A0..C8
  const results = [];
  for (const [id, folder] of Object.entries(INSTRUMENTS)) {
    if (only && !only.has(id)) continue;
    process.stderr.write(`[musyngkite] downloading ${id} (${folder}) ...\n`);
    const r = await downloadInstrument(id, folder, notes);
    results.push(r);
    const totalBytes = r.present.reduce((s, p) => s + p.bytes, 0);
    process.stderr.write(
      `[musyngkite] ${id}: ${r.present.length} files, ${(totalBytes / 1e6).toFixed(2)} MB, missing=${r.missing.length ? r.missing.join(',') : 'none'}\n`,
    );
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main, downloadInstrument, BASE };
