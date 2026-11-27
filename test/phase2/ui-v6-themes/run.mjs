#!/usr/bin/env node
// UI v6 U8b suite: every v6 screen in every theme passes the contrast audit (native/docs/lanes/UI6-build-plan.md U8;
// the tour is tools/themes/v6-tour.mjs, the measuring tools/themes/audit-lib.mjs, the same code as
// tools/themes/shoot.mjs for today's screens). 1280 × 800, one fresh context per theme, settings.uiV6 on, a temp
// My Samples bank pack. Per theme, over Perform (2 / 7 instruments, the sidebar's modules, the rail, scrolled to the
// end with one muted), Quick, range pick, ⋯, Space, + Add song, Arrange, MIDI Learn, Save snapshot, the song menu,
// Lock, the Song bank (browse, trying), Edit (Sound, Range, Tone EQ, the chooser, Drone, Effects › Sends, Master),
// Settings (every category, search) and the chart (stage, sidebar, Edit chart):
//   text            0 runs under 4.5 : 1 (3 : 1 large); disabled controls and runs under the strips' edge fade exempt
//   focus rings     0 under 3 : 1 against what is behind them, 0 controls whose focus shows nothing
//   boundaries      0 text fields / selects / v6 switches whose edge (or thumb vs track) is under 3 : 1
//   every state     reached; 0 console.error, 0 HTTP ≥ 400
// Skeptic UI6-U8b: also U8a's surfaces (the first-run Start here card, the empty library and its lock line), Effects'
// Vibe menu, field hints (placeholders), selects' and fields' own words, text drawn under an overlay's shadow on every
// theme (not only where the computed colour already failed), and the iPad sizes: 820 × 1180 and 1180 × 820 in a touch
// context ((pointer: coarse), MIDI refused), the states in v6-tour.mjs IPAD_STATES (portrait: + Edit's song drawer).
//   node test/phase2/ui-v6-themes/run.mjs [--theme id,id] [--only perform,edit,...] [--sizes mac,portrait,landscape]
//   screenshots + audit JSON → ./screenshots/<theme>/ (git-ignored) or UI6T_SHOTS=<dir>; UI6T_SHEETS=<dir> also
//   writes a contact sheet per theme (Perform, Edit, Settings, Song bank).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shootV6 } from '../../../tools/themes/v6-tour.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const list = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1].split(',').map((s) => s.trim()).filter(Boolean) : []);
const OUT = process.env.UI6T_SHOTS ? path.resolve(process.env.UI6T_SHOTS) : path.join(HERE, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
console.log('\n[ui-v6-themes] the v6 screens × the themes, contrast audit');
const SIZES = list('--sizes').length ? list('--sizes') : ['mac', 'portrait', 'landscape'];
const r = await shootV6({ themes: list('--theme'), only: list('--only'), out: OUT, sizes: SIZES,
  sheets: process.env.UI6T_SHEETS ? path.resolve(process.env.UI6T_SHEETS) : null,
  log: (s) => { if (/TEXT|RING|EDGE|not reached/.test(s) || process.env.VERBOSE) console.log(s); } });

const results = [];
for (const [id, s] of Object.entries(r.themes)) {
  const shots = Object.entries(s.shots);
  const sum = (k) => shots.reduce((a, [, v]) => a + (v[k] || 0), 0);
  const runs = sum('count');
  const bad = { text: sum('fails'), rings: sum('ringFails'), edges: sum('boundFails'),
    missed: Object.keys(s.missed).length, errors: s.errors.length };
  const ok = Object.values(bad).every((n) => n === 0) && shots.length > 0;
  results.push({ id, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${id}: ${shots.length} screens, ${runs} text runs, ${sum('rings')} focus rings, `
    + `${sum('bounds')} boundaries · fails: text ${bad.text}, rings ${bad.rings}, edges ${bad.edges}; `
    + `not reached ${bad.missed}; console errors / HTTP ≥ 400 ${bad.errors}`);
  for (const [k, v] of Object.entries(s.missed)) console.log(`      not reached: ${k} (${v})`);
  for (const e of s.errors.slice(0, 10)) console.log(`      error: ${e}`);
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ generated: new Date().toISOString(), totals: r.totals,
  themes: Object.fromEntries(Object.entries(r.themes).map(([id, s]) => [id, { shots: s.shots, missed: s.missed,
    errors: s.errors }])) }, null, 1));
const failed = results.filter((x) => !x.ok);
console.log(`\n[ui-v6-themes] ${results.length - failed.length}/${results.length} themes clean `
  + `(${JSON.stringify(r.totals)}) in ${Math.round((Date.now() - t0) / 1000)} s → ${OUT}`);
process.exit(failed.length || !results.length ? 1 : 0);
