// Builds a throw-away app dir (fixture pages + symlink js → app/js) and a pad folder with a generated tone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../../../app/js/shared/wav.js';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

export function sineWav(seconds = 3, freq = 220, sr = 44100, amp = 0.4) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return Buffer.from(encodeWav([L, L], sr));
}

export function buildFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-shell-'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  const src = path.join(here, 'fixtures', 'app');
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(app, f));
  fs.symlinkSync(path.join(repoRoot, 'app', 'js'), path.join(app, 'js'), 'dir');
  const pads = path.join(tmp, 'pads');
  fs.mkdirSync(path.join(pads, 'Sunday'), { recursive: true });
  fs.writeFileSync(path.join(pads, 'Sunday', 'Pad - A.wav'), sineWav());
  fs.writeFileSync(path.join(tmp, 'secret.mp3'), 'not a pad');
  // My Samples: one GarageBand-style pack (WAV so every Chromium build decodes it), folder name with a space
  const userSamples = path.join(tmp, 'My Samples');
  const packDir = path.join(userSamples, 'Test Keys');
  fs.mkdirSync(path.join(packDir, 'v 1'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'v 1', 'A3.wav'), sineWav(1, 220));
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({
    generatedBy: 'test', personalUseOnly: true,
    instruments: [{ id: 'test-keys', name: 'Test Keys (GarageBand)', category: 'piano', ext: 'wav', layers: [{ vel: [0, 127], dir: 'v 1', notes: ['A3'] }], release: 0.2 }],
  }, null, 2));
  const userData = path.join(tmp, 'userData');
  const recordings = path.join(tmp, 'recordings');
  return { tmp, app, pads, userSamples, userData, recordings, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
