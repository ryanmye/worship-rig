#!/usr/bin/env node
// Lane N1: generates native/core/src/hostkit/collation_table.inc, the primary-weight table hostkit's `jsLocaleCompare`
// uses to sort pack folders and song files the way server.js does (`a.localeCompare(b, undefined, {numeric: true,
// sensitivity: 'base'})`, ICU root collation through Node's Intl). Run with the Node (ICU) the parity test runs on:
//   node native/core/tools/hostkit/gen-collation.mjs [--check]
// The table is a model of ICU at the primary level, built by asking Intl.Collator itself:
//   - every code point of the BMP (no surrogates, no Hangul syllables: those are decomposed into jamo at run time,
//     as ICU does) and of U+1F000..U+1FAFF (emoji) is sorted on its own; equal neighbours share a rank;
//   - a code point equal to the empty string is ignorable (rank 0: accents, zero-width, controls);
//   - a code point equal to a 2- or 3-letter string of other code points (its NFKD form, or two ASCII letters:
//     ae, ss, oe, ...) is an expansion and is replaced by those code points;
//   - Nd digits (numeric: true) are flagged with their value: a run of digits compares as one number.
// Known gaps (they change the order of exotic names only; the parity test's corpus measures them): contractions,
// expansions into non-letters (1/2 for U+00BD), digits outside the Nd category, code points outside BLOCKS
// (sorted after everything, by code point).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../src/hostkit/collation_table.inc');
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = coll.compare;

// the blocks modelled (anything else sorts after them, by code point): Latin, Greek, Cyrillic, Armenian, Hebrew,
// Arabic, Hangul jamo, Latin / Greek extended, punctuation, currency, letterlike, number forms, arrows and symbols,
// CJK punctuation and kana, compatibility jamo, CJK unified ideographs, presentation forms, variation selectors,
// half/full width forms, emoji
export const BLOCKS = [[0x0000, 0x06ff], [0x1100, 0x11ff], [0x1e00, 0x1fff], [0x2000, 0x206f], [0x20a0, 0x20cf],
  [0x2100, 0x218f], [0x2190, 0x27bf], [0x3000, 0x30ff], [0x3130, 0x318f], [0x4e00, 0x9fff], [0xfb00, 0xfb4f],
  [0xfe00, 0xfe0f], [0xfe30, 0xfe4f], [0xff00, 0xffef], [0x1f000, 0x1faff]];
const cps = [];
for (const [lo, hi] of BLOCKS) for (let c = lo; c <= hi; c++) cps.push(c);
const S = (c) => String.fromCodePoint(c);
const isDigit = (c) => /\p{Nd}/u.test(S(c));

// expansions: equal to a string of >= 2 non-ignorable code points
const ignorable = new Set(cps.filter((c) => cmp(S(c), '') === 0));
const ascii = [];
for (let c = 0x61; c <= 0x7a; c++) ascii.push(S(c));
const expansions = new Map();
for (const c of cps) {
  if (ignorable.has(c) || c < 0x80 || isDigit(c)) continue;
  const s = S(c);
  const cands = new Set();
  for (const f of ['NFKD', 'NFD']) {
    const n = [...s.normalize(f)].filter((x) => cmp(x, '') !== 0).join('');
    if ([...n].length >= 2) cands.add(n);
  }
  let hit = null;
  for (const n of cands) if (cmp(s, n) === 0) { hit = n; break; }
  if (!hit && c < 0x3000) {
    // only worth the 676 tries for letters that equal no single ASCII letter
    const first = ascii.find((a) => cmp(s, a) === 0);
    if (!first && /\p{L}/u.test(s)) {
      outer: for (const a of ascii) {
        if (cmp(s, a) < 0) break;
        for (const b of ascii) if (cmp(s, a + b) === 0) { hit = a + b; break outer; }
      }
    }
  }
  if (hit && [...hit].every((x) => !expansions.has(x.codePointAt(0)))) {
    expansions.set(c, [...hit].map((x) => x.codePointAt(0)));
  }
}

// ranks: sort the singles (expansions and ignorables out), equal neighbours share a rank (1-based; 0 = ignorable)
const singles = cps.filter((c) => !ignorable.has(c) && !expansions.has(c));
singles.sort((a, b) => cmp(S(a), S(b)) || a - b);
const rank = new Map();
let r = 0;
for (let i = 0; i < singles.length; i++) {
  if (i === 0 || cmp(S(singles[i - 1]), S(singles[i])) !== 0) r++;
  rank.set(singles[i], r);
}
const maxRank = r;
for (const c of ignorable) rank.set(c, 0);

// runs over code point order: consecutive code points whose rank steps by 0 or by 1
const runs = [];
const all = [...rank.keys()].sort((a, b) => a - b);
for (const c of all) {
  const k = rank.get(c);
  const last = runs[runs.length - 1];
  if (last && c === last.end + 1) {
    const want = last.step === null ? null : last.rank + (c - last.start) * last.step;
    if (last.step === null && (k === last.rank || k === last.rank + 1)) {
      last.step = k - last.rank; last.end = c; continue;
    }
    if (want === k) { last.end = c; continue; }
  }
  runs.push({ start: c, end: c, rank: k, step: null });
}
// digit runs: value = position in a run of 10
const digits = [];
for (const c of all) {
  if (!isDigit(c)) continue;
  const v = cmp(S(c), '0') === 0 ? 0 : [1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => cmp(S(c), String(d)) === 0);
  if (v === undefined) continue;
  const last = digits[digits.length - 1];
  if (last && c === last.end + 1 && v === last.v0 + (c - last.start)) { last.end = c; continue; }
  digits.push({ start: c, end: c, v0: v });
}
const hex = (n) => `0x${n.toString(16).toUpperCase()}`;
// packed runs: two words each, (first << 11) | (length - 1) and rank | step << 31 (long runs are split)
const packed = [];
for (const x of runs) {
  for (let a = x.start; a <= x.end; a += 2048) {
    const b = Math.min(x.end, a + 2047);
    const k = x.rank + (x.step ? a - x.start : 0);
    packed.push((a * 2048 + (b - a)) >>> 0, (k | ((x.step ? 1 : 0) << 31)) >>> 0);
  }
}
const lines = [
  '// GENERATED by native/core/tools/hostkit/gen-collation.mjs from Intl.Collator (numeric, base) of',
  `// Node ${process.version}, ICU ${process.versions.icu}, Unicode ${process.versions.unicode}. Do not edit.`,
  `static constexpr std::uint32_t kMaxRank = ${maxRank};`,
  `static constexpr std::uint32_t kDigitRank = ${rank.get(0x30)};  // rank of '0' ('1'..'9' follow)`,
  '// runs in code point order, two words each: (first << 11) | (length - 1), rank of first | (step 1) << 31',
  'static constexpr std::uint32_t kRuns[] = {',
];
for (let i = 0; i < packed.length; i += 9) {
  lines.push(`  ${packed.slice(i, i + 9).map((n) => `0x${n.toString(16).padStart(8, '0')}`).join(', ')},`);
}
const table = (head, items, per) => {
  lines.push('};', ...head);
  for (let i = 0; i < items.length; i += per) lines.push(`  ${items.slice(i, i + per).join(', ')},`);
};
table(['// {code point, expansion (up to 3 code points, 0 = none)}', 'static constexpr CollExp kExpansions[] = {'],
  [...expansions].sort((x, y) => x[0] - y[0])
    .map(([c, e]) => `{${hex(c)}, {${[0, 1, 2].map((i) => (e[i] ? hex(e[i]) : '0')).join(', ')}}}`), 3);
table(['// {first, last, value of first}: Nd digits', 'static constexpr CollDigits kDigits[] = {'],
  digits.map((x) => `{${hex(x.start)}, ${hex(x.end)}, ${x.v0}}`), 5);
lines.push('};', '');
const text = lines.join('\n');
if (process.argv.includes('--check')) {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (old !== text) { console.error(`${OUT} is stale: rerun gen-collation.mjs`); process.exit(1); }
  console.log('collation table up to date');
} else {
  fs.writeFileSync(OUT, text);
  console.log(`${OUT}: ${runs.length} runs, ${expansions.size} expansions, ${digits.length} digit runs, `
    + `max rank ${maxRank}`);
}
