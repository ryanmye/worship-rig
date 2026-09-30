// Theme registry (themes-setup; design/warmth/OPTIONS.md §5, Ryan 2026-09-28: every warmth direction ships as a
// selectable theme, same backend, CSS only per theme). Pure: no DOM. The ONE place the theme list lives; the boot
// script (app/themes/boot.js, a classic script that cannot import) carries a copy of { id → css, mode, body } that
// test/unit/shared/themes.test.mjs keeps in sync with this file.
//
// Keyed by css path: a theme agent that renames its folder changes one `css` string here and one in boot.js.
// `body` is the TRANSITION shim: today's theme files still guard on body[data-theme="<their folder>"] (and Daylight
// on body[data-mode="day"|"dusk"]). boot.js / applyTheme write these legacy values on <body> and the canonical
// id / mode on <html>. When a theme's agent moves its guard to :where(html[data-theme="<id>"]) (app/themes/README.md)
// it deletes its `body` entry in both files; <body> then gets the canonical values too.

/** @typedef {{theme:string, mode:string}} BodyShim */
/**
 * @typedef {object} ThemeDef
 * @property {string} id            stable id stored in settings.theme and on html[data-theme]
 * @property {string} name          display name (Settings › Appearance, Quick › This Mac)
 * @property {'light'|'dark'} mode  html[data-mode] and color-scheme
 * @property {string|null} css      root-absolute path of the theme file, null = no theme file (Classic)
 * @property {string} family        light/dark siblings share a family
 * @property {{bg:string, panel:string, text:string, accent:string}} swatch  hand-copied from the theme's tokens
 * @property {BodyShim} [body]      legacy <body> attributes while the file still guards on body (see above)
 * @property {boolean} [coming]     registered but not ready: valid in the store, hidden in pickers
 */

/** @type {ReadonlyArray<Readonly<ThemeDef>>} */
export const THEMES = Object.freeze([
  {
    id: 'classic', name: 'Classic', mode: 'dark', css: null, family: 'classic',
    swatch: { bg: '#0b0d10', panel: '#15181d', text: '#f1f4f8', accent: '#ffc94d' }, // styles.css :root
  },
  {
    // theme-sanctuary: html guard (no body shim); swatch = the light-dark() night branch of theme.css
    id: 'sanctuary', name: 'Sanctuary', mode: 'dark', css: '/themes/sanctuary-v2/theme.css', family: 'sanctuary',
    swatch: { bg: '#160913', panel: '#21111c', text: '#f5ecd8', accent: '#e6ba65' },
  },
  {
    // theme-sanctuary: the light-dark() day branch of the same file (chapel morning: stone paper, plum ink, brass)
    id: 'sanctuary-day', name: 'Sanctuary Day', mode: 'light', css: '/themes/sanctuary-v2/theme.css',
    family: 'sanctuary',
    swatch: { bg: '#efe9de', panel: '#f9f5ee', text: '#32162b', accent: '#875806' },
  },
  {
    id: 'daylight-stage', name: 'Daylight Stage', mode: 'dark', css: '/themes/daylight-v2/theme.css',
    family: 'daylight',
    swatch: { bg: '#1b1611', panel: '#261f19', text: '#f5ede0', accent: '#f6c35a' }, // light-dark() dusk branch
  },
  {
    id: 'daylight-day', name: 'Daylight Day', mode: 'light', css: '/themes/daylight-v2/theme.css',
    family: 'daylight',
    swatch: { bg: '#f3efe7', panel: '#fdfbf7', text: '#27211b', accent: '#f4b73f' }, // light-dark() day branch
  },
  {
    id: 'studio', name: 'Studio', mode: 'dark', css: '/themes/studio/theme.css', family: 'studio',
    swatch: { bg: '#181613', panel: '#221f1c', text: '#f4f0e6', accent: '#f7c367' }, // theme.css &:root tokens
  },
  {
    id: 'ember', name: 'Ember', mode: 'dark', css: '/themes/ember/theme.css', family: 'ember',
    swatch: { bg: '#150e0b', panel: '#1e1713', text: '#f7efe3', accent: '#f7b755' }, // html guard since theme-ember
  },
  {
    // v1 Sanctuary (ink-navy nave), kept as its own look; guards on html[data-theme="nave"] (theme-nave), no body shim
    id: 'nave', name: 'Nave', mode: 'dark', css: '/themes/sanctuary/theme.css', family: 'nave',
    swatch: { bg: '#0a0c1e', panel: '#131529', text: '#f5ecd8', accent: '#e6ba65' },
  },
].map((t) => Object.freeze({
  ...t, swatch: Object.freeze(t.swatch), ...(t.body ? { body: Object.freeze(t.body) } : {}),
})));

/** Theme used when settings.theme is absent or unknown. */
export const DEFAULT_THEME_ID = 'sanctuary'; // Ryan's decision (themes-final); boot.js DEF mirrors it
/** localStorage key of the boot mirror of settings.theme (boot.js reads it before first paint). */
export const THEME_MIRROR_KEY = 'worship-rig.theme';

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/**
 * @param {unknown} id
 * @returns {Readonly<ThemeDef>|null} the registered theme, or null
 */
export function byId(id) {
  return typeof id === 'string' ? BY_ID.get(id) || null : null;
}

/**
 * @param {unknown} id
 * @returns {boolean} id names a registered theme (coming ones included: they are valid, only hidden)
 */
export function isValidId(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/**
 * @param {unknown} id settings.theme as stored (absent / unknown allowed)
 * @returns {string} a registered id: `id` itself, else DEFAULT_THEME_ID
 */
export function resolveThemeId(id) {
  return isValidId(id) ? /** @type {string} */ (id) : DEFAULT_THEME_ID;
}

/** @returns {Array<Readonly<ThemeDef>>} the themes a picker offers (coming ones hidden) */
export function pickableThemes() {
  return THEMES.filter((t) => !t.coming);
}

/**
 * The attributes a theme puts on the page (boot.js computes the same from its own copy of the map).
 * @param {string} id a registered id
 * @returns {{html:{theme:string, mode:string}, body:{theme:string, mode:string}, colorScheme:string, css:string|null}}
 */
export function themeAttrs(id) {
  const t = byId(id) || byId(DEFAULT_THEME_ID);
  const body = t.body || { theme: t.id, mode: t.mode };
  return { html: { theme: t.id, mode: t.mode }, body: { ...body }, colorScheme: t.mode, css: t.css };
}
