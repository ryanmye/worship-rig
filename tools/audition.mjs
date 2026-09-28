#!/usr/bin/env node
// Audition pack (SPEC §12). `node tools/audition.mjs [--only slug,slug] [--no-solo]`
//
// Renders 12 s clips (44.1 kHz, 16-bit) of I–V–vi–IV (2 s per chord + 4 s tail, sustain pedal per chord) for every
// factory song and every instrument (synth patches, organ presets, and the sampled instruments), in stereo and in
// the engine's mono mode, runs the robot listener on each and writes:
//   audition/<slug>.wav, audition/<slug>.mono.wav, audition/report.json, audition/index.html
// Exit 1 if any clip fails a hard check (everything is still written).
//
// Hard checks (stereo render): RMS over the played part (0.5–8 s) in −26..−16 dBFS (instrument clips: floor at
// their nominal level − 2 dB, see instRmsFloorDb); sample peak ≤ −0.3 dBFS;
// |DC| < .001; mono-sum loss < 3 dB; no NaN/Inf; not silent (every chord segment > −60 dBFS); mono render has no
// NaN and is not silent. Soft checks (WARN): HF-burst click detector (skipped for lofi songs with crackle),
// drop-outs (10 ms windows < −60 dBFS while playing), mono render peak, per-layer balance (a layer > 15 dB under
// the mix is inaudible), preset lint (bass slot polyphony, empty wheel target, …).
import fs from 'node:fs';
import path from 'node:path';
import { openRenderer } from './lib/offline.mjs';
import * as A from './lib/analysis.mjs';
import { ROOT, singlePatch, progression, progressionEvents, transposeSemis, keyName, trimsForJob, readGainTrims, readManifest, table } from './lib/rig.mjs';
import { FACTORY_SONGS } from '../app/js/presets.js';
import { encodeWav } from '../app/js/shared/wav.js';

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const SOLO = !args.includes('--no-solo');
const OUT = path.join(ROOT, 'audition');
const SR = 44100;
const SECONDS = 12;
const CHORD_DUR = 2;
const PLAY_END = 4 * CHORD_DUR; // 8 s
const WIN = [0.5, PLAY_END];
const LIMITS = { rmsLo: -26, rmsHi: -16, peak: -0.3, dc: 0.001, monoLoss: 3, silence: -60, layerInaudible: -15 };
// Instrument clips get an RMS floor relative to their nominal level, not the absolute −26 (round2-engine m5): a
// calibrated instrument (−18 dBFS at slot gain 1, master 0 dB) played at the Keys-role slot gain 0.8 through the −6 dB
// master sits at −25.9 dBFS before sends, 0.1 dB above the old floor, so every decaying Keys patch hovered on it and
// the keytracked ones (dx-epiano −26.6, pluck −27.3, calibrated at −18.2/−18.3) failed on arithmetic alone.
const CAL_TARGET_DB = -18; // tools/calibrate.mjs --target default
const INST_FLOOR_MARGIN_DB = 2;
const SIZE_BUDGET_MB = 300; // 60+ clips (11+ songs, 16 synth, 4 organ, 23 samplers) × ~3 MB (stereo + mono WAV)

fs.mkdirSync(OUT, { recursive: true });
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- what to listen for ---------------------------------------------------------------------------------------------
const LISTEN_SONG = {
  'sunday-pad-piano': 'Piano clearly on top; the warm pad (wheel 0.7) swells in slowly (~1 s) and sits underneath without masking it. A soft C drone (root-5th-octave, no 3rd) fades in over ~5 s. No pitch wobble, no beating between drone and chords, no smear of the previous chord after each pedal change.',
  'building-swell': 'Strings speak in ~0.4 s; their vibrato should start late (~0.5 s after each chord), gentle, not seasick. The glass pad (wheel 0.7) adds shimmer on top. No buzzy/raspy saw edge, no chorus wobble on pitch.',
  'prayer-wash': 'A single warm pad in a huge room plus the key drone. Each chord swells slowly; the last 4 s are a long, smooth reverb tail (no metallic ring, no flutter). Chord changes must be seamless: no click when the pedal lifts.',
  'organ-swell': 'Gospel drawbar organ with fast rotary (shimmering Leslie) and a pad behind it (wheel 0.7). The sustain pedal holds the pad but NOT the organ, so the organ stops briefly before each change (keys lift at 1.9 s) while the pad carries on. Key click subtle; no harsh distortion.',
  'grand-piano': 'Clean concert grand in a medium hall. Natural attack and decay, no doubled attacks, no click when the pedal lifts at each chord change, stable stereo image.',
  rhodes: 'Sampled Rhodes with a soft chorus: bell-like tine on the attack, round warm body, gentle stereo movement from the chorus (not seasick).',
  'felt-piano': 'Dark, soft "felt" piano (tone rolled off, soft velocity) in a big room: muffled hammer, no bright top end, the room carries the sustain.',
  'lofi-rhodes': 'Soft FM electric piano through a worn tape: gentle wow/flutter pitch wobble IS expected here, soft crackle, dusty top end, dotted-eighth echoes at 80 bpm. Wobble should feel nostalgic, not out of tune.',
  'dusty-piano': 'Piano "sampled from an old record": vinyl crackle clearly audible (crackle 0.6), slight tape wobble, narrow warm tone, quarter-note echo at 75 bpm. The piano must stay intelligible under the crackle.',
  'glass-ocean': 'Glassy pad (wheel 0.7) plus soft FM bells bouncing left/right in a dotted-eighth ping-pong delay at 72 bpm. Bells should ring clearly without harsh 2–5 kHz edge; echoes rhythmic, not a smear.',
  'sub-shimmer': 'Split: the left-hand root (C2 range) plays the mono sub-bass, one note at a time (never a chord); the glass pad plays everything and the key drone sits underneath. Use headphones or real speakers: laptop speakers will hide the sub. Low end deep but not boomy or muddy.',
};
const LISTEN_INST = {
  'warm-pad': 'Warm analog-style pad: ~1.2 s swell, slow filter movement, wide stereo. No pitch wobble, no zipper noise, low end tight (mono below 150 Hz).',
  'glass-pad': 'Glassy, bright-but-soft pad with chorus shimmer; attack ~0.8 s. No harsh top, no seasick chorus.',
  strings: 'Synth strings: ~0.4 s attack, 1.8 s release, delayed vibrato (starts ~0.5 s into each chord). Should not buzz.',
  'sub-bass': 'Roots only (C2 range), mono: one clean, round sub note at a time with a little 2nd-harmonic warmth. No chords, no click at note changes (30 ms legato).',
  'soft-keys': 'FM electric piano: tine "ping" on the attack, warm body, stereo tremolo; decays like a real EP.',
  bell: 'FM bell: clear inharmonic strike, long decay. Should not be piercing.',
  'drone-osc': 'The drone oscillator played as a pad: slow 2.5 s attack, slow random drift (subtle chorus-like movement), no audible beating steps.',
  gospel: 'Gospel drawbars 888800000 with percussion and fast rotary: bright, punchy, shimmering. Key click subtle.',
  'soft-pad': 'Soft organ 008800000 with slow rotary: mellow, flute-like.',
  full: 'Full organ, all drawbars: loud, bright, slight overdrive; slow rotary. Should not distort harshly.',
  church: 'Church organ 806000000, no rotary, long release: stately, still; long tail after each chord.',
  'salamander-piano': 'Salamander grand: three velocity layers; natural decay, no mismatched note levels across the chord.',
  'ep-rhodes': 'MusyngKite Rhodes: tine attack, warm body; single velocity layer (brightness follows velocity via a filter).',
  'ep-wurli': 'MusyngKite Wurlitzer: reedy bark, shorter sustain than the Rhodes.',
  vibes: 'Vibraphone: soft mallet attack, long ring.',
  celesta: 'Celesta: small bell-like tone, quick decay.',
  'music-box': 'Music box: tiny plucked tines, high and delicate.',
  'nylon-guitar': 'Nylon guitar: plucked, warm; the chord is struck as a block (no strum).',
};

// ---- preset lint (static musical checks) ------------------------------------------------------------------------
function lintSong(song, instIds) {
  const f = [];
  const p = song.patch;
  const slots = p.slots;
  const bass = slots[3];
  if (bass && (bass.mono === 'off' || !bass.mono)) f.push(`Bass slot (${bass.instrument.id}) is polyphonic (mono off): it will play whole chords.`);
  if (bass && bass.highNote >= 60) f.push(`Bass slot highNote ${bass.highNote} ≥ C4: right-hand chord tones reach the bass.`);
  slots.forEach((s, i) => {
    if (!s) return;
    if (!instIds.has(`${s.instrument.type}:${s.instrument.id}`)) f.push(`Slot ${i} uses unknown instrument ${s.instrument.type}:${s.instrument.id}.`);
    if (!(s.gain > 0)) f.push(`Slot ${i} (${s.instrument.id}) has gain 0: inaudible.`);
    if (s.lowNote > s.highNote) f.push(`Slot ${i} has an empty key range (${s.lowNote} > ${s.highNote}).`);
    if (s.velocityCurve === 'soft' && s.instrument.type === 'sampler' && s.instrument.id === 'salamander-piano')
      f.push(`Slot ${i} velocityCurve "soft" (v^0.6) makes playing LOUDER/brighter: velocity 96 → 107 selects the top Salamander layer (97–127). For a gentle/felt touch use "hard" (v^1.6: 96 → 81, middle layer) or a lower gain.`);
  });
  for (const k of ['modWheel', 'expression']) {
    const r = p[k];
    const m = /^slots\.(\d)\.gain$/.exec(r?.target || '');
    if (m && !slots[+m[1]]) f.push(`${k} targets slots.${m[1]}.gain but slot ${m[1]} is empty (the wheel does nothing).`);
    if (r && r.min === r.max) f.push(`${k} min = max (${r.min}): the wheel has no effect.`);
  }
  if (p.fx.delay.sync && p.fx.delay.sync !== 'off' && !song.tempo) f.push(`Delay sync ${p.fx.delay.sync} but the song has no tempo (falls back to delay time).`);
  if (p.bend.mode === 'pitch' && !slots.some((s) => s && s.bendEnabled)) f.push('Bend mode "pitch" but no slot has bendEnabled.');
  if (bass && slots.some((s, i) => s && i !== 3 && s.lowNote < 48 && s.instrument.type === 'synth'))
    f.push(`Info: with a Bass slot, pad/keys slots also play the left-hand bass note (lowNote ${slots.find((s, i) => s && i !== 3).lowNote}); low pad notes can muddy the sub.`);
  return f;
}

// ---- clip definitions -----------------------------------------------------------------------------------------------
function songClip(song) {
  const slug = song.id.replace(/^factory:/, '');
  const hear = song.hearIn ?? 0;
  const play = transposeSemis(song.playIn ?? hear, hear) + 12 * (song.transposeOctave || 0);
  const hasBass = !!song.patch.slots[3];
  const chords = progression(hear, { minor: song.minor, bassOct: hasBass });
  const { events, onsets } = progressionEvents(chords, { dur: CHORD_DUR, vel: 96, play });
  const wheelToPad = song.patch.modWheel?.target === 'slots.1.gain' && !!song.patch.slots[1];
  const drone = song.drone?.mode === 'synth' ? { ...clone(song.drone), key: { pc: hear, minor: !!song.minor } } : null;
  const lofi = song.patch.fx.lofi.amount > 0;
  return {
    kind: 'song',
    slug,
    name: song.name,
    category: song.category,
    listen: LISTEN_SONG[slug] || song.notes,
    setup: [
      `Key ${keyName(hear, song.minor)} (Hear-In)${play ? `, transpose ${play}` : ''}`,
      wheelToPad ? 'mod wheel 0.7 → pad' : `mod wheel 1.0 → ${song.patch.modWheel.target}`,
      drone ? `drone synth gain ${drone.gain}` : 'drone off',
      song.tempo ? `${song.tempo} bpm` : null,
      lofi ? `lofi ${song.patch.fx.lofi.amount}` : null,
      hasBass ? 'bass note in C2 range → Bass slot' : 'LH root C3–B3',
    ].filter(Boolean).join(' · '),
    job: {
      sr: SR,
      seconds: SECONDS,
      seed: `audition|${slug}`,
      patch: clone(song.patch),
      transpose: play,
      keyContext: { pc: hear, minor: !!song.minor },
      tempo: song.tempo || null,
      drone,
      wheel: wheelToPad ? { mod: 0.7 } : null,
      events,
    },
    onsets,
    crackle: lofi && song.patch.fx.lofi.crackle > 0,
    song,
  };
}

function instClip(x) {
  const { ref, group, name } = x;
  const slug = `${ref.type}-${ref.id}`;
  const role = group === 'Synth Pads' ? 1 : group === 'Bass' ? 3 : 0;
  const isBass = group === 'Bass';
  const chords = progression(0, { bassOct: isBass });
  const { events, onsets } = progressionEvents(chords, { dur: CHORD_DUR, vel: 96, lhOnly: isBass });
  const patch = singlePatch(ref, { role });
  return {
    kind: 'instrument',
    slug,
    name: `${name}`,
    category: `${ref.type} · ${group}`,
    listen: LISTEN_INST[ref.id] || `${group} instrument in its default settings.`,
    setup: `Key C · slot role ${['Keys', 'Pad', 'Extra', 'Bass'][role]} defaults (gain 0.8, role sends) · default FX, master −6 dB${isBass ? ' · roots only, C2 range' : ''}${Array.isArray(x.calibWindow) ? ` · RMS judged over ${x.calibWindow.join('–')} s of each chord (calibWindow)` : ''}`,
    job: { sr: SR, seconds: SECONDS, seed: `audition|${slug}`, patch, events },
    onsets,
    crackle: false,
    ref,
    rmsLo: instRmsFloorDb(patch),
    // a patch with a calibWindow (synth-extra pluck: [0, 1] — its sound is over after ~1 s) is judged over that part
    // of each chord, the same window calibrate.mjs trims it on; 2 s chords would otherwise count 1 s of silence each
    rmsWindows: Array.isArray(x.calibWindow) ? onsets.map((t) => [t + x.calibWindow[0], Math.min(t + x.calibWindow[1], PLAY_END)]) : null,
  };
}

/**
 * RMS floor (dBFS) for an instrument clip: its nominal level (CAL_TARGET_DB + slot gain + master volume, in dB)
 * minus INST_FLOOR_MARGIN_DB, never above LIMITS.rmsLo. Keys role (0.8, −6 dB master): −25.9 − 2 = −27.9.
 * @param {object} patch  the clip's job patch (one slot)
 */
function instRmsFloorDb(patch) {
  const s = (patch.slots || []).find(Boolean);
  const dB = (x) => 20 * Math.log10(Math.max(1e-6, Number(x)));
  const nominal = CAL_TARGET_DB + dB(s?.gain ?? 1) + dB(patch.fx?.master?.volume ?? 1);
  return A.round(Math.min(LIMITS.rmsLo, nominal - INST_FLOOR_MARGIN_DB), 1);
}

/** Power-weighted RMS (dBFS) over several [a, b] windows. */
function rmsDbWindows(chs, windows) {
  let p = 0;
  let d = 0;
  for (const [a, b] of windows) {
    p += Math.pow(10, A.rmsDb(chs, SR, a, b) / 10) * (b - a);
    d += b - a;
  }
  return 10 * Math.log10(p / d);
}

// ---- robot listener -----------------------------------------------------------------------------------------------
function listen(clip, st, mo) {
  const chs = st.chs;
  const m = {};
  m.rmsDb = A.round(clip.rmsWindows ? rmsDbWindows(chs, clip.rmsWindows) : A.rmsDb(chs, SR, ...WIN), 1);
  if (clip.rmsWindows) m.rmsWindows = clip.rmsWindows.map(([a, b]) => `${A.round(a, 2)}–${A.round(b, 2)}`).join(', ');
  m.bandRmsDb = A.round(A.bandRmsDb(chs, SR, 100, 5000, ...WIN), 1);
  m.tailRmsDb = A.round(A.rmsDb(chs, SR, PLAY_END, SECONDS), 1);
  const pk = A.peak(chs, SR);
  m.peakDb = A.round(pk.db, 2);
  m.peakAt = A.round(pk.at, 3);
  m.dc = Number(A.dcOffset(chs, SR).toExponential(2));
  m.monoLossDb = A.round(A.monoLossDb(chs, SR, ...WIN), 2);
  m.nonFinite = A.nonFinite(chs);
  m.centroidHz = Math.round(A.spectralCentroid(chs, SR, ...WIN));
  m.below120Hz = A.round(100 * A.powerFractionBelow(chs, SR, 120, ...WIN), 1);
  m.segmentsDb = [0, 1, 2, 3].map((k) => A.round(A.rmsDb(chs, SR, k * CHORD_DUR + 0.3, k * CHORD_DUR + 1.9), 1));
  m.dropout = A.longestDropout(chs, SR, 0.3, PLAY_END, LIMITS.silence);
  m.clicks = clip.crackle ? null : A.detectClicks(chs, SR, { excludeTimes: clip.onsets });
  // mono render (engine mono mode: (L+R)·0.707 after the clip stage)
  m.mono = {
    rmsDb: A.round(A.rmsDb([mo.chs[0]], SR, ...WIN), 1),
    peakDb: A.round(A.peak([mo.chs[0]], SR).db, 2),
    nonFinite: A.nonFinite(mo.chs),
  };

  const hard = [];
  const soft = [];
  const chk = (ok, list, msg) => {
    if (!ok) list.push(msg);
  };
  m.rmsLo = clip.rmsLo ?? LIMITS.rmsLo;
  chk(m.rmsDb >= m.rmsLo && m.rmsDb <= LIMITS.rmsHi, hard, `RMS ${m.rmsDb} dBFS outside ${m.rmsLo}..${LIMITS.rmsHi}`);
  chk(m.peakDb <= LIMITS.peak, hard, `peak ${m.peakDb} dBFS > ${LIMITS.peak}`);
  chk(Math.abs(m.dc) < LIMITS.dc, hard, `DC ${m.dc} ≥ ${LIMITS.dc}`);
  chk(m.monoLossDb < LIMITS.monoLoss, hard, `mono-sum loss ${m.monoLossDb} dB ≥ ${LIMITS.monoLoss}`);
  chk(m.nonFinite === 0, hard, `${m.nonFinite} NaN/Inf samples`);
  chk(m.segmentsDb.every((d) => d > LIMITS.silence), hard, `silent chord segment (${m.segmentsDb.join(', ')} dBFS)`);
  chk(m.mono.nonFinite === 0, hard, `mono render: ${m.mono.nonFinite} NaN/Inf samples`);
  chk(m.mono.rmsDb > LIMITS.silence, hard, `mono render silent (${m.mono.rmsDb} dBFS)`);
  if (m.clicks) chk(m.clicks.count === 0, soft, `click detector: ${m.clicks.count} HF burst(s) at ${m.clicks.events.slice(0, 6).map((e) => `${e.t}s (+${e.overDb} dB)`).join(', ')}`);
  // (a calibWindow patch is silent between its short notes by design)
  if (!clip.rmsWindows) chk(m.dropout.seconds === 0, soft, `drop-out: ${m.dropout.seconds} s below ${LIMITS.silence} dBFS at ${m.dropout.at} s`);
  chk(m.mono.peakDb <= LIMITS.peak, soft, `mono render peak ${m.mono.peakDb} dBFS (mono sum is after the clip stage)`);
  const warns = [...new Set([...(st.warnings || []), ...(st.console || []), ...(mo.console || [])])];
  if (st.slots?.some((s) => s?.fallback)) hard.push('an instrument rendered with the FALLBACK synth');
  for (const w of warns) soft.push(`engine: ${w}`);
  return { metrics: m, hard, soft };
}

// ---- main ---------------------------------------------------------------------------------------------------------
const selfTest = A.clickDetectorSelfTest(SR);
console.log(`click detector self-test: ${selfTest.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(selfTest)}`);

const r = await openRenderer();
const results = [];
let failed = 0;
try {
  const { list, nativeTrims } = await r.listInstruments();
  const instIds = new Set(list.map((x) => `${x.ref.type}:${x.ref.id}`));
  const trims = trimsForJob(readGainTrims());
  const manifestTrims = Object.fromEntries(readManifest().instruments.map((i) => [i.id, i.gainTrim]));
  console.log(`audition: trims via ${nativeTrims ? 'engine registry' : 'render shim'}; synth/organ ${JSON.stringify({ ...trims.synth, ...trims.organ })}; drone ${trims.droneTrim} dB; sampler ${JSON.stringify(manifestTrims)}`);
  const clips = [
    ...FACTORY_SONGS.map(songClip),
    ...list.filter((x) => x.ref.type !== 'sampler').map(instClip),
    ...list.filter((x) => x.ref.type === 'sampler').map(instClip),
  ].filter((c) => !ONLY || ONLY.has(c.slug));

  for (const clip of clips) {
    const job = { ...clip.job, trims };
    const st = await r.render(job);
    const mo = await r.render({ ...job, mono: true });
    const res = listen(clip, st, mo);
    // layer balance: solo renders of each active slot (and the drone) for multi-layer songs
    const layers = [];
    if (SOLO && clip.kind === 'song') {
      const active = clip.job.patch.slots.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
      const parts = [...active.map((i) => ({ label: `slot ${i} ${clip.job.patch.slots[i].instrument.id}`, slot: i })), ...(clip.job.drone ? [{ label: 'drone', slot: null }] : [])];
      if (parts.length > 1) {
        for (const part of parts) {
          const patch = clone(clip.job.patch);
          patch.slots = patch.slots.map((s, i) => (i === part.slot ? s : null));
          const solo = await r.render({ ...job, patch, drone: part.slot === null ? job.drone : null });
          const d = A.round(A.rmsDb(solo.chs, SR, ...WIN), 1);
          layers.push({ part: part.label, rmsDb: d, relDb: A.round(d - res.metrics.rmsDb, 1) });
          if (d - res.metrics.rmsDb < LIMITS.layerInaudible) res.soft.push(`layer "${part.label}" is ${A.round(d - res.metrics.rmsDb, 1)} dB under the mix (likely inaudible)`);
        }
      }
    }
    const lint = clip.kind === 'song' ? lintSong(clip.song, instIds) : [];
    for (const l of lint) res.soft.push(`preset: ${l}`);
    // write wavs
    fs.writeFileSync(path.join(OUT, `${clip.slug}.wav`), Buffer.from(encodeWav(st.chs, SR)));
    fs.writeFileSync(path.join(OUT, `${clip.slug}.mono.wav`), Buffer.from(encodeWav([mo.chs[0]], SR)));
    const pass = res.hard.length === 0;
    if (!pass) failed++;
    const status = pass ? (res.soft.length ? 'WARN' : 'PASS') : 'FAIL';
    results.push({
      slug: clip.slug, name: clip.name, kind: clip.kind, category: clip.category, setup: clip.setup, listen: clip.listen,
      status, hard: res.hard, soft: res.soft, metrics: res.metrics, layers, renderMs: st.ms + mo.ms, trimMode: st.trimMode,
    });
    const m = res.metrics;
    console.log(`${status.padEnd(4)} ${clip.slug.padEnd(24)} rms ${String(m.rmsDb).padStart(6)}  peak ${String(m.peakDb).padStart(6)}  mono-loss ${String(m.monoLossDb).padStart(5)}  dc ${m.dc}  ${res.hard.join('; ')}`);
    for (const s of res.soft) console.log(`       · ${s}`);
  }
} finally {
  await r.close();
}

// ---- report + index -------------------------------------------------------------------------------------------------
if (ONLY) {
  // partial run: merge into the existing report so index.html keeps every clip
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8')).clips || [];
    const bySlug = new Map(results.map((x) => [x.slug, x]));
    const merged = prev.map((x) => bySlug.get(x.slug) || x);
    for (const x of results) if (!prev.some((p) => p.slug === x.slug)) merged.push(x);
    results.splice(0, results.length, ...merged);
  } catch {}
}
const sizeMB = fs.readdirSync(OUT).filter((f) => f.endsWith('.wav')).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0) / 1048576;
const summary = {
  generated: new Date().toISOString(),
  sampleRate: SR,
  seconds: SECONDS,
  limits: LIMITS,
  windows: { rms: WIN, tail: [PLAY_END, SECONDS] },
  clickDetectorSelfTest: selfTest,
  totals: { clips: results.length, pass: results.filter((x) => x.status === 'PASS').length, warn: results.filter((x) => x.status === 'WARN').length, fail: results.filter((x) => x.status === 'FAIL').length, sizeMB: A.round(sizeMB, 1) },
};
if (sizeMB > SIZE_BUDGET_MB) {
  console.log(`audition output ${sizeMB.toFixed(1)} MB exceeds the ${SIZE_BUDGET_MB} MB budget`);
  failed++;
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ...summary, clips: results }, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'index.html'), renderIndex(summary, results));

console.log(`\n${table(results.map((x) => ({ clip: x.slug, status: x.status, 'rms dB': x.metrics.rmsDb, 'band dB': x.metrics.bandRmsDb, 'peak dB': x.metrics.peakDb, 'mono loss': x.metrics.monoLossDb, 'centroid Hz': x.metrics.centroidHz, clicks: x.metrics.clicks ? x.metrics.clicks.count : 'n/a' })), ['clip', 'status', 'rms dB', 'band dB', 'peak dB', 'mono loss', 'centroid Hz', 'clicks'])}`);
console.log(`\n${summary.totals.pass} pass, ${summary.totals.warn} warn, ${summary.totals.fail} fail; ${summary.totals.sizeMB} MB in ${OUT}`);
process.exit(failed ? 1 : 0);

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderIndex(sum, clips) {
  const badge = (s) => `<span class="badge ${s.toLowerCase()}">${s}</span>`;
  const num = (v, bad) => `<td class="${bad ? 'bad' : ''}">${esc(v)}</td>`;
  const card = (c) => {
    const m = c.metrics;
    const L = sum.limits;
    const rows = `
      <table class="nums"><tbody>
        <tr><th>RMS (0.5–8 s)</th>${num(`${m.rmsDb} dBFS`, m.rmsDb < (m.rmsLo ?? L.rmsLo) || m.rmsDb > L.rmsHi)}<th>band 100 Hz–5 kHz</th>${num(`${m.bandRmsDb} dBFS`)}</tr>
        <tr><th>peak</th>${num(`${m.peakDb} dBFS @ ${m.peakAt} s`, m.peakDb > L.peak)}<th>tail RMS (8–12 s)</th>${num(`${m.tailRmsDb} dBFS`)}</tr>
        <tr><th>mono-sum loss</th>${num(`${m.monoLossDb} dB`, m.monoLossDb >= L.monoLoss)}<th>DC</th>${num(m.dc, Math.abs(m.dc) >= L.dc)}</tr>
        <tr><th>spectral centroid</th>${num(`${m.centroidHz} Hz`)}<th>power &lt; 120 Hz</th>${num(`${m.below120Hz} %`)}</tr>
        <tr><th>per chord (I V vi IV)</th>${num(m.segmentsDb.join(' / ') + ' dBFS')}<th>clicks</th>${num(m.clicks ? m.clicks.count : 'n/a (crackle)', m.clicks && m.clicks.count > 0)}</tr>
        <tr><th>mono render</th>${num(`RMS ${m.mono.rmsDb} · peak ${m.mono.peakDb} dBFS`, m.mono.peakDb > L.peak)}<th>NaN/Inf</th>${num(m.nonFinite + m.mono.nonFinite, m.nonFinite + m.mono.nonFinite > 0)}</tr>
      </tbody></table>`;
    const layers = c.layers.length
      ? `<div class="layers"><b>Layers (solo RMS vs mix):</b> ${c.layers.map((l) => `<span class="${l.relDb < L.layerInaudible ? 'bad' : ''}">${esc(l.part)} ${l.relDb > 0 ? '+' : ''}${l.relDb} dB</span>`).join(' · ')}</div>`
      : '';
    const issues = [...c.hard.map((h) => `<li class="hard">${esc(h)}</li>`), ...c.soft.map((s) => `<li class="soft">${esc(s)}</li>`)].join('');
    return `
    <section class="clip ${c.status.toLowerCase()}" id="${esc(c.slug)}">
      <header><h3>${esc(c.name)}</h3>${badge(c.status)}<span class="cat">${esc(c.category)}</span></header>
      <p class="setup">${esc(c.setup)}</p>
      <p class="listen"><b>Listen for:</b> ${esc(c.listen)}</p>
      <div class="players">
        <label>Stereo <audio controls preload="none" src="${esc(c.slug)}.wav"></audio></label>
        <label>Mono <audio controls preload="none" src="${esc(c.slug)}.mono.wav"></audio></label>
      </div>
      ${rows}${layers}
      ${issues ? `<ul class="issues">${issues}</ul>` : ''}
    </section>`;
  };
  const songs = clips.filter((c) => c.kind === 'song');
  const insts = clips.filter((c) => c.kind === 'instrument');
  const toc = (list) => list.map((c) => `<a href="#${esc(c.slug)}">${badge(c.status)} ${esc(c.name)}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Worship Rig Audition</title>
<style>
  :root { --bg:#111418; --panel:#1b2027; --text:#e8ecf1; --muted:#9aa5b1; --pass:#3fb950; --warn:#d29922; --fail:#f85149; --line:#2b323c; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --panel:#fff; --text:#1c2128; --muted:#57606a; --line:#d8dee4; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { margin: 32px 0 12px; font-size: 19px; }
  .sub { color: var(--muted); margin: 0 0 16px; }
  .totals { display:flex; gap:12px; flex-wrap:wrap; margin: 12px 0 20px; }
  .totals div { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 14px; }
  .toc { display:flex; flex-wrap:wrap; gap:6px 14px; } .toc a { color:var(--text); text-decoration:none; white-space:nowrap; }
  .clip { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--pass); border-radius:8px; padding:14px 16px; margin: 14px 0; }
  .clip.warn { border-left-color: var(--warn); } .clip.fail { border-left-color: var(--fail); }
  .clip header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; } .clip h3 { margin:0; font-size:17px; }
  .cat { color:var(--muted); font-size:13px; }
  .badge { font-size:11px; font-weight:700; letter-spacing:.04em; padding:2px 7px; border-radius:4px; color:#fff; background:var(--pass); }
  .badge.warn { background:var(--warn); } .badge.fail { background:var(--fail); }
  .setup { color:var(--muted); font-size:13px; margin:6px 0; } .listen { margin:6px 0 10px; }
  .players { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:10px; } .players label { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; }
  audio { height: 34px; max-width: 100%; }
  table.nums { border-collapse: collapse; font-size:13px; width:100%; font-variant-numeric: tabular-nums; }
  .nums th { text-align:left; color:var(--muted); font-weight:500; padding:3px 8px 3px 0; white-space:nowrap; } .nums td { padding:3px 18px 3px 0; }
  .bad { color: var(--fail); font-weight:600; }
  .layers { font-size:13px; margin-top:8px; }
  .issues { font-size:13px; margin:8px 0 0; padding-left:18px; } .issues .hard { color:var(--fail); } .issues .soft { color:var(--warn); }
  .limits { font-size:13px; color:var(--muted); }
  @media (max-width: 640px) { .nums th, .nums td { display:block; padding:0; } .nums td { margin-bottom:6px; } }
</style></head>
<body><main>
<h1>Worship Rig — audition pack</h1>
<p class="sub">Generated ${esc(sum.generated)} · ${sum.sampleRate} Hz 16-bit · ${sum.seconds} s clips: I–V–vi–IV, 2 s per chord (sustain pedal re-pressed per chord), then a 4 s tail. Seeded offline renders of the real engine.</p>
<div class="totals"><div>${sum.totals.clips} clips</div><div>${badge('PASS')} ${sum.totals.pass}</div><div>${badge('WARN')} ${sum.totals.warn}</div><div>${badge('FAIL')} ${sum.totals.fail}</div><div>${sum.totals.sizeMB} MB audio</div></div>
<p class="limits">Hard checks: RMS (0.5–8 s) ${sum.limits.rmsLo}…${sum.limits.rmsHi} dBFS (instrument clips: floor = nominal level − ${INST_FLOOR_MARGIN_DB} dB, −27.9 for Keys) · peak ≤ ${sum.limits.peak} dBFS · |DC| &lt; ${sum.limits.dc} · mono-sum loss &lt; ${sum.limits.monoLoss} dB · no NaN · no silent chord. Soft (WARN): HF-burst click detector (self-test ${sum.clickDetectorSelfTest.pass ? 'passed' : 'FAILED'}), drop-outs, mono render peak, layer balance (a layer more than ${-sum.limits.layerInaudible} dB under the mix), preset lint.</p>
<h2>Factory songs</h2><div class="toc">${toc(songs)}</div>
${songs.map(card).join('')}
<h2>Instruments (default settings)</h2><div class="toc">${toc(insts)}</div>
${insts.map(card).join('')}
</main></body></html>
`;
}
