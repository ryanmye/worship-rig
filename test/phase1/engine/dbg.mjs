// dev helper: node dbg.mjs file.js  → evaluates the module's default export in the harness page
import { chromium } from 'playwright';
import { startServer } from './server.mjs';
import fs from 'node:fs';
const server = await startServer(0);
const port = server.address().port;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://127.0.0.1:${port}/__tests/harness.html`);
await page.waitForFunction(() => window.__ready === true);
const code = fs.readFileSync(process.argv[2], 'utf8');
const r = await page.evaluate(code);
console.log(JSON.stringify(r, null, 1));
await browser.close(); server.close();
