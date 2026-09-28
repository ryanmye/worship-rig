// Pure mapping from a parsed EXS instrument to the app's sample-manifest shape (see app/js/engine/sampler.js):
//   { id, name, category, group?, ext, layers:[{ vel:[lo,hi], dir, notes:['Db4',…] }], release, gainTrim, loop, … }
// The engine plays <manifest dir>/<layer.dir>/<note>.<ext> and repitches the nearest sampled note, so each layer
// only needs one file per root note.

const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** MIDI → flat note name, C4 = 60 (matches app/js/shared/music.js parseNoteName). */
export function flatName(midi) {
  return `${FLATS[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Folder-safe id. "Steinway Grand Piano" → "steinway-grand-piano". */
export function slugify(name) {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'instrument';
}

export const PIANO_RE = /piano|grand|upright|keys/i;

// Order matters: first match wins. `group` is set only where the engine's CATEGORY_GROUP has no mapping.
const CLASSES = [
  { re: /electric piano|rhodes|wurli|suitcase|\bep\b|clav/i, category: 'ep', release: 0.12 },
  { re: /piano|grand|upright|steinway|bösendorfer|bosendorfer|yamaha/i, category: 'piano', release: 0.12 },
  { re: /organ|harmonium|accordion/i, category: 'organ', release: 0.4 },
  { re: /bell|mallet|vibra|vibes?\b|marimba|xylo|glock|celest|chime|music box|kalimba|steel ?drum/i, category: 'mallet', release: 0.12 },
  { re: /guitar|steel string|nylon|dobro|banjo|mandolin|ukulele/i, category: 'guitar', release: 0.12 },
  { re: /string|violin|viola|cello|contrabass|orchestra|ensemble|pizz|tremolo|legato/i, category: 'strings', group: 'Strings', release: 0.6 },
  { re: /choir|voice|vocal|vox|aah|ooh|chorus|chant/i, category: 'choir', group: 'Choir', release: 0.6 },
  { re: /\bpads?\b|atmos|ambient|swell|texture|drone/i, category: 'pad', group: 'Pads', release: 0.6 },
  { re: /bass/i, category: 'bass', release: 0.12 },
  { re: /brass|horn|trumpet|trombone|tuba|flute|clarinet|oboe|bassoon|sax|wind|woodwind|recorder|whistle|synth|lead/i, category: 'sustain', group: 'GarageBand', release: 0.4 },
  { re: /harp|harpsichord|pluck|koto|sitar|dulcimer/i, category: 'pluck', release: 0.12 },
];

/** Name → { category, group?, release }. Default: decaying ("piano-like") 0.12 s. */
export function classify(name) {
  for (const c of CLASSES) if (c.re.test(name)) return { category: c.category, ...(c.group ? { group: c.group } : {}), release: c.release };
  return { category: 'other', group: 'GarageBand', release: 0.12 };
}

// Zones in groups whose name looks like one of these are not the main sound (key-off noise etc.). "pedal" and
// "damper" are deliberately NOT here: real pianos name their pedal-UP group "Sustain pedal #1" (Grand Piano) and their
// top-octave key-range group "No Dampers" (Steinway); pedal-down groups are recognised by their CC64 selector instead.
const AUX_GROUP_RE = /release|\brel\b|key ?off|key ?up|noise|hammer|thump|\bfx\b/i;

/**
 * Why a group should be skipped, or null. A group selected by a MIDI controller range that excludes 0 only plays
 * while that controller is up — for CC64 that is the sustain pedal held down (Yamaha "… sus", Steinway "p… pedal",
 * Grand Piano "Sustain pedal #2"). The app has no pedal-down sample set, so those groups are left out.
 */
export function groupSkipReason(g) {
  if (!g) return null;
  if (g.trigger === 1) return `release-trigger group "${g.name}"`;
  if (g.select && g.select.type === 'cc' && g.select.low > 0) {
    const what = g.select.number === 64 ? 'sustain-pedal-down' : `CC${g.select.number}-selected`;
    return `${what} group "${g.name}" (CC${g.select.number} ${g.select.low}-${g.select.high})`;
  }
  if (AUX_GROUP_RE.test(g.name)) return `auxiliary group "${g.name}"`;
  if (g.mute) return `muted group "${g.name}"`;
  return null;
}

/**
 * Keep only zones that describe the main key-down sound, and compute each zone's effective root and velocity range.
 * Effective velocity (verified against Logic's own files, see layout.mjs): the zone's range if its velocity-range flag
 * is on, else 0..127 — intersected with its group's range.
 * @returns {{ zones: object[], skipped: { reason:string, name:string }[], warnings: string[] }}
 */
export function usableZones(parsed) {
  const warnings = [];
  const skipped = [];
  const zones = [];
  parsed.zones.forEach((z, i) => {
    const g = z.groupIndex >= 0 ? parsed.groups[z.groupIndex] : null;
    const skip = (reason) => skipped.push({ reason, name: z.name, index: i });
    if (z.invalid) return skip('bad sample index');
    const gr = groupSkipReason(g);
    if (gr) return skip(gr);
    if (z.reverse) return skip('reversed zone');
    let vlo = z.velRangeOn ? z.velLow : 0;
    let vhi = z.velRangeOn ? z.velHigh : 127;
    if (g && g.minVel != null && g.maxVel != null) {
      vlo = Math.max(vlo, g.minVel);
      vhi = Math.min(vhi, g.maxVel);
    }
    if (vlo > vhi) return skip('zone and group velocity ranges do not overlap');
    if (!z.pitch && z.keyLow !== z.keyHigh) warnings.push(`zone "${z.name}" has key tracking off across ${flatName(z.keyLow)}–${flatName(z.keyHigh)}; the app will repitch it`);
    const root = Math.max(0, Math.min(127, z.rootNote - (z.coarseTune || 0)));
    const smp = parsed.samples[z.sampleIndex];
    // "home" zone: its own key range contains its root (a borrowed neighbour sample does not).
    const home = z.keyLow <= z.rootNote && z.rootNote <= z.keyHigh;
    // Level Logic applies to this zone: group volume + zone volume (dB). The importer bakes it in relative to the
    // loudest zone it keeps, so soft layers stay softer than loud ones as they are in Logic.
    const gainDb = (g?.volume || 0) + (z.volume || 0);
    zones.push({ ...z, index: i, root, vlo, vhi, home, gainDb, src: sourceKey(z, smp) });
  });
  if (zones.some((z) => z.loopOn)) warnings.push('some zones loop in Logic; the app plays samples one-shot (no loops) and caps length at 10–16 s, so long held notes will fade out');
  if (zones.some((z) => Math.abs(z.fineTune || 0) > 10)) warnings.push('some zones have fine-tune > 10 cents; that detune is not carried over');
  return { zones, skipped, warnings };
}

/**
 * Evenly thin a sorted list of MIDI notes: first keep only notes ≥ 3 semitones apart (a minor-third grid, always
 * keeping the lowest and highest), then, if still too many, pick `max` evenly spaced ones.
 */
export function subsampleNotes(midis, max) {
  const sorted = [...new Set(midis)].sort((a, b) => a - b);
  if (!Number.isFinite(max) || max <= 0 || sorted.length <= max) return sorted;
  if (max === 1) return [sorted[Math.floor((sorted.length - 1) / 2)]];
  let kept = [sorted[0]];
  for (const m of sorted.slice(1)) if (m - kept[kept.length - 1] >= 3) kept.push(m);
  const top = sorted[sorted.length - 1];
  if (kept[kept.length - 1] !== top) {
    if (kept.length > 1 && top - kept[kept.length - 1] < 3) kept[kept.length - 1] = top;
    else kept.push(top);
  }
  if (kept.length <= max) return kept;
  const out = [];
  for (let i = 0; i < max; i++) out.push(kept[Math.round((i * (kept.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

/**
 * Build velocity layers from usable zones.
 * Velocity bands come from the union of all zone breakpoints; within a band each root note takes the first zone
 * (file order) whose range covers the whole band (round-robins / duplicates → first). Adjacent bands with the same
 * note→zone assignment are merged, so the common case (every key split the same way) yields exactly one layer per
 * distinct velocity range.
 * @returns {{ layers: { vel:[number,number], dir:string, picks:{ midi:number, note:string, zone:object }[] }[], warnings:string[] }}
 */
export function buildLayers(zones, { maxNotesPerLayer } = {}) {
  const warnings = [];
  if (!zones.length) return { layers: [], warnings: ['no usable zones'] };
  const cuts = new Set([0, 128]);
  for (const z of zones) {
    cuts.add(z.vlo);
    cuts.add(z.vhi + 1);
  }
  const edges = [...cuts].filter((c) => c >= 0 && c <= 128).sort((a, b) => a - b);
  let bands = [];
  let dupRoots = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1] - 1;
    const byRoot = new Map();
    for (const z of zones) {
      if (z.vlo > lo || z.vhi < hi) continue;
      const prev = byRoot.get(z.root);
      if (prev) {
        dupRoots++;
        if (z.home && !prev.home) byRoot.set(z.root, z); // prefer the zone whose key range contains its root
        continue;
      }
      byRoot.set(z.root, z);
    }
    if (byRoot.size) bands.push({ lo, hi, byRoot });
  }
  // Bands merge when every root plays the same audio (e.g. Yamaha "ff" and "f" both use the _H files, with start/end
  // trims that differ by a few frames). Identity = sample file + start rounded to 0.1 s, so consolidated-CAF zones
  // (one file, starts seconds apart) stay distinct.
  const ident = (z) => (z.src == null ? `z${z.index}` : `${z.sampleIndex}@${Math.round((z.sampleStart || 0) / 4410)}`);
  const sig = (b) => [...b.byRoot.entries()].sort((x, y) => x[0] - y[0]).map(([m, z]) => `${m}:${ident(z)}`).join(',');
  // Adjacent bands also merge when every shared root plays the same audio and only a couple of roots exist in just
  // one of them (Yamaha: "ff" maps key 55 to the G#2 file where "f" has its own G2 file) — union, earlier band first.
  const compatible = (a, b) => {
    let diff = 0;
    for (const [m, z] of a.byRoot) {
      const o = b.byRoot.get(m);
      if (!o) diff++;
      else if (ident(o) !== ident(z)) return false;
    }
    for (const m of b.byRoot.keys()) if (!a.byRoot.has(m)) diff++;
    return diff <= Math.max(2, Math.floor(0.05 * Math.max(a.byRoot.size, b.byRoot.size)));
  };
  const merged = [];
  for (const b of bands) {
    const prev = merged[merged.length - 1];
    if (prev && prev.hi + 1 === b.lo && (sig(prev) === sig(b) || compatible(prev, b))) {
      prev.hi = b.hi;
      for (const [m, z] of b.byRoot) if (!prev.byRoot.has(m)) prev.byRoot.set(m, z);
    } else merged.push({ ...b, byRoot: new Map(b.byRoot) });
  }
  bands = merged;
  if (dupRoots) warnings.push(`${dupRoots} zone(s) share a root note and velocity band with another (round-robins, split-stereo L/R, layered groups or a borrowed neighbour sample) — kept the first zone whose key range contains its root`);
  if (bands.length) {
    bands[0].lo = 0;
    bands[bands.length - 1].hi = 127;
  }
  const layers = bands.map((b) => {
    let midis = [...b.byRoot.keys()].sort((x, y) => x - y);
    if (maxNotesPerLayer) midis = subsampleNotes(midis, maxNotesPerLayer);
    return {
      vel: [b.lo, b.hi],
      dir: `v${b.lo}-${b.hi}`,
      picks: midis.map((m) => ({ midi: m, note: flatName(m), zone: b.byRoot.get(m) })),
    };
  });
  return { layers, warnings };
}

/**
 * Frames the zone actually plays: null for the whole file, else { start, end|null, segment2? } in file frames
 * (end exclusive, null = to the end of the file). segment2 (consolidated CAFs) is appended seamlessly after
 * [start, end); see layout.mjs ZONE.SEGMENT2_*.
 */
export function zoneSlice(zone, sample) {
  const len = sample?.length || 0;
  const start = zone.sampleStart || 0;
  let end = zone.sampleEnd || 0;
  if (len && end > len) end = len;
  if (end && end <= start) end = 0;
  let seg2 = zone.segment2 && zone.segment2.end > zone.segment2.start ? { start: zone.segment2.start, end: zone.segment2.end } : null;
  if (seg2 && (!end || (seg2.start < end && seg2.end > start) || (len && seg2.start >= len))) seg2 = null;
  if (seg2 && len && seg2.end > len) seg2.end = len;
  if (!seg2 && len && end >= len - 1) end = 0;
  if (!start && !end && !seg2) return null;
  return seg2 ? { start, end, segment2: seg2 } : { start, end: end || null };
}

/** Key identifying one converted audio file: same sample + same slice → convert once. */
export function sourceKey(zone, sample) {
  const s = zoneSlice(zone, sample);
  if (!s) return `${zone.sampleIndex}`;
  return `${zone.sampleIndex}@${s.start}-${s.end ?? ''}${s.segment2 ? `+${s.segment2.start}-${s.segment2.end}` : ''}`;
}

/**
 * The file-frame segments [start, end) to extract, in play order, truncated so the total is ≤ maxFrames.
 * An open end (null = to the end of the file) stays open unless truncation closes it; `totalFrames` (the file length
 * from the .exs) is used only to count frames and to decide whether truncation is needed.
 * @returns {{ segments: { start:number, end:number|null }[], frames:number|null, truncated:boolean }}
 */
export function planSegments(slice, totalFrames = 0, maxFrames = 0) {
  const segs = slice ? [{ start: slice.start || 0, end: slice.end ?? null }] : [{ start: 0, end: null }];
  if (slice?.segment2) segs.push({ ...slice.segment2 });
  const lenOf = (s) => (s.end != null ? s.end - s.start : totalFrames ? Math.max(0, totalFrames - s.start) : Infinity);
  let truncated = false;
  let out = segs;
  if (maxFrames > 0) {
    let left = maxFrames;
    out = [];
    for (const s of segs) {
      if (left <= 0) {
        truncated = true;
        break;
      }
      const n = lenOf(s);
      if (n > left) {
        out.push({ start: s.start, end: s.start + left });
        if (Number.isFinite(n)) truncated = true;
        left = 0;
      } else {
        out.push(s);
        left -= n;
      }
    }
  }
  const total = out.reduce((n, s) => n + lenOf(s), 0);
  return { segments: out, frames: Number.isFinite(total) ? total : null, truncated };
}

/** Engine length cap (app/js/engine/sampler.js: 10 s above C4, 16 s at/below) + 1 s, as the default --max-seconds. */
export function autoMaxSeconds(rootMidi) {
  return rootMidi > 60 ? 11 : 17;
}

/** Output bytes per second for a format. */
export function bytesPerSecond(format, { bitrate = 160000, sampleRate = 44100, channels = 2 } = {}) {
  if (format === 'wav') return sampleRate * channels * 2;
  if (format === 'm4a') return 192000 / 8;
  return bitrate / 8;
}

/**
 * Estimated output bytes for the planned files.
 * @param {'mp3'|'m4a'|'wav'} format
 * @param {{ bitrate?:number, maxSeconds?:number|'auto', rate?:number }} [o]
 */
export function estimateBytes(layers, samples, format = 'mp3', o = {}) {
  const seen = new Set();
  let bytes = 0;
  for (const L of layers) {
    for (const p of L.picks) {
      const smp = samples[p.zone.sampleIndex];
      const key = sourceKey(p.zone, smp);
      if (seen.has(key)) continue;
      seen.add(key);
      const rate = smp.sampleRate || 44100;
      const maxSec = o.maxSeconds === 'auto' ? autoMaxSeconds(p.midi) : o.maxSeconds || 0;
      const seg = planSegments(zoneSlice(p.zone, smp), smp.length || 0, maxSec ? Math.round(maxSec * rate) : 0);
      const sec = seg.frames != null && seg.frames > 0 ? seg.frames / rate : 8;
      bytes += sec * bytesPerSecond(format, { bitrate: o.bitrate, sampleRate: format === 'wav' ? o.rate || rate : rate, channels: smp.channels || 2 });
    }
  }
  return Math.round(bytes);
}

/**
 * Full plan for one instrument (no I/O).
 * @param {object} parsed parseExs() result
 * @param {{ name?:string, maxNotesPerLayer?:number, source?:string, origin?:string }} opts
 */
export function planInstrument(parsed, opts = {}) {
  const name = opts.name || parsed.name || 'Untitled';
  const cls = classify(name);
  const u = usableZones(parsed);
  const b = buildLayers(u.zones, { maxNotesPerLayer: opts.maxNotesPerLayer });
  return {
    id: slugify(name),
    name,
    ...cls,
    layers: b.layers,
    skipped: u.skipped,
    warnings: [...parsed.warnings, ...u.warnings, ...b.warnings],
  };
}

/** Manifest instrument entry from a plan + the notes actually written per layer. */
export const LICENSE = 'personal-use';
export const ATTRIBUTION = 'Apple Logic/GarageBand sound library — personal use only, not redistributable';

// Same keys, in the same order, as app/samples/manifest.json's instruments (plus `group` where the engine needs it).
export function manifestEntry(plan, { ext, origin = 'GarageBand', source = '', writtenLayers }) {
  const layers = (writtenLayers || plan.layers.map((L) => ({ vel: L.vel, dir: L.dir, notes: L.picks.map((p) => p.note) })))
    .filter((L) => L.notes.length)
    .map((L) => ({ vel: L.vel, dir: L.dir, notes: L.notes }));
  return {
    id: plan.id,
    name: `${plan.name} (${origin})`,
    category: plan.category,
    ...(plan.group ? { group: plan.group } : {}),
    ext,
    layers,
    release: plan.release,
    gainTrim: 0,
    license: LICENSE,
    source,
    attribution: ATTRIBUTION,
  };
}
