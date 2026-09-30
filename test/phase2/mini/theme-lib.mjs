// Shared by the mini-theme suite (test/phase2/mini/theme.mjs), the themes coverage walk (test/phase2/themes/run.mjs,
// state "mini") and tools/themes/shoot.mjs (--only mini): a fake bus `state` so app/mini.html renders every control
// without the main window, and the popover's layout check.
import { THEMES } from '../../../app/js/shared/themes.js';

export const MINI_W = 320;
export const MINI_H = 440;

export const FAKE_MODES = Object.freeze([
  { id: 'factory:sunday-pad-piano', name: 'Sunday Pad + Piano', key: 'D', index: 0 },
  { id: 'fake:warm-strings', name: 'Warm Strings', key: 'G', index: 1 },
  { id: 'fake:ambient-keys', name: 'Ambient Keys (long name that has to ellipsize)', key: 'A', index: 2 },
  { id: 'fake:bright-rhodes', name: 'Bright Rhodes', key: 'E', index: 3 },
  { id: 'fake:choir', name: 'Choir Swell', key: 'B♭', index: 4 },
  { id: 'fake:organ', name: 'Organ', key: 'F', index: 5 },
]);

/**
 * A valid bus `state` (docs/menubar-mode.md contract v1).
 * @param {object} [over] fields to override; `nModes` picks how many of FAKE_MODES (default 4)
 * @returns {object}
 */
export function fakeState(over = {}) {
  const { nModes = 4, ...rest } = over;
  return {
    v: 1,
    current: { id: FAKE_MODES[0].id, name: FAKE_MODES[0].name, key: 'D' },
    modes: FAKE_MODES.slice(0, nModes),
    master: 0.5,
    masterDb: -6.02,
    droneOn: true,
    droneKey: 'D',
    audio: 'running',
    latencyMs: 12,
    midi: { connected: true, name: 'Keystation 49es' },
    lowResource: false,
    recording: false,
    windowVisible: true,
    memoryMB: 417,
    ...rest,
  };
}

/**
 * Post a state to the page's popover over the browser transport (BroadcastChannel 'rig-bus' delivers to every
 * other channel object of the origin, the page's own included).
 * @param {import('playwright').Page} page
 * @param {object} state
 */
export async function postState(page, state) {
  await page.evaluate((s) => {
    window.__fakeBus = window.__fakeBus || new BroadcastChannel('rig-bus');
    window.__fakeBus.postMessage(s);
  }, state);
}

/**
 * Open app/mini.html at 320×440 in `context`, feed it `state` (unless null) and wait until it is live and its fonts
 * are in.
 * @param {import('playwright').BrowserContext} context
 * @param {string} origin
 * @param {{state?:object|null, before?:(page) => Promise<void>, onPage?:(page) => void}} [o]
 * @returns {Promise<import('playwright').Page>}
 */
export async function openMini(context, origin, o = {}) {
  const page = await context.newPage();
  o.onPage?.(page);
  await page.setViewportSize({ width: MINI_W, height: MINI_H });
  await o.before?.(page);
  await page.goto(`${origin}/mini.html`);
  await page.waitForFunction(() => !!window.__mini, null, { timeout: 30000, polling: 50 });
  const state = o.state === undefined ? fakeState() : o.state;
  if (state) {
    await postState(page, state);
    await page.waitForFunction(() => document.getElementById('mini').dataset.state === 'live', null,
      { timeout: 15000, polling: 50 });
  }
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * Every visible element of the popover inside the viewport; buttons ≥ 44 px (the sheet's Done: 36); no scroll.
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} problems
 */
export function miniLayoutProblems(page) {
  return page.evaluate(({ W, H }) => {
    const out = [];
    const de = document.documentElement;
    if (de.scrollWidth > W || de.scrollHeight > H) out.push(`document scrolls ${de.scrollWidth}×${de.scrollHeight}`);
    const live = document.querySelector('.mini-live');
    if (live.scrollHeight > live.clientHeight + 1) out.push(`.mini-live overflows ${live.scrollHeight} > ${live.clientHeight}`);
    for (const e of document.querySelectorAll('.mini-live *')) {
      if (!e.getClientRects().length || e.closest('[hidden]')) continue;
      const r = e.getBoundingClientRect();
      if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) {
        out.push(`${e.className?.baseVal ?? e.className ?? e.tagName} outside (${r.left},${r.top},${r.right},${r.bottom})`);
      }
    }
    for (const b of document.querySelectorAll('.mini-live button, .mini-live [role="slider"]')) {
      if (!b.getClientRects().length || b.closest('[hidden]') || b.classList.contains('sheet-done')) continue;
      const r = b.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) out.push(`target ${b.dataset.testid || b.className} ${r.width}×${r.height}`);
    }
    for (const n of document.querySelectorAll('.m-name')) {
      if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).textOverflow !== 'ellipsis') {
        out.push(`${n.textContent} clipped without ellipsis`);
      }
    }
    return out;
  }, { W: MINI_W, H: MINI_H });
}

/**
 * The popover states a theme may style, for the themes suite's selector coverage (test/phase2/themes/run.mjs walks
 * them as state "mini"): waiting · live (4 modes, drone on) · 6 modes + Rec/Eco/low-resource on + stalled audio ·
 * the drone key sheet. It runs in its OWN context (the mirror set to `id` before load, as boot.js reads it), so the
 * app page of the caller's context can't answer its hello with a real state. `collect(label, page)` runs the
 * selector check in the popover page.
 * @param {{browser:import('playwright').Browser, origin:string, id:string,
 *   collect:(label:string, page:import('playwright').Page) => Promise<void>, onPage?:(page) => void}} o
 */
export async function walkMini({ browser, origin, id, collect, onPage }) {
  const context = await browser.newContext({ viewport: { width: MINI_W, height: MINI_H }, deviceScaleFactor: 1 });
  await context.addInitScript((tid) => {
    try {
      localStorage.setItem('worship-rig.theme', tid);
    } catch {
      /* storage blocked */
    }
  }, id);
  const page = await openMini(context, origin, { state: null, onPage });
  try {
    await collect(`${id}:mini-waiting`, page);
    await postState(page, fakeState());
    await page.waitForFunction(() => document.getElementById('mini').dataset.state === 'live', null, { timeout: 15000 });
    await collect(`${id}:mini`, page);
    await postState(page, fakeState({ nModes: 6, recording: true, lowResource: true, droneOn: false, audio: 'stalled',
      current: { id: FAKE_MODES[4].id, name: FAKE_MODES[4].name, key: 'B♭' } }));
    await page.waitForFunction(() => document.querySelector('.modes.two-col .mode.current'), null, { timeout: 15000 });
    await collect(`${id}:mini-6-flags`, page);
    await page.click('[data-testid="mini-drone-keys"]');
    await collect(`${id}:mini-drone-keys`, page);
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------------------------------------ theme probes
/** Theme state as the popover shows it. */
export const shown = (page) => page.evaluate(() => {
  const html = document.documentElement;
  const sheets = [...document.querySelectorAll('link[rel=stylesheet]')]
    .filter((l) => /\/themes\//.test(l.getAttribute('href') || '') && l.media !== 'not all').map((l) => l.getAttribute('href'));
  const cs = getComputedStyle(document.querySelector('.mini-frame'));
  return { theme: html.dataset.theme, mode: html.dataset.mode, scheme: html.style.colorScheme,
    body: document.body.dataset.theme, sheets, bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius };
});
/** Start recording, every animation frame, the card background + html theme + enabled theme sheets. */
export const startSampler = (page, cssOf = CSS_OF) => page.evaluate((map) => {
  const out = (window.__themeFrames = []);
  const frame = document.querySelector('.mini-frame');
  const tick = () => {
    if (window.__themeFramesStop) return;
    const html = document.documentElement;
    const sheets = [...document.querySelectorAll('link[rel=stylesheet]')]
      .filter((l) => /\/themes\//.test(l.getAttribute('href') || '') && l.media !== 'not all' && !l.disabled)
      .map((l) => l.getAttribute('href'));
    out.push({ t: Date.now(), theme: html.dataset.theme, bg: getComputedStyle(frame).backgroundColor, sheets,
      want: map[html.dataset.theme] ?? null });
    requestAnimationFrame(tick);
  };
  window.__themeFramesStop = false;
  requestAnimationFrame(tick);
}, cssOf);
export const stopSampler = (page) => page.evaluate(() => {
  window.__themeFramesStop = true;
  return window.__themeFrames;
});
export const CSS_OF = Object.fromEntries(THEMES.map((t) => [t.id, t.css]));
/** Frames where the card is see-through, or the enabled sheet doesn't match html[data-theme]. */
export function badFrames(frames) {
  const opaque = (c) => !/rgba\(.*,\s*0(\.\d+)?\)$/.test(c) && c !== 'transparent';
  return frames.filter((f) => !opaque(f.bg) || (f.want ? !(f.sheets.length === 1 && f.sheets[0] === f.want) : f.sheets.length !== 0));
}
