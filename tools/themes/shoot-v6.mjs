#!/usr/bin/env node
// UI v6 screenshots + contrast audit for every theme (U8b; the tour and its states are tools/themes/v6-tour.mjs, the
// measuring tools/themes/audit-lib.mjs, the same code as shoot.mjs for today's screens).
//   node tools/themes/shoot-v6.mjs [--theme id,id] [--only perform,edit,settings,...] [--out dir] [--sheets dir]
//                                  [--no-ui] [--verbose] [--sizes mac,portrait,landscape] [--max-controls n]
//                                  [--audit '<json audit() options>'] [--ipad-all]
//   default --out: test/phase2/ui-v6-themes/screenshots/ (git-ignored); per theme <out>/<id>/<state>.png,
//   audit-<state>-1280.json and summary.json. --sheets <dir>: a contact sheet per theme (Perform, Edit, Settings,
//   bank) → <dir>/<id>.png. Exit 1 on any contrast failure, console.error or HTTP ≥ 400.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shootV6 } from './v6-tour.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const list = (n) => (opt(n) || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = path.resolve(opt('--out', path.join(ROOT, 'test/phase2/ui-v6-themes/screenshots')));
const r = await shootV6({ themes: list('--theme'), only: list('--only'), out, sheets: opt('--sheets') ? path.resolve(opt('--sheets')) : null,
  ui: !args.includes('--no-ui'), verbose: args.includes('--verbose'), sizes: list('--sizes'),
  maxControls: opt('--max-controls') ? +opt('--max-controls') : undefined, ipadAll: args.includes('--ipad-all'),
  auditOpts: opt('--audit') ? JSON.parse(opt('--audit')) : undefined });
console.log('\n[shoot-v6] per theme: text fails · ring fails · edge fails · errors · not reached');
for (const [id, s] of Object.entries(r.themes)) {
  const v = Object.values(s.shots);
  const n = (k) => v.reduce((a, b) => a + (b[k] || 0), 0);
  console.log(`  ${id.padEnd(15)} ${v.length} shots · ${n('fails')} · ${n('ringFails')} · ${n('boundFails')} · `
    + `${s.errors.length} · ${Object.keys(s.missed).length}`);
  for (const e of s.errors.slice(0, 5)) console.log(`      error: ${e}`);
}
console.log(`[shoot-v6] totals ${JSON.stringify(r.totals)} → ${out}`);
process.exit(Object.values(r.totals).some((x) => x > 0) ? 1 : 0);
