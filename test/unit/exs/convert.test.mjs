// Conversion tests: ffmpeg argument building (pure), exact sample cuts out of a synthetic consolidated CAF made with
// ffmpeg (frame i carries its own index, so any off-by-one shows), the JS multi-segment WAV slicer used on the
// afconvert path, and a full CLI import of a synthetic consolidated instrument. ffmpeg-dependent tests are skipped
// when ffmpeg is not installed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ffmpegArgs, convertWithFfmpeg, hasFfmpeg, pool } from '../../../tools/exs/convert.mjs';
import { buildWav, readWavInfo, sliceWavSegments } from '../../../tools/exs/wav.mjs';
import { planSegments, zoneSlice } from '../../../tools/exs/mapping.mjs';
import { writeExs } from '../../../tools/exs/writer.mjs';
import { chooseEncoder } from '../../../tools/import-garageband.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../../../tools/import-garageband.mjs');
const FF = hasFfmpeg();
const ff = { skip: FF ? false : 'ffmpeg not installed' };
let T;
let CAF;
const FRAMES = 200000;

/** Stereo 16-bit frame i: L = i & 0x7fff, R = i >> 15 — unique per frame for i < 2^30. */
function indexPcm(n) {
  const d = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    d.writeInt16LE(i & 0x7fff, i * 4);
    d.writeInt16LE(i >> 15, i * 4 + 2);
  }
  return d;
}
const frameAt = (wav, k) => {
  const info = readWavInfo(wav);
  const o = info.dataOffset + k * info.blockAlign;
  return wav.readInt16LE(o) + (wav.readInt16LE(o + 2) << 15);
};

before(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'exs-convert-'));
  fs.writeFileSync(path.join(T, 'src.wav'), buildWav({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }, indexPcm(FRAMES)));
  if (FF) {
    CAF = path.join(T, 'Test_consolidated.caf');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(T, 'src.wav'), '-c:a', 'pcm_s16be', '-f', 'caf', CAF]);
    assert.equal(r.status, 0, String(r.stderr));
  }
});

test('ffmpegArgs: whole file, one slice, two segments (concat), gain + fade, codecs', () => {
  const whole = ffmpegArgs('in.caf', 'out.mp3', { format: 'mp3', bitrate: 160000, rate: 48000 });
  assert.deepEqual(whole.slice(-9), ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '160k', '-ar', '48000', 'out.mp3']);
  assert.ok(!whole.includes('-af') && !whole.includes('-filter_complex'));
  const one = ffmpegArgs('in.caf', 'o.wav', { format: 'wav', segments: [{ start: 100, end: 300 }] });
  assert.equal(one[one.indexOf('-af') + 1], 'atrim=start_sample=100:end_sample=300,asetpts=PTS-STARTPTS');
  assert.ok(one.includes('pcm_s16le') && !one.includes('-ar'));
  const two = ffmpegArgs('in.caf', 'o.m4a', { format: 'm4a', segments: [{ start: 5, end: 10 }, { start: 20, end: null }], gainDb: -3, fadeOutSec: 0.25, totalSec: 2 });
  assert.equal(
    two[two.indexOf('-filter_complex') + 1],
    '[0:a]asplit=2[i0][i1];[i0]atrim=start_sample=5:end_sample=10,asetpts=PTS-STARTPTS[s0];[i1]atrim=start_sample=20,asetpts=PTS-STARTPTS[s1];[s0][s1]concat=n=2:v=0:a=1,volume=-3.00dB,afade=t=out:st=1.750000:d=0.25[out]',
  );
  assert.equal(two[two.indexOf('-map') + 1], '[out]');
  assert.ok(two.includes('aac') && two.includes('192k'));
  // tiny gains are dropped; a {0,null} segment is "whole file"
  assert.ok(!ffmpegArgs('a', 'b', { format: 'wav', segments: [{ start: 0, end: null }], gainDb: 0.01 }).includes('-af'));
});

test('chooseEncoder: ffmpeg → mp3 160k 48 kHz; afconvert-only → m4a; errors when neither', () => {
  assert.deepEqual(chooseEncoder({ encoder: 'auto' }, { ffmpeg: true, afconvert: true }), { encoder: 'ffmpeg', format: 'mp3', bitrate: 160000, rate: 48000, note: undefined });
  assert.deepEqual(chooseEncoder({ encoder: 'auto' }, { ffmpeg: false, afconvert: true }), { encoder: 'afconvert', format: 'm4a', bitrate: 192000, rate: 0, note: undefined });
  const mp3OnMac = chooseEncoder({ encoder: 'afconvert', format: 'mp3' }, { ffmpeg: false, afconvert: true });
  assert.equal(mp3OnMac.format, 'm4a');
  assert.match(mp3OnMac.note, /cannot write mp3/);
  assert.match(chooseEncoder({ encoder: 'auto' }, { ffmpeg: false, afconvert: false }).error, /Neither ffmpeg nor afconvert/);
  assert.match(chooseEncoder({ encoder: 'ffmpeg' }, { ffmpeg: false, afconvert: true }).error, /ffmpeg not found/);
});

test('sliceWavSegments (afconvert path): exact frames, joined in order, optional gain', () => {
  const src = fs.readFileSync(path.join(T, 'src.wav'));
  const out = sliceWavSegments(src, [{ start: 1000, end: 1500 }, { start: 70000, end: 70010 }, { start: FRAMES - 3, end: null }]);
  const info = readWavInfo(out);
  assert.equal(info.dataLength / info.blockAlign, 500 + 10 + 3);
  assert.equal(frameAt(out, 0), 1000);
  assert.equal(frameAt(out, 499), 1499);
  assert.equal(frameAt(out, 500), 70000);
  assert.equal(frameAt(out, 509), 70009);
  assert.equal(frameAt(out, 512), FRAMES - 1);
  const quiet = sliceWavSegments(src, [{ start: 20000, end: 20001 }], -6.0206);
  assert.equal(quiet.readInt16LE(44), 10000, 'half amplitude');
});

test('ffmpeg cuts a consolidated CAF by exact sample counts (single + two-segment zones)', ff, async () => {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,duration_ts', '-of', 'csv=p=0', CAF], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), `pcm_s16be,${FRAMES}`);
  const smp = { length: FRAMES };
  const cases = [
    { zone: { sampleStart: 12345, sampleEnd: 23456 }, want: [[12345, 23456]] },
    { zone: { sampleStart: 150000, sampleEnd: 0 }, want: [[150000, FRAMES]] },
    // attack 100000..104410 then its tail 105000..180000 (padding skipped), like Steinway "Zone #1"
    { zone: { sampleStart: 100000, sampleEnd: 104410, segment2: { start: 105000, end: 180000 } }, want: [[100000, 104410], [105000, 180000]] },
    // louder layer: own attack, tail BEFORE it in the file
    { zone: { sampleStart: 190000, sampleEnd: 195000, segment2: { start: 50000, end: 60000 } }, want: [[190000, 195000], [50000, 60000]] },
  ];
  await pool(cases, 4, async (c, i) => {
    const seg = planSegments(zoneSlice(c.zone, smp), FRAMES, 0);
    const out = path.join(T, `cut${i}.wav`);
    const r = await convertWithFfmpeg(CAF, out, { format: 'wav', segments: seg.segments });
    assert.ok(r.ok, r.msg);
    const wav = fs.readFileSync(out);
    const info = readWavInfo(wav);
    const n = c.want.reduce((s, [a, b]) => s + b - a, 0);
    assert.equal(info.dataLength / info.blockAlign, n, `case ${i} frame count`);
    let k = 0;
    for (const [a, b] of c.want) {
      assert.equal(frameAt(wav, k), a, `case ${i} first frame of segment`);
      assert.equal(frameAt(wav, k + (b - a) - 1), b - 1, `case ${i} last frame of segment`);
      k += b - a;
    }
    assert.ok(!fs.existsSync(`${out}.part.wav`));
  });
});

test('ffmpeg truncation (--max-seconds) closes the right segment', ff, async () => {
  const seg = planSegments(zoneSlice({ sampleStart: 100000, sampleEnd: 104410, segment2: { start: 105000, end: 180000 } }, { length: FRAMES }), FRAMES, 44100);
  assert.deepEqual(seg.segments, [{ start: 100000, end: 104410 }, { start: 105000, end: 105000 + 44100 - 4410 }]);
  assert.equal(seg.truncated, true);
  const out = path.join(T, 'trunc.wav');
  assert.ok((await convertWithFfmpeg(CAF, out, { format: 'wav', segments: seg.segments })).ok);
  const wav = fs.readFileSync(out);
  assert.equal(readWavInfo(wav).dataLength / 4, 44100);
  assert.equal(frameAt(wav, 44099), 105000 + 44100 - 4410 - 1);
});

test('CLI: a synthetic consolidated instrument imports to mp3 48 kHz with one file per note and layer', ff, () => {
  const lib = path.join(T, 'lib');
  fs.mkdirSync(path.join(lib, 'Sampler Instruments'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'EXS Factory Samples'), { recursive: true });
  // real audio (a decaying tone) so the validator's silence/DC checks are meaningful
  const tone = path.join(lib, 'EXS Factory Samples', 'Test Keys_consolidated.caf');
  const g = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=261.63:sample_rate=44100:duration=8', '-af', 'afade=t=out:st=0:d=8,aformat=channel_layouts=stereo', '-c:a', 'pcm_s16be', '-f', 'caf', tone]);
  assert.equal(g.status, 0, String(g.stderr));
  const desc = {
    name: 'Test Keys',
    groups: [
      { name: 'soft', minVel: 0, maxVel: 63, volume: -3, selectCC: { number: 64, low: 0, high: 63 } },
      { name: 'loud', minVel: 64, maxVel: 127, selectCC: { number: 64, low: 0, high: 63 } },
      { name: 'soft sus', minVel: 0, maxVel: 127, selectCC: { number: 64, low: 64, high: 127 } },
    ],
    samples: [{ fileName: 'Test Keys_consolidated.caf', length: 352800, sampleRate: 44100, bitDepth: 16, channels: 2, type: 'caff' }],
    zones: [
      { root: 60, keyLow: 0, keyHigh: 65, velRangeOn: false, group: 0, sample: 0, sampleStart: 0, sampleEnd: 44100, segment2: { start: 44200, end: 176400 } },
      { root: 72, keyLow: 66, keyHigh: 127, velRangeOn: false, group: 0, sample: 0, sampleStart: 176400, sampleEnd: 264600 },
      { root: 60, keyLow: 0, keyHigh: 65, velRangeOn: false, group: 1, sample: 0, sampleStart: 264600, sampleEnd: 300000, segment2: { start: 44200, end: 176400 } },
      { root: 72, keyLow: 66, keyHigh: 127, velRangeOn: false, group: 1, sample: 0, sampleStart: 300000, sampleEnd: 352800 },
      { root: 60, keyLow: 0, keyHigh: 127, velRangeOn: false, group: 2, sample: 0, sampleStart: 0, sampleEnd: 352800 },
    ],
  };
  fs.writeFileSync(path.join(lib, 'Sampler Instruments', 'Test Keys.exs'), writeExs(desc));
  const out = path.join(T, 'user-samples');
  const run = (args) => spawnSync(process.execPath, [CLI, '--root', lib, '--cache', path.join(T, 'idx.json'), ...args], { encoding: 'utf8', env: { ...process.env, AFCONVERT: path.join(T, 'no-afconvert') } });
  const first = run(['--import', 'Test Keys', '--out', out, '--batch', '2', '--id', 'test-keys-pack', '--name', 'My Test Keys']);
  assert.equal(first.status, 3, first.stderr + first.stdout);
  assert.match(first.stdout, /2 file\(s\) left — run the same command again/);
  const second = run(['--import', 'Test Keys', '--out', out, '--batch', '2', '--id', 'test-keys-pack', '--name', 'My Test Keys']);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /2 already converted/);
  const dir = path.join(out, 'test-keys-pack');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const inst = m.instruments[0];
  assert.deepEqual([inst.id, inst.name, inst.ext, inst.license], ['test-keys-pack', 'My Test Keys (EXS)', 'mp3', 'personal-use']);
  assert.deepEqual(inst.layers, [
    { vel: [0, 63], dir: 'v0-63', notes: ['C4', 'C5'] },
    { vel: [64, 127], dir: 'v64-127', notes: ['C4', 'C5'] },
  ]);
  const info = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', path.join(dir, 'v0-63', 'C4.mp3')], { encoding: 'utf8' });
  const j = JSON.parse(info.stdout);
  assert.deepEqual([j.streams[0].codec_name, j.streams[0].sample_rate, j.streams[0].channels], ['mp3', '48000', 2]);
  assert.ok(Math.abs(parseFloat(j.format.duration) - (44100 + 132200) / 44100) < 0.1, `two segments joined: ${j.format.duration}`);
  assert.deepEqual(fs.readdirSync(out).filter((f) => f.startsWith('.')), [], 'work folder removed when complete');
  const v = run(['--validate', dir]);
  assert.equal(v.status, 0, v.stderr + v.stdout);
  assert.match(v.stdout, /OK: manifest matches the bundled schema/);
});
