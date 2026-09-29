# Themes

Ryan's decision (2026-09-28): every warmth direction ships as a selectable theme in Settings › Appearance. The
backend, the DOM and the behaviour are the same for all of them. A theme is **CSS only**: one `theme.css`, its own
images, and fonts from the shared `/fonts/`.

## Registry

`app/js/shared/themes.js` holds the only list. `app/themes/boot.js` keeps a copy of `id → {css, mode, body}`, and
`test/unit/shared/themes.test.mjs` fails when the two drift apart. Entries are keyed by css path, so renaming a
folder means changing one string in each file.

| id | name | mode | file | notes |
|---|---|---|---|---|
| `classic` | Classic | dark | none | today's look (styles.css alone); the rollback |
| `sanctuary` | Sanctuary | dark | `/themes/sanctuary-v2/theme.css` | **default** (`DEFAULT_THEME_ID`) |
| `sanctuary-day` | Sanctuary Day | light | `/themes/sanctuary-v2/theme.css` | `coming: true` (hidden) until the light-dark() sibling lands |
| `daylight-stage` | Daylight Stage | dark | `/themes/daylight-v2/theme.css` | body `data-mode="dusk"` |
| `daylight-day` | Daylight Day | light | `/themes/daylight-v2/theme.css` | body `data-mode="day"` |
| `studio` | Studio | dark | `/themes/studio/theme.css` | |
| `ember` | Ember | dark | `/themes/ember/theme.css` | |
| `nave` | Nave | dark | `/themes/sanctuary/theme.css` | the v1 Sanctuary |

`app/themes/daylight/` (v1) is not registered. It stays on disk until someone deletes it.

Each registry entry also carries `swatch: {bg, panel, text, accent}`, which is what the picker's colour strip shows.
The values are copied by hand from the theme's tokens. **If you change those tokens, update the swatch.**

## How a theme is applied

1. **Boot, before first paint.** `index.html` and `mini.html` include `/themes/boot.js` twice: as the first script in
   `<head>`, and as the last element of `<head>`.
   - The first include reads `localStorage['worship-rig.theme']`, which mirrors `settings.theme`. It validates the
     id against its map (unknown or blocked storage means `sanctuary`). It then sets `html[data-theme]`,
     `html[data-mode]` and `html.style.colorScheme`, starts a `rel=preload` of the sheet, and sets
     `body[data-theme]`/`[data-mode]` as soon as `<body>` exists.
   - The second include appends `<link rel=stylesheet id=theme-css blocking=render>` after the app's CSS. The sheet
     has to come after the app's CSS because theme rules have zero specificity and win on source order.
2. **Runtime.** `applyTheme(id)` in `app/js/main.js` runs from a store subscription on `settings.theme`. It also
   runs once at boot, where the store wins over the mirror. It writes the mirror, then adds the new sheet at the end
   of `<head>` with `media="not all"`. Once the sheet has loaded, it adds the sheet's `@font-face` files to
   `document.fonts`, enables the new sheet, removes the old one and flips the attributes, all in one task. The page
   therefore shows the old theme or the new one, never an unstyled frame. Siblings that share a file (Daylight
   Stage and Day) only flip attributes.
3. **Picking.** Settings › Appearance › Theme is a radiogroup of swatch cards that writes `settings.theme`. Quick ›
   This Mac has a compact "Theme: <name> ▸" button that opens Settings › Appearance. Entries marked `coming` are
   hidden in the picker, but they are still valid in the store.

`settings.theme` is optional. When it is absent, the default applies. An unknown id falls back to the default and
never throws. There is no SCHEMA bump. Picking a theme does not mark the library as edited.

## The contract (every theme file)

1. **One convention: `html[data-theme]`.** Going forward, every rule sits inside
   `:where(html[data-theme="<id>"]) { … }`. For a file that serves two ids, use
   `:where(html:is([data-theme="a"], [data-theme="b"]))`. `html[data-mode]` is `light` or `dark`.
   - *Transition:* today's files still guard on `body[data-theme="<folder>"]`. Daylight also uses
     `body[data-mode="day"|"dusk"]`. So boot.js and applyTheme currently write the registry's legacy `body` values
     (`{theme, mode}`) on `<body>`, and the canonical id and mode on `<html>`.
   - When you move your file to the html guard, delete its `body` entry from `themes.js` **and** `boot.js` (the sync
     test checks both). `<body>` then gets the canonical values too. Once every theme has moved, the shim goes.
2. **No unguarded branch.** No `body:not([data-theme])` or other always-on selector (OPTIONS.md §3.1 #8). The page
   always has a `data-theme`, so that branch is dead in the app and only makes injected previews lie.
3. **No infinite animations** and **no `backdrop-filter`**. Motion runs at rest only, stops under Lock and under
   `prefers-reduced-motion`, and is opacity/transform only.
4. **Assets are root-absolute** (`/themes/<dir>/x.svg`), so the file works linked or inlined.
5. **Light and dark** use `light-dark()` tokens plus `color-scheme`, driven by `data-mode`, which boot sets. Use no
   media query on the OS appearance: the default is decided by the registry entry, not the Mac.
6. **Fonts come from `/fonts/`** (`app/fonts/`, woff2 plus the OFL text, listed in `LICENSES.md`). If two themes use
   the same file name, it must be the same file. Don't add a font without its OFL text and a LICENSES.md line.
7. **Size ≤ 250 KB per theme.** That counts the theme folder plus the `/fonts/` files it names, and a unit test
   enforces it. Today: Sanctuary 119 KB, Daylight v2 165 KB, Studio 90 KB, Ember 98 KB, Nave 122 KB.
8. **One mark.** The logo is `app/assets/mark.svg` (the Sanctuary v2 lancet) in every theme. It is used by the top
   bar, the start overlay, the mini panel and the favicons. **Themes must not override the mark or the wordmark
   glyph.** That means no `content: url(...)` on `.tb-logo` or `.overlay-card img`, and no swapped `.tb-name` text.
   Colour through `currentColor` is fine, and so is the wordmark's font.
9. **Must pass:** `node test/phase2/themes/run.mjs` (boot, switch, picker, coverage) and the contrast audit in
   `node tools/themes/shoot.mjs --theme <id>`, with 0 fails at 1440×900.

## Selector coverage

`test/phase2/themes/run.mjs` parses each theme file and checks its selectors against the DOM. It resolves nesting,
drops pseudo-elements, and ignores `:hover`/`:focus…`. The DOM is visited across these states: Perform (idle,
notes held, locked), a toast, Quick, Edit (notes held; Advanced › Tone with the EQ) and Settings.

The check **fails** in two cases: more than 5 % of selectors match nothing, or any selector names a class that no
longer exists anywhere in `app/` outside `app/themes/`. The per-theme list is written to
`test/phase2/themes/coverage-<id>.json`, with each selector's line, its nesting context and a `dead` flag. The
dead-class list is the one to clear first. It is mostly start-screen mock hooks such as `.sanct-before`, `.dl-today`,
`.studio-session` and `.ember-welcome`.

## Per-theme agent checklist

1. Remove your mark overrides: `.tb-logo { content: … }` and `.overlay-card img { content: … }`. Delete your
   `mark.svg` if nothing else uses it.
2. Remove the unguarded `body:not([data-theme])` branch. Move the guard to
   `:where(html[data-theme="<your id>"])` and drop your `body` shim in `themes.js` and `boot.js`.
3. Apply your critics' must-fixes from `design/warmth/OPTIONS.md` (for Daylight, §3.1) and from the warmth journal.
   For Sanctuary, add the `sanctuary-day` light-dark() sibling, set real swatch values, and remove `coming`.
4. Clear your `coverage-<id>.json`: first the dead classes, then unmatched selectors down to ≤ 5 %.
5. Shoot: run `node tools/themes/shoot.mjs --theme <id>` to get perform, quick, edit and edit-tone-eq screenshots
   plus the audit JSON. Get 0 contrast fails, and attach the screenshots to your report.
6. Keep the folder ≤ 250 KB, use `/fonts/` for fonts, and never add infinite animation or `backdrop-filter`.
