// Chart view (D7, hidden; CONTRACT_CHANGES "Chart view (D7, hidden)"): the pure part. No DOM, no Web Audio, no
// timers, so node:test covers it (test/unit/charts/chart-view.test.mjs). The DOM side is index.js / render.js /
// import.js in this folder; they are only loaded while settings.chartView is on.
//
// The stored chart is source text only (song.chart, store.js normalizeChart); everything here derives from it:
//   parse (cached by text) → the key it is written in → the shift to the key on show → transposeChart.
// Which key is on show follows the song's Easy Transpose live:
//   'hear' (default): the key the band hears (song.hearIn), so Perform's Transpose −/+ moves the chords;
//   'play': the key the hands play (song.playIn), for reading shapes while Easy Transpose moves the sound.
import { parseChart, transposeChart, normalizeKey, detectFormat, parseSongListCsv } from '../../shared/chart-parse.js';
import { keyName, mod12 } from '../../shared/music.js';
import { meterOf, validTimeSig, DEFAULT_TIME_SIG } from '../../shared/click-math.js';

/** File types the "Add chart…" picker offers (C2-parser.md "What the importer UI needs next"). */
export const CHART_ACCEPT = '.cho,.chopro,.chordpro,.chord,.crd,.pro,.txt,.csv,text/plain,text/csv';
/** Chart type sizes in px (big-type steps); CHART_FONT_DEFAULT is the index of the default. */
export const CHART_FONT_STEPS = Object.freeze([16, 20, 24, 28, 34, 40, 48, 56]);
export const CHART_FONT_DEFAULT = 2;
/** Auto-scroll speed multipliers; CHART_SPEED_DEFAULT is the index of ×1. */
export const CHART_SPEED_STEPS = Object.freeze([0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
export const CHART_SPEED_DEFAULT = 5;
/** Auto-scroll assumes one chart line (chords + lyric) lasts this many bars. */
export const BARS_PER_LINE = 2;
/** Auto-scroll tempo for a song that has none. */
export const FALLBACK_TEMPO = 72;
/** What the key on show follows. */
export const CHART_MODES = Object.freeze(['hear', 'play']);
/** Song tempo range (store.js normalizeSong clamps to it). */
const TEMPO_MIN = 30;
const TEMPO_MAX = 300;
const NAME_MAX = 120;

const NOTE_PC = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

/**
 * A key name's pitch class and mode.
 * @param {string} key 'G', 'Bb', 'F#m', 'c minor', …
 * @returns {{pc:number, minor:boolean}|null}
 */
export function keyInfo(key) {
  const k = normalizeKey(key);
  if (!k) return null;
  const minor = k.endsWith('m');
  const root = minor ? k.slice(0, -1) : k;
  const acc = root[1] === '#' ? 1 : root[1] === 'b' ? -1 : 0;
  return { pc: mod12(NOTE_PC[root[0]] + acc), minor };
}

/** The song's sounding key as a name ('Bb', 'F#m'). @param {object} song */
export const songKeyName = (song) => keyName(song ? song.hearIn : 0, !!(song && song.minor));

const parseCache = new Map(); // text + format → model (frozen-in-spirit: callers never mutate it)
const CACHE_MAX = 24;

/**
 * Parse a stored chart (song.chart). Cached by text and format, so a re-render on every transpose step parses once.
 * @param {{text:string, format?:string, name?:string}|null|undefined} chart
 * @returns {object|null} the parser's model, or null when there is no chart
 */
export function parseStoredChart(chart) {
  if (!chart || typeof chart.text !== 'string') return null;
  const format = chart.format === 'chordpro' || chart.format === 'plain' ? chart.format : null;
  const k = `${format || '?'}\u0000${chart.name || ''}\u0000${chart.text}`;
  let m = parseCache.get(k);
  if (!m) {
    m = parseChart(chart.text, { format: format || undefined, name: chart.name || '' });
    if (parseCache.size >= CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
    parseCache.set(k, m);
  }
  return m;
}

/**
 * The key a chart is written in: the source's own {key}, else the key stored with it at import (chart.key), else the
 * song's Play In key. That last one is for charts stored without a key (the importer always stores one): such a chart
 * shows as written in the hands' key and moves by exactly the Easy Transpose amount in the heard key.
 * @param {object|null} model parsed chart
 * @param {object|null} chart song.chart
 * @param {object} song
 * @returns {{key:string, from:'chart'|'stored'|'song'}}
 */
export function chartSourceKey(model, chart, song) {
  const own = model && normalizeKey(model.key || '');
  if (own) return { key: own, from: 'chart' };
  const stored = chart && normalizeKey(chart.key || '');
  if (stored) return { key: stored, from: 'stored' };
  return { key: keyName(song ? song.playIn : 0, !!(song && song.minor)), from: 'song' };
}

/**
 * Semitones (0..11) from the key a chart is written in to the key on show. Octaves don't change chord names, so
 * transposeOctave is ignored.
 *
 * Mode mismatch (skeptic V1): a chart in Em on a song set to G (or in G on a song set to Em) is its relative key, the
 * same key signature. Matching tonics turned Em C G D into Gm Eb Bb F over a G drone. So when the modes differ, the
 * chart's tonic is not the song's Play In or Hear In, and its relative key is one of them, the chart is matched through
 * its relative key. Any other mismatch (a parallel Em chart on an E song, say) keeps the tonic match. The match is
 * one pitch class for both modes, so Heard and Hands always differ by exactly the Easy Transpose amount.
 * @param {object} song store song (playIn, hearIn, minor)
 * @param {string} sourceKey
 * @param {'hear'|'play'} [mode='hear']
 * @returns {number}
 */
export function chartShift(song, sourceKey, mode = 'hear') {
  const k = keyInfo(sourceKey);
  if (!k || !song) return 0;
  const target = mode === 'play' ? song.playIn : song.hearIn;
  const keys = [mod12(Number(song.playIn)), mod12(Number(song.hearIn))];
  const rel = mod12(k.minor ? k.pc + 3 : k.pc - 3); // relative major is 3 semitones above its minor
  const viaRelative = k.minor !== !!song.minor && !keys.includes(k.pc) && keys.includes(rel);
  return mod12(Number(target) - (viaRelative ? rel : k.pc));
}

/**
 * Everything the chart view shows for a song: the transposed model and its keys. Spelling (flats or sharps) follows
 * the key on show: transposeChart spells for its target key, and an unkeyed chart is given its source key first so
 * that this holds for it too.
 * @param {object|null} song
 * @param {'hear'|'play'} [mode='hear']
 * @returns {null|{model:object, sourceKey:string, keyFrom:string, shownKey:string, shift:number, warnings:string[]}}
 */
export function chartView(song, mode = 'hear') {
  const chart = song && song.chart;
  const parsed = parseStoredChart(chart);
  if (!parsed) return null;
  const { key: sourceKey, from } = chartSourceKey(parsed, chart, song);
  const shift = chartShift(song, sourceKey, mode);
  const base = parsed.key ? parsed : { ...parsed, key: sourceKey };
  const model = transposeChart(base, shift);
  const shownKey = model.key || sourceKey;
  return { model, sourceKey, keyFrom: from, shownKey, shift, warnings: parsed.warnings.slice() };
}

/**
 * Split a model line into what the renderer lays out: one segment per chord, holding the chord and the lyric from its
 * `at` to the next chord's (plus a leading chordless segment when the lyric starts before the first chord). The
 * renderer stacks chord over lyric in monospace inside each segment, so a chord sits over the character at `at`.
 * @param {{lyric:string, chords:{at:number, chord:string, annotation?:boolean}[]}} line
 * @returns {{chord:string, annotation:boolean, text:string}[]}
 */
export function lineSegments(line) {
  const lyric = line && typeof line.lyric === 'string' ? line.lyric : '';
  const chords = (line && Array.isArray(line.chords) ? line.chords : [])
    .filter((c) => c && typeof c.chord === 'string')
    .map((c) => ({ ...c, at: Math.max(0, Math.min(lyric.length, Math.round(Number(c.at) || 0))) }))
    .sort((a, b) => a.at - b.at); // the parser keeps order; this guards hand-made models
  const out = [];
  const first = chords.length ? chords[0].at : lyric.length;
  if (first > 0 || !chords.length) out.push({ chord: '', annotation: false, text: lyric.slice(0, first) });
  chords.forEach((c, i) => {
    const end = i + 1 < chords.length ? chords[i + 1].at : lyric.length;
    out.push({ chord: c.chord, annotation: !!c.annotation, text: lyric.slice(c.at, end) });
  });
  return out;
}

/**
 * How many sung lines a chart has, for the auto-scroll pace: comments don't count; a bare {chorus} (recall: true)
 * counts the lines of the last section of that kind before it, since it is sung again.
 * @param {object|null} model
 * @returns {number}
 */
export function songLineCount(model) {
  if (!model || !Array.isArray(model.sections)) return 0;
  let n = 0;
  const lastOfKind = new Map();
  for (const s of model.sections) {
    if (!s) continue;
    const lines = Array.isArray(s.lines) ? s.lines.filter((l) => l && !l.comment).length : 0;
    if (s.recall) n += lastOfKind.get(s.kind) || 0;
    else {
      n += lines;
      lastOfKind.set(s.kind, lines);
    }
  }
  return n;
}

/**
 * Seconds one chart line lasts: BARS_PER_LINE bars of the song's meter at its tempo. The BPM counts the felt beat, so
 * a 6/8 bar is 2 beats (click-math meterOf).
 * @param {number|null} tempo BPM (null / bad → FALLBACK_TEMPO)
 * @param {string} [timeSig]
 * @returns {number}
 */
export function secondsPerLine(tempo, timeSig) {
  const bpm = Number.isFinite(Number(tempo)) && Number(tempo) > 0 && tempo !== null ? Number(tempo) : FALLBACK_TEMPO;
  return (BARS_PER_LINE * meterOf(timeSig || DEFAULT_TIME_SIG).beats * 60) / bpm;
}

/**
 * Auto-scroll speed: the scrollable distance is covered in the song's length (lines × secondsPerLine), divided by the
 * multiplier, so the view reaches the end as the last line is sung.
 * @param {{tempo?:number|null, timeSig?:string, lines:number, scrollPx:number, multiplier?:number}} o
 * @returns {number} px per second (0 when there is nothing to scroll)
 */
export function autoScrollRate({ tempo = null, timeSig, lines, scrollPx, multiplier = 1 }) {
  const n = Number(lines);
  const px = Number(scrollPx);
  const m = Number(multiplier);
  if (!(n > 0) || !(px > 0) || !(m > 0)) return 0;
  return (px * m) / (n * secondsPerLine(tempo, timeSig));
}

/**
 * Step through a list of choices by index, clamped at the ends.
 * @param {ReadonlyArray<number>} steps
 * @param {number} i current index
 * @param {number} dir −1 / +1
 * @returns {number} the new index
 */
export function stepIndex(steps, i, dir) {
  const cur = Number.isInteger(i) && i >= 0 && i < steps.length ? i : 0;
  return Math.max(0, Math.min(steps.length - 1, cur + Math.sign(dir)));
}

/**
 * What an imported chart OFFERS to change on the song: title, key, tempo, time signature. Nothing is applied here;
 * the dialog lists them unticked, and only ticked ones are written (offerWrites). Values the song can't hold are not
 * offered and say why in `notes`.
 * @param {object} model parsed chart
 * @param {object} song store song
 * @returns {{offers:{field:string, label:string, from:string, to:string, value:*}[], notes:string[], askTempo:boolean}}
 */
export function importOffers(model, song) {
  const offers = [];
  const notes = [];
  if (!model || !song) return { offers, notes, askTempo: false };
  const title = typeof model.title === 'string' ? model.title.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
  if (title && title !== song.name) {
    offers.push({ field: 'name', label: 'Title', from: song.name, to: title, value: title });
  }
  const k = keyInfo(model.key || '');
  if (k) {
    const cur = songKeyName(song);
    const to = keyName(k.pc, k.minor);
    if (k.pc !== song.hearIn || k.minor !== !!song.minor) {
      offers.push({ field: 'key', label: 'Key', from: cur, to, value: { pc: k.pc, minor: k.minor } });
    }
  }
  const t = model.tempo;
  if (Number.isFinite(t)) {
    if (t < TEMPO_MIN || t > TEMPO_MAX) {
      notes.push(`The chart's tempo (${t} BPM) is outside ${TEMPO_MIN}–${TEMPO_MAX}, so it isn't offered.`);
    } else if (Math.round(t) !== song.tempo) {
      const from = song.tempo ? `${song.tempo} BPM` : 'none';
      offers.push({ field: 'tempo', label: 'Tempo', from, to: `${Math.round(t)} BPM`, value: Math.round(t) });
    }
  }
  if (typeof model.timeSig === 'string' && model.timeSig) {
    const sig = validTimeSig(model.timeSig);
    const cur = song.timeSig || DEFAULT_TIME_SIG;
    if (!sig) {
      notes.push(`The chart's time signature (${model.timeSig}) isn't one the click knows, so it isn't offered.`);
    } else if (sig !== cur) offers.push({ field: 'timeSig', label: 'Time', from: cur, to: sig, value: sig });
  }
  // O-AW-1: a missing tempo is asked for (it paces the auto-scroll and the click)
  const askTempo = !Number.isFinite(t) && (song.tempo === null || song.tempo === undefined);
  return { offers, notes, askTempo };
}

/**
 * The store writes (song-relative path, value) for the ticked offers. A key offer sets the key the band hears and
 * keeps the Easy Transpose amount, like the drone key grid (controller 'droneKey'): Play In moves with it.
 * @param {{field:string, value:*}[]} ticked
 * @param {object} song
 * @returns {[string, *][]}
 */
export function offerWrites(ticked, song) {
  const out = [];
  for (const o of ticked || []) {
    if (!o) continue;
    if (o.field === 'name' && typeof o.value === 'string' && o.value) out.push(['name', o.value]);
    else if (o.field === 'tempo' && Number.isFinite(o.value)) {
      out.push(['tempo', Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(o.value)))]);
    } else if (o.field === 'timeSig' && validTimeSig(o.value)) {
      out.push(['timeSig', o.value === DEFAULT_TIME_SIG ? null : o.value]); // 4/4 is stored as absent
    } else if (o.field === 'key' && o.value && Number.isInteger(o.value.pc)) {
      const semis = mod12(song.hearIn - song.playIn);
      out.push(['hearIn', mod12(o.value.pc)]);
      out.push(['playIn', mod12(o.value.pc - semis)]);
      out.push(['minor', !!o.value.minor]);
    }
  }
  return out;
}

/**
 * Read an imported file or pasted text: a chart, or a WorshipTools song-list CSV.
 * @param {string} text
 * @param {{name?:string, format?:'auto'|'chordpro'|'plain'}} [o]
 * @returns {{kind:'chart', format:'chordpro'|'plain', model:object} | {kind:'csv', songs:object[], warnings:string[]}}
 */
export function readImport(text, { name = '', format = 'auto' } = {}) {
  const f = format === 'chordpro' || format === 'plain' ? format : detectFormat(name, text);
  if (f === 'csv') {
    const r = parseSongListCsv(text);
    return { kind: 'csv', songs: r.songs, warnings: r.warnings };
  }
  return { kind: 'chart', format: f, model: parseChart(text, { format: f, name }) };
}

/**
 * Placeholder songs for a song list: one per title not already in the library (by name, ignoring case and spaces).
 * Notes carry the artist and the CCLI number.
 * @param {object[]} songs parseSongListCsv songs
 * @param {string[]} existingNames
 * @returns {{add:{name:string, notes:string}[], skipped:string[]}}
 */
export function csvPlaceholders(songs, existingNames) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const have = new Set((existingNames || []).map(norm));
  const add = [];
  const skipped = [];
  for (const s of songs || []) {
    const name = String(s && s.title ? s.title : '').trim().slice(0, NAME_MAX);
    if (!name) continue;
    if (have.has(norm(name))) {
      skipped.push(name);
      continue;
    }
    have.add(norm(name));
    const bits = [s.artist, s.ccli ? `CCLI ${s.ccli}` : null].filter(Boolean);
    add.push({ name, notes: bits.join(' · ') });
  }
  return { add, skipped };
}
