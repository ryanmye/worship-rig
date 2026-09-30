// Contact sheet of the four icon directions at Dock/list/tray sizes on light and dark. node design/icon/sheet.mjs
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const dirs = [['a-lancet','A · Lancet window'],['b-waves','B · Swell (pad envelope)'],['c-room','C · Lit room'],['d-ligature','D · W·R ligature']];
const img = (d, f) => `data:image/png;base64,${fs.readFileSync(path.join(here, d, f)).toString('base64')}`;
const cell = (d, f, w, bg) => `<td style="background:${bg};text-align:center"><img src="${img(d,f)}" style="width:${w}px;height:auto;image-rendering:${w<64?'pixelated':'auto'}"></td>`;
const rows = dirs.map(([d,t]) => `<tr><th style="text-align:left;padding:8px 14px;font:600 20px -apple-system,sans-serif;width:230px">${t}</th>
${cell(d,'preview-512-dark.png',300,'#0e1014')}${cell(d,'preview-512-light.png',300,'#f5f1ea')}
${cell(d,'preview-32-light.png',64,'#f5f1ea')}${cell(d,'preview-16-light.png',48,'#f5f1ea')}
${cell(d,'tray-22-light.png',200,'#f5f1ea')}${cell(d,'tray-22-dark.png',200,'#1c1c1e')}</tr>`).join('');
const head = `<tr><th></th><th>512 · dark</th><th>512 · light</th><th>32 (×2)</th><th>16 (×3)</th><th>tray · light</th><th>tray · dark</th></tr>`;
const html = `<html><body style="margin:0;background:#888;padding:16px"><table style="border-collapse:separate;border-spacing:10px;background:#888;font:14px -apple-system,sans-serif;color:#111">${head}${rows}</table></body></html>`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 1500 }, deviceScaleFactor: 1 });
await p.setContent(html); const t = await p.$('table'); await t.screenshot({ path: path.join(here, 'options.png') }); await b.close();
console.log('wrote design/icon/options.png');
