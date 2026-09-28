// Build the angle-D mockups and screenshot them.  node design/D/src/build.mjs [--no-shots]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performPage } from './perform.mjs';
import { editPage } from './edit.mjs';

const out = fileURLToPath(new URL('..', import.meta.url));
const files = {
  'perform.html': performPage(),
  'quick-settings.html': performPage({ open: 0 }),
  'quick-output.html': performPage({ output: true }),
  'edit.html': editPage({ sel: 'keys' }),
  'edit-space.html': editPage({ sel: 'space' }),
};
for (const [name, html] of Object.entries(files)) writeFileSync(out + name, html);

if (!process.argv.includes('--no-shots')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shots = [
    ['perform.html', 'perform.png', 1440, 900], ['perform.html', 'perform-1024.png', 1024, 700],
    ['quick-settings.html', 'quick.png', 1440, 900], ['quick-settings.html', 'quick-1024.png', 1024, 700],
    ['quick-output.html', 'quick-output.png', 1440, 900],
    ['edit.html', 'edit.png', 1440, 900], ['edit-space.html', 'edit-space.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
  ];
  for (const [src, png, w, h] of shots) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('file://' + out + src);
    await page.screenshot({ path: out + png });
  }
  await browser.close();
  console.log('shots done');
}
