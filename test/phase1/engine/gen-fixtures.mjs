// Generates tiny audio fixtures with ffmpeg (idempotent).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const C4 = 261.6256, A4 = 440;

function gen(rel, expr, dur, extra = []) {
  const out = path.join(DIR, rel);
  if (fs.existsSync(out)) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${dur}`, ...extra, out]);
}

export function generateFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  // sampler: 100 ms of leading silence (onset-trim test), soft layer = pure sine, loud layer = sine + 3rd harmonic
  const soft = (f) => `'if(lt(t,0.1),0,0.5*sin(2*PI*${f}*t)*exp(-(t-0.1)*0.7))|if(lt(t,0.1),0,0.5*sin(2*PI*${f}*t)*exp(-(t-0.1)*0.7))'`;
  const loud = (f) => `'if(lt(t,0.1),0,(0.4*sin(2*PI*${f}*t)+0.3*sin(2*PI*${3 * f}*t))*exp(-(t-0.1)*0.7))|if(lt(t,0.1),0,(0.4*sin(2*PI*${f}*t)+0.3*sin(2*PI*${3 * f}*t))*exp(-(t-0.1)*0.7))'`;
  gen('test-keys/soft/C4.wav', soft(C4), 2.5);
  gen('test-keys/soft/A4.wav', soft(A4), 2.5);
  gen('test-keys/loud/C4.wav', loud(C4), 2.5);
  gen('test-keys/loud/A4.wav', loud(A4), 2.5);
  gen('test-mp3/C4.mp3', soft(C4), 2.5, ['-c:a', 'libmp3lame', '-b:a', '128k']);
  // drone pad files: 20 s, fade in/out 1.5 s like commercial pads; named so keydetect finds the key
  const pad = (f) => {
    const e = `min(1,t/1.5)*min(1,(20-t)/1.5)*(0.25*sin(2*PI*${f / 2}*t)+0.2*sin(2*PI*${f * 0.75}*t)+0.15*sin(2*PI*${f}*t))`;
    return `'${e}|${e}'`;
  };
  gen('pads/Test Pad - C.wav', pad(C4), 20);
  gen('pads/Test Pad - G.wav', pad(392), 20);
  const manifest = {
    instruments: [
      {
        id: 'test-keys', name: 'Test Keys', category: 'piano', ext: 'wav', release: 0.12, gainTrim: 0, license: 'test',
        layers: [
          { vel: [0, 63], dir: 'test-keys/soft', notes: ['C4', 'A4'] },
          { vel: [64, 127], dir: 'test-keys/loud', notes: ['C4', 'A4'] },
        ],
      },
      { id: 'test-mp3', name: 'Test MP3', category: 'mallet', ext: 'mp3', release: 0.12, gainTrim: 0, license: 'test', layers: [{ vel: [0, 127], dir: 'test-mp3', notes: ['C4'] }] },
      { id: 'test-missing', name: 'Test Missing', category: 'guitar', ext: 'wav', release: 0.12, gainTrim: 0, layers: [{ vel: [0, 127], dir: 'test-keys/soft', notes: ['C4', 'D4'] }] },
    ],
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // "My Samples" (secondary manifest, served at /api/user-samples/): an id colliding with the factory one, no
  // `release` (→ 0.15 s default), and one entry with its own group and widthDefault
  gen('user-samples/keys/C4.wav', soft(C4), 2.5);
  gen('user-samples/keys/A4.wav', loud(A4), 2.5);
  const user = {
    instruments: [
      { id: 'test-keys', name: 'My Keys', category: 'piano', ext: 'wav', layers: [{ vel: [0, 127], dir: 'keys', notes: ['C4'] }] },
      { id: 'harp', name: 'My Harp', group: 'Plucked (mine)', ext: 'wav', release: 0.4, widthDefault: 0.5, gainTrim: 3, layers: [{ vel: [0, 127], dir: 'keys', notes: ['A4'] }] },
    ],
  };
  fs.writeFileSync(path.join(DIR, 'user-samples', 'manifest.json'), JSON.stringify(user, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) generateFixtures();
