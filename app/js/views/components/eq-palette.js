// EQ canvas palette (v11-polish, BACKLOG A "EQ canvas theming"; theme-sanctuary / theme-nave / theme-ember /
// theme-studio deferred items, daylight-v2 concept §6 #5). eq-keyboard.js used to paint its plot, grid and key strip
// in fixed Classic slate/orange in every theme. Every colour it paints is now a CSS token on `.eqk` / `.eqk-mini`
// (eq-keyboard.css): Classic's literals as the base, derived from the page theme's tokens otherwise. A canvas cannot
// read `light-dark()`, `color-mix()` or `var()`, so each token is resolved through a hidden probe element's computed
// `color` and then through a 1×1 canvas into plain [r, g, b, a].

/** role → [css custom property, Classic literal (the fallback when the token is missing)] */
export const EQ_ROLES = Object.freeze({
  plot: ['--eqk-bg', '#0f1216'],
  plotOut: ['--eqk-plot-out', '#12151a'],
  hatch: ['--eqk-hatch', '#1a1d22'],
  hatchLine: ['--eqk-hatch-line', '#262a31'],
  over: ['--eqk-over', 'rgba(255,255,255,0.035)'],
  grid: ['--eqk-grid', '#1f242b'],
  gridHz: ['--eqk-grid-hz', '#2a3038'],
  zero: ['--eqk-zero', '#3a414d'],
  label: ['--eqk-label', '#6b7380'],
  label0: ['--eqk-label-0', '#a3acb8'],
  zone: ['--eqk-zone', '#8a93a0'],
  zoneOver: ['--eqk-zone-over', '#9aa3ae'],
  pre: ['--eqk-pre', 'rgba(215,220,227,.55)'],
  grey: ['--eqk-grey', '#a3acb8'],
  grey2: ['--eqk-grey-2', '#c9d0d8'],
  curve: ['--eqk-curve', '#ffffff'],
  cut: ['--eqk-cut', '#7cc4ff'],
  cutInk: ['--eqk-cut-ink', '#08131f'],
  node: ['--eqk-node', '#15181d'],
  off: ['--eqk-off', '#6b7380'],
  offText: ['--eqk-off-text', '#8a93a0'],
  danger: ['--eqk-danger', '#ff4d4f'],
  dangerInk: ['--eqk-danger-ink', '#ffffff'],
  tagDel: ['--eqk-tag-del', '#5a0d10'],
  tagDelInk: ['--eqk-tag-del-ink', '#ffc9ca'],
  tagOver: ['--eqk-tag-over', '#3a3f48'],
  tagOverInk: ['--eqk-tag-over-ink', '#e6e9ee'],
  tagNone: ['--eqk-tag-none', '#4a2326'],
  tagNoneInk: ['--eqk-tag-none-ink', '#ffc9ca'],
  tagOff: ['--eqk-tag-off', '#2a2f37'],
  tagOffInk: ['--eqk-tag-off-ink', '#a3acb8'],
  ruler: ['--eqk-ruler', '#0b0d10'],
  rulerLine: ['--eqk-ruler-line', '#2d333d'],
  tick: ['--eqk-tick', '#3a414d'],
  a440: ['--eqk-a440', '#ffc94d'],
  hoverLine: ['--eqk-hover', 'rgba(241,244,248,.35)'],
  keysBg: ['--eqk-keys-bg', '#0b0d10'],
  range: ['--eqk-range', '#1c2027'],
  air1: ['--eqk-air-1', '#1b1f25'],
  air2: ['--eqk-air-2', '#101317'],
  keyWhite: ['--eqk-key-white', '#b4bcc6'],
  keyWhiteOff: ['--eqk-key-white-off', '#3a3f47'],
  keyBlack: ['--eqk-key-black', '#1b1e23'],
  keyBlackOff: ['--eqk-key-black-off', '#23272e'],
  keyPress: ['--eqk-key-press', '#ffc94d'],
  keyPressBlack: ['--eqk-key-press-black', '#c79a1c'],
  keyHatchWhite: ['--eqk-key-hatch-white', '#454b54'],
  keyHatchBlack: ['--eqk-key-hatch-black', '#2c3139'],
  keyHatchOn: ['--eqk-key-hatch-on', 'rgba(35,39,46,.35)'],
  keySep: ['--eqk-key-sep', '#0b0d10'],
  keyLabel: ['--eqk-key-label', '#23272e'],
  keyLabelOff: ['--eqk-key-label-off', '#8a93a0'],
  bracket: ['--eqk-bracket', '#ffffff'],
  miniOut: ['--eqk-mini-out', 'rgba(58,63,71,.55)'],
  miniLine: ['--eqk-mini-line', 'rgba(163,172,184,.35)'],
});

/** Classic's slot colours and the ink on them: the fallbacks of `--slot-N` / `--ink-on-lamp`. */
export const SLOT_HEX = Object.freeze(['#ff8a3d', '#3ddc84', '#4aa8ff', '#b784ff']);
export const SLOT_INK = Object.freeze(['#1f0e00', '#002010', '#001a33', '#1a0a33']);

const cache = new Map();
let cv = null;
/**
 * Any CSS colour a canvas can parse → [r, g, b, a] (a in 0…1). Unparseable → null.
 * @param {string} css
 * @returns {number[]|null}
 */
export function toRGBA(css) {
  if (cache.has(css)) return cache.get(css);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = cv.height = 1;
  }
  const c = cv.getContext('2d', { willReadFrequently: true });
  let out = null;
  // a string the canvas can't parse leaves fillStyle unchanged: test with two different sentinels
  c.fillStyle = '#010203';
  c.fillStyle = css;
  const a = c.fillStyle;
  c.fillStyle = '#030201';
  c.fillStyle = css;
  if (a === c.fillStyle) {
    c.clearRect(0, 0, 1, 1);
    c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data;
    out = [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
  }
  if (cache.size > 400) cache.clear();
  cache.set(css, out);
  return out;
}

/**
 * A palette colour as a canvas string, its alpha scaled by `mul`.
 * @param {number[]} c [r, g, b, a]
 * @param {number} [mul]
 * @returns {string}
 */
export function rgba(c, mul = 1) {
  return `rgba(${c[0]},${c[1]},${c[2]},${Math.round(c[3] * mul * 1000) / 1000})`;
}

/**
 * Resolve every EQ_ROLES token (plus the slot colour `col` and its ink `ink`) on `host` (.eqk or .eqk-mini).
 * @param {Element} host
 * @param {number} slotIndex
 * @returns {Record<string, number[]>}
 */
export function readEqPalette(host, slotIndex) {
  const probe = document.createElement('i');
  probe.hidden = true;
  probe.setAttribute('aria-hidden', 'true');
  host.append(probe);
  const cs = getComputedStyle(probe);
  const out = {};
  const read = (value, fallback) => {
    probe.style.color = fallback;
    probe.style.color = value;
    return toRGBA(cs.color) || toRGBA(fallback);
  };
  for (const [role, [prop, fb]] of Object.entries(EQ_ROLES)) out[role] = read(`var(${prop}, ${fb})`, fb);
  const i = Number(slotIndex) || 0;
  out.col = read(`var(--slot-${i}, ${SLOT_HEX[i] || SLOT_HEX[0]})`, SLOT_HEX[i] || SLOT_HEX[0]);
  out.ink = read(`var(--ink-on-lamp, ${SLOT_INK[i] || SLOT_INK[0]})`, SLOT_INK[i] || SLOT_INK[0]);
  probe.remove();
  return out;
}

const themeListeners = new Set();
let themeObserver = null;
/**
 * Call `cb` when the page theme (html data-theme / data-mode) changes.
 * @param {() => void} cb
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(cb) {
  themeListeners.add(cb);
  if (!themeObserver && typeof MutationObserver === 'function') {
    themeObserver = new MutationObserver(() => {
      for (const fn of [...themeListeners]) fn();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
  }
  return () => {
    themeListeners.delete(cb);
    if (!themeListeners.size && themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
  };
}
