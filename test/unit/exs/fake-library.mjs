// Shared by the in-app importer tests (v11-importer): a SYNTHETIC "Apple library" in a temp dir — .exs files written
// by tools/exs/writer.mjs from tools/exs/fixtures/*.json and generated WAVs, never real Apple files — plus a fake
// ffmpeg (a Node script: `-version` exits 0, a conversion waits FAKE_FFMPEG_MS and copies its input to the output).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExs } from '../../../tools/exs/writer.mjs';
import { buildWav } from '../../../tools/exs/wav.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '../../..');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(repo, 'tools/exs/fixtures', n), 'utf8'));

function wav(frames) {
  const d = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) d.writeInt16LE(Math.round(6000 * Math.sin(i / 15)), i * 4);
  return buildWav({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }, d);
}

/**
 * @param {{ missingStrings?: boolean }} [o]  missingStrings: the strings' audio is not "downloaded" (0 found)
 * @returns {{ T:string, lib:string, out:string, cache:string, ffmpeg:string, noBin:string, cleanup:() => void }}
 */
export function buildLibrary(o = {}) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-app-'));
  const lib = path.join(T, 'lib');
  const inst = path.join(lib, 'Sampler Instruments');
  fs.mkdirSync(inst, { recursive: true });
  const piano = fixture('test-grand-piano.json');
  const strings = fixture('test-strings.json');
  fs.writeFileSync(path.join(inst, 'Test Grand Piano.exs'), writeExs(piano));
  fs.writeFileSync(path.join(inst, 'Test Strings Ensemble.exs'), writeExs(strings));
  fs.writeFileSync(path.join(inst, 'Broken.exs'), Buffer.from('not an exs file at all'));
  const ps = path.join(lib, 'Sampler Files', 'Test Piano');
  fs.mkdirSync(ps, { recursive: true });
  for (const s of piano.samples) fs.writeFileSync(path.join(ps, s.fileName), wav(4410));
  if (!o.missingStrings) {
    const ss = path.join(lib, 'EXS Factory Samples', 'Test Strings');
    fs.mkdirSync(ss, { recursive: true });
    for (const s of strings.samples) fs.writeFileSync(path.join(ss, s.fileName.replace(/\.aif$/, '.caf')), wav(8820));
  }
  const out = path.join(T, 'My Samples');
  const ffmpeg = path.join(T, 'ffmpeg');
  fs.writeFileSync(
    ffmpeg,
    `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '-version') process.exit(0);
const src = a[a.indexOf('-i') + 1];
const dst = a[a.length - 1];
setTimeout(() => { fs.copyFileSync(src, dst); }, Number(process.env.FAKE_FFMPEG_MS || 0));
`,
  );
  fs.chmodSync(ffmpeg, 0o755);
  return {
    T, lib, out, ffmpeg,
    cache: path.join(T, 'idx.json'),
    noBin: path.join(T, 'no-such-binary'),
    cleanup: () => fs.rmSync(T, { recursive: true, force: true }),
  };
}
