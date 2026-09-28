# H-v2 Edit: module contract (hv2-edit-setup)

> **Status (hv2-edit-integrate, 2026-09-28):** integrated. `main.js` mounts `views/edit/shell.js`; `views/edit.js`
> and the ui-edit suite are gone (Settings' tests moved to `test/phase2/settings/`). The build rules below were for
> the parallel panel build and no longer restrict anyone (CLAUDE.md "File ownership no longer applies"); the API,
> selection model, DOM/CSS conventions and the harness still hold. Integration changes: §1 map, §3.2 `toast` opts,
> §3.4 binder `rels` + `destroy()`, §4 CSS order, §7 budgets, §8.

This is the build contract for the new Edit view (design/H-v2: `concept.md` §1(1), §3; `implementation.md` "Edit
half"; mockups `edit.png`, `edit-1024.png`, `edit-wiring.png`, `edit-effects.png`, and `edit.html` for CSS). Six
agents build the panels in parallel. The shell, the shared lib, the harness and this file are already in place and
tested (`node test/phase2/edit-v2/run.mjs`: 9 files / 25 tests pass with the stubs).

**Rules for every build agent**
- Edit **only** the files your row of the ownership table (§6) lists.
- If you need something in `shell.js`, `lib.js`, `styles-edit-v2.css`, the harness or another panel, write a private
  copy in your own file and name it in your final report. The integrator will lift it.
- Scope limits:
  - No new store fields, no new PARAMS rows, no engine code, and no `controller.js` changes (implementation.md "rules").
  - Do not touch `perform.js`, `main.js`, `components/*`, `styles.css`, `edit.js`, `settings.js` or `index.html`.
    Another agent owns Perform and the components, and the integrator owns the rest.
- The old `views/edit.js` stays mounted by the app until integration. Its ui-edit suite (94 tests) must keep passing.
  Your job is to make every behaviour in your checklist (§6) exist and be tested in the new panel.

---

## 1. Module map

```
app/js/views/edit/
  shell.js              mountEdit(el, ctx), mountSinglePanel(el, ctx, id, opts), registerPanel(id, def), EditState
  lib.js                shared helpers: h, icon, iconButton, sentence, createBinder, section, wordSlider, BLOCKS,
                        relOf, droneKeyText, chorusWord, TARGET_LABELS, BEND_LABELS, …
  styles-edit-v2.css    linked from index.html; only @imports: base.css first, then panels/*.css (§4)
  base.css              tokens, layout, tabs, wiring, panel frame, shared widgets
  CONTRACT.md           this file
  panels/index.js       the registered list (integrator-owned)
  panels/slot.js   + slot.css          block 'slot:0'..'slot:3'   (sound panel; Advanced › Tone = ctx.C.eqKeyboard)
  panels/drone.js  + drone.css         block 'drone'
  panels/effects.js + effects.css      block 'effects'
  panels/master.js + master.css        block 'master'             (incl. Wheels & pedal)
  panels/song.js   (+ song-header.css) block 'song'               (Easy Transpose, tempo, notes)
  panels/song-header.js + song-header.css   region 'head'
  panels/setlist.js + setlist.css      region 'left'
  panels/bottom.js + bottom.css        region 'bottom'
test/phase2/edit-v2/
  harness.html · harness.mjs · run.mjs · shell.test.mjs · panels/<id>.test.mjs (one per panel module)
```

### Placement decisions (the brief asked for these to be settled and written down)

| What | Where | Why |
|---|---|---|
| Master volume, Tape (lofi), Tone EQ (`fx.eq`), Glue (`fx.comp`) | **Master tab** (`panels/master.js`) | concept §1: "Master tab: H's Tape + Master panels" |
| Wheels & pedal (mod wheel / expression / volume-knob targets + ranges, pitch-bend mode + range, swell time) | **Master tab**, section `master-wheels` | The "Wheels & pedal" link in the rig bar calls `editState.select('master', {focus:'wheels'})`, and the panel opens and scrolls to that section. It needs no 8th tab, so it fits at 1024 (concept §4) |
| Easy Transpose (Play In / Hear In / Octave / Minor + readout), tempo field, Notes | **Song block** (`panels/song.js`, no tab) | The header chips select it: KEY → `{focus:'key'}`, BPM → `{focus:'tempo'}`, Notes → `{focus:'notes'}`. The header stays one line; the panel has room for the textarea |
| Tap tempo | Header BPM chip (Tap) **and** the song panel | Same helper (`lib.bpmFromTaps`) |
| Duplicate / Rename / Export song / Reset to factory… / Delete song… | Header "⋯ Song" menu (`song-header.js`) | concept §3 |
| Per-row rename / duplicate / remove / delete, reorder, search, factory + library browsers, library import/export | Setlist column (`setlist.js`) | These are today's left-column behaviours, and the tests cover them |
| Show wiring strip, tab summaries, tab changed dots | **Shell** | They are part of the rig map; a panel can override its tab text with `def.tab()` |

---

## 2. Selection model (`ctx.editState`, an `EventTarget`)

- **Blocks** (`lib.BLOCKS`, in tab order):
  - `slot:0` Keys, `slot:1` Pad, `slot:2` Extra, `slot:3` Bass. Panel `slot`, opts `{slot:i}`.
  - `drone`
  - `effects` and `master`. These are "shared" and styled neutral steel (`--fx`).
- `lib.SONG_BLOCK` is `song`. It has no tab.
- Each block carries `color` (sets `--c` on the rig card) and `prefixes` (song-relative paths for its changed dot).

| Member | Meaning |
|---|---|
| `selected` | block id; default `'slot:0'` (view-local, resets on remount) |
| `opts` | extra options of the last `select()`, e.g. `{focus:'wheels'}` |
| `select(id, opts?)` | select a block (false for unknown ids). Re-selecting with new opts re-dispatches |
| `wiring` / `setWiring(b)` | Show wiring (view memory only; concept §1 "rejected for now: a saved preference") |
| `drawer` / `setDrawer(b)` | ≤ 1250 px: the setlist column as a drawer ("☰ Songs") |
| `baseline` | the Revert snapshot of the current song (see §3.6) or null |
| `changes` | `Set` of song-relative changed paths (`shared/song-diff.js` `changedPaths`) |
| `isChanged(prefixes)` / `changeCount(prefixes?)` | helpers over `changes` |

Events (CustomEvent `detail`):
- `select {id, opts, prev}`
- `wiring {on}`
- `drawer {open}`
- `changes {paths}`: fires only when the set changes
- `notes {held:Set}`: held MIDI notes, from the controller's `notes`
- `instruments {list}`: `engine.listInstruments()` changed

**How a selection reaches your panel.** When the selected block maps to the same panel as the mounted one (for
example `slot:0` → `slot:2`, or `master` → `master {focus:'wheels'}`), the shell calls your instance's
`update(opts)` if you return one. Otherwise it destroys your panel and mounts the new one. You must handle
`opts.focus` in both `mount` and `update`: open the section, scroll it into view and focus its first control.

**Focus ids.** These are the values the shell and the other panels send:
- master: `'wheels'`, `'tape'`
- song: `'key'`, `'tempo'`, `'notes'`
- effects: `'reverb'`, `'delay'`, `'chorus'` (from the wiring lanes)
- slot: `'instrument'` (from an empty tab's "+ Add a sound"), `'range'`

---

## 3. Panel module API

### 3.1 Definition (default export of `panels/<file>.js`)

```js
export default {
  id: 'slot',                    // registry id (panels/index.js registers it)
  region: undefined,             // 'left' | 'head' | 'bottom' for region modules; omit for block panels
  icon: 'piano',                 // optional lib.ICON_PATHS name (your title tile)
  mount(el, ctx, opts) {         // el = your host (empty); returns an instance
    …
    return { destroy() {…}, update(opts) {…} /* optional */ };
  },
  tab(song, opts, { findInstrument, C }) {   // optional: override the shell's tab text
    return { name: 'Grand Piano', sub: '· sampled', off: false, empty: false };
  },
};
```

- `mount` must not throw. If it does, the shell shows "The <id> panel failed to load." and warns. It is not an error.
- In `destroy()`, remove only what you added. The shell already releases everything registered through `ctx`
  (subscriptions, listeners, Esc handlers, dialog flags, leave hooks, `cleanup()` callbacks) and then empties `el`.

### 3.2 ctx fields (the harness asserts every one of these; `CTX_FIELDS` in harness.mjs)

| Field | What |
|---|---|
| `store`, `controller`, `engine`, `midi`, `recorder`, `toast(msg, kind, opts?)`, `openSettings`, `app` | app services; `app` = the raw app ctx. `toast` passes `opts` (`{ms, action:{label, run}}`) to main.js's toast (hv2-edit-integrate) |
| `C` | component set: `views/components/index.js` (ui-core, incl. `onTile`, `stepChip`, `stepPanel`, `holdButton`, `fader`, `segmented`, `select`, `stepper`, `toggle`, `miniKeyboard`, `pianoKeyboard`, `meter`, `keyGrid`, `stageName`, `AMOUNT_STEPS`, `OCTAVE_STEPS`) merged over `_fallback-components.js`. **Use `ctx.C`; never import `components/*` directly** (another agent owns them). Feature-detect H-v2 pieces (`if (ctx.C.stepChip)`) because the fallback set lacks them |
| `editState` | §2 |
| `song()` / `songId()` | current song (frozen) / id |
| `set(addr, v)` | `store.set` passthrough → boolean (§3.3) |
| `valueOf(addr)` | current value for a §4 address or `song.<field>`, PARAMS default when the song lacks it |
| `subscribe(fn)` | store changes, pre-digested (§3.4) → unsub |
| `listen(target, type, fn, opts)` | addEventListener, auto-removed → unsub |
| `onLeaveSong(fn)` | runs **before** the shown song changes: flush debounced text, cancel drags, close song-specific menus |
| `onLeaveView(fn)` | runs when `settings.view` leaves `'edit'` (⌘E / Ctrl+E, no outside tap): close chip panels and menus. The shell also closes every overlay.js overlay inside the view (round3-edit M1) |
| `lastDroneSource` | `{get(), set(mode)}`: the drone source the ON tile last turned off, for the shown song; kept by the shell so a tab switch keeps it, cleared on a song change (round3-edit m4) |
| `onEscape(fn)` | Esc handler; return `true` when you closed something. Handlers run newest first; the first `true` stops the rest (§5) |
| `markDialog(open, token)` | `body[data-dialog-open]` while your inline confirm/menu is open (ux.md M1) |
| `songField(input, rel)` | arms a song-bound text field and returns `commit(v)`, which writes `songs.<id focused on>.<rel>` (round2-ui #3) |
| `fieldSongId(input)` | the song id that field writes to |
| `setTitle(parts, {sub?, icon?, actions?})` | the sentence title (§3.5); a no-op in region modules |
| `instruments()` / `findInstrument(ref)` | `engine.listInstruments()` cache (refreshed on engine `ready`/`instruments`, controller `instruments`/`user-samples`, window `rig-instruments-changed`) |
| `held()` | `Set` of held notes |
| `select(id, opts)` | `editState.select` shortcut |
| `cleanup(fn)` | extra teardown |
| `host` | your host element |

### 3.3 Reading and writing params (store grammar, `store.js` header)

- **§4 addresses → the current song:**
  - `slots.<i>.gain|pan|octave|transpose|lowNote|highNote|sustain|mono|velocityCurve|bendEnabled|sends.reverb|sends.delay|sends.chorus|width|eq.low|eq.high|params.<key>`
  - `fx.reverb.*`, `fx.delay.*`, `fx.chorus.*`, `fx.lofi.*`, `fx.eq.*`, `fx.comp.amount`
  - `master.volume`
  - `drone.gain|brightness|movement|width|fade`
- **`song.<field>` → the current song:**
  - `song.hearIn`, `song.playIn`, `song.transposeOctave`, `song.minor`, `song.tempo` (null clears), `song.name`,
    `song.notes`
  - `song.patch.modWheel.target|min|max`, `song.patch.expression.*`, `song.patch.volume.target`,
    `song.patch.bend.mode|range`, `song.patch.swell.seconds`
  - `song.drone.mode|chordFollow|continueAcrossSongs|minorUsesRelativeMajorFile`
- **Slot aliases:**
  - `slots.<i>`: `defaultSlot(i, ref)` creates the slot; `null` clears it (Remove this sound)
  - `slots.<i>.instrument`: changing it resets the instrument params
  - `slots.<i>.muted`
- **Song-bound text fields** use `songs.<id>.<rel>` through `ctx.songField`.
- **Library, setlists, settings** go through the store helpers:
  - `addSong`, `duplicateSong`, `deleteSong`, `resetToFactory`
  - `addSetlist`, `deleteSetlist`, `addToSetlist`, `removeFromSetlist`, `moveSong`, `setCurrentSetlist`
  - `exportJSON`, `exportSong`, `importJSON`
  - `neighbors`, `navIds`
  - `set('setlists.<id>.name', …)`
- **Actions** go through `controller.*`:
  - `selectSong(id, {index})`, `panic()`, `fadeOutAll()`, `perform.noteOn/noteOff/releaseAll`, `revertSong`
- Invalid writes return `false` and warn; they never throw. **Views never call the engine** (reads are allowed:
  `listInstruments`, analysers, events).
- **Presets:** `applyPreset(p, (path, v) => ctx.set(path, v))` and `matchPreset(list, ctx.valueOf)` from
  `shared/fx-presets.js`.
- **Params added later** (slot width/EQ, master EQ, glue) render only when `lib.hasParam(addr)` is true.

### 3.4 Reacting to store changes

`ctx.subscribe(fn)` calls `fn(ev)` once per store batch, after the shell has run the leave-song hooks.

```
ev = { state,            // store.get()
       song, songId,     // the current song after the change
       paths,            // canonical changed paths: 'songs.<id>.patch.slots.1.gain', 'settings.currentSongId',
                         //   'setlists.<id>.songIds', 'songOrder', …
       rels,             // the current song's changed paths, song-relative: 'patch.slots.1.gain', 'name', 'drone.mode'
       songChanged,      // a different song is now current → re-render everything
       full }            // the whole current song object was replaced (reset to factory, import) → re-render
```

The easy path is `lib.createBinder(ctx)`, the edit.js `bindCtl/bindFn/refresh` pattern for one panel:
- `binder.ctl(addr, (onChange) => comp, {read?, write?, text?})` binds a component `{el, set(v)}` to an address,
  sets `el.dataset.bind = addr`, and writes `ctx.set(addr, v)` by default.
- `binder.ctl(…, {rels})` overrides the song-relative paths that refresh a binding (default: the address's own path).
  The slot panel's Brightness/Warmth read the EQ's shelves, so they pass `rels: ['patch.slots.<i>.eq']`.
- `binder.fn(rels, (song) => …)` binds labels, summaries and enable states to song-relative paths.
- `binder.destroy()` destroys the tracked components **and** drops the binder's store subscription and leave-song
  hook, so a panel that rebuilds a sub-tree with a fresh binder does not leak (idempotent).
- It refreshes only the overlapping bindings, re-applies everything on `songChanged`/`full`, never overwrites a
  focused `text:true` field, and calls `cancelDrag()` on tracked components before a song switch (round2-ui #2).
- `text:'dirty'` (polish-1): a focused field keeps following outside writes (Tap, the header, another view) until
  the user types in it (`beforeinput` / `compositionstart` / `input`); the draft is then kept until `change` or
  `focusout`, and every `focusout` applies the store value again (forced, so a debounced commit followed by
  outside writes never leaves the stale draft). L-9: an outside write into a focused, untyped field
  keeps a whole-field selection (a number field is always selected), so the first keystroke replaces it, never
  appends. Song name, tempo and notes use it; prefer it to `text:true` for any typed field.
- Step panels that must not open over their chip pass `stepChip({mount, placement:'auto'})` (below / above /
  cover from the room in the host; the Effects who-goes-in column). The slot fader carries a `levelMeter`
  (`controller.slotLevel(i)`), read only while on screen.
- **Rebuild** a sub-tree only when its structure changes (for example the slot panel when
  `patch.slots.<i>.instrument` or `patch.slots.<i>` itself changes). Values update in place: ui-edit "store → view
  updates in place" is a contract, and tests mark elements to prove it.

### 3.5 Sentence title (block panels)

`ctx.setTitle(parts, { sub, icon, actions })`. Call it on mount and whenever a word in it changes. Each part is one
of these:
- `'plain text'`
- `{text:'KEYS', role:true}`: the role word, in `--c`, bold caps
- `{text:'an octave up', control:'[data-bind="slots.0.octave"]', changed:true}`: an underlined word. `control` is a
  CSS selector resolved inside your body, an Element, or `() => Element`. A click opens an enclosing `<details>`,
  scrolls to the control, focuses its first focusable descendant, and flashes it (`.ev2-flash`, 0.9 s).
  `changed:true` adds the white dot before the word.
- `{text:'Hall', changed?}`: a bold value with no control.

`sub` is the small grey line under the sentence (hidden at ≤ 1250 px). `icon` is a `lib.ICON_PATHS` name or a Node.
`actions` is a Node or Node[] for the right side of the title bar ("Change instrument ▾", "Vibe: your own mix", …).
Keep the sentence short enough to fit on one line at 1024 (16 px). Since polish-2B it wraps (at most 2
lines; 19 px at 1341–1480 px, 17.5 px at 1251–1340) instead of ellipsizing. `lib.sentence(parts, {onToken})`
builds the same markup for in-body lines (the Effects tab's three lines).

### 3.6 The changed dot rule (concept §2, `shared/song-diff.js`, which exists)

- A white dot means the value differs from `editState.baseline`, the Revert snapshot of the current song. That is
  `ctx.getBaseline()` from main.js (perform.js `savedSnapshot`) when it belongs to this song. Otherwise it is the
  shell's own copy, taken on controller `songSelected` or when the song changes.
- Only the `DIFF_WATCH` paths count:
  - slot `instrument`, `sends.reverb|delay|chorus`, `octave`, `sustain`
  - `patch.fx.reverb` and `patch.fx.delay` as one entry each
  - `hearIn`, `playIn`, `transposeOctave`, `minor`, `tempo`, `patch.swell.seconds`
  - `drone.mode` (source only), `drone.chordFollow`, `drone.continueAcrossSongs`
- **Faders, levels and mutes never get a dot** and are never counted.
- To test a path: `ctx.editState.isChanged('patch.slots.0.octave')`. To follow changes:
  `ctx.listen(ctx.editState, 'changes', render)`.
- For a stepChip, `chip.setLoaded(getIn(ctx.editState.baseline, 'patch.slots.0.octave'))` draws the dot and the
  "as loaded" step.
- A panel's footer line is `lib.changeText(n, edited)` with `n = ctx.editState.changeCount(<your block prefixes>)`
  inside `.ev2-chg` with a `lib.changedDot()`, and gets `.none` when the count is 0. The count is switch moves only,
  so with `n === 0` pass `edited = lib.editedSince(song, baseline, prefixes, omitKeys)`: "Sound edited (no switch
  changes)" vs "No switch changes since the song was loaded" (round3-edit m2). Levels and mutes are omitted.
- The shell draws the tab dots. Do not draw your own.

---

## 4. DOM and CSS conventions

- **Class prefixes (one per owner):**
  - shell `.ev2-*` (see styles-edit-v2.css)
  - slot `.ev2-slot-*`
  - drone `.ev2-drone-*`
  - effects `.ev2-fx-*`
  - master `.ev2-master-*`
  - song + song-header `.ev2-song-*`
  - setlist `.ev2-list-*`
  - bottom `.ev2-kb-*`
- **CSS lives in your `panels/<file>.css`**, which `styles-edit-v2.css` already imports. Every selector starts with
  `.ev2 ` and targets only your prefix or the shared widgets.
  - Order: `base.css` (the shared rules) loads **before** the panel files, so a panel rule beats a shared rule of
    equal specificity by source order. (An `@layer` for the shared rules was rejected: every unlayered `styles.css`
    rule, e.g. on `button`, would then beat them.)
  - `.ev2-head` does not clip (`overflow: visible`, z-index 5 above the rig card), so header menus may drop over it.
  - No element-only or global selectors, no `:root`, no `!important`, and no restyling of another panel or of
    ui-core component internals except under your own prefix (`.ev2 .ev2-slot-os .fader { … }`).
  - Tokens come from styles.css (`--panel`, `--line-2`, `--slot-0..3`, `--fx`, `--drone`, `--chg`, `--off-tile`,
    `--warn` = lock only) and `.ev2` (`--c` = the selected block's colour).
- **Shared widgets you may use:**
  - `.ev2-btn` (`.sm`, `.ghost`, `.danger`), `.ev2-linkbtn`, `.ev2-cap`, `.ev2-hint`, `.ev2-sp`, `.ev2-cdi`
  - layout: `.ev2-cols` + `.ev2-col` + `.ev2-col-sub`, and the footer `.ev2-foot` + `.ev2-chg`
  - `lib.section()` (`.ev2-sec`) and `lib.wordSlider()` (`.ev2-ws`)
- **No ids** except through a unique generator (the shell owns `#ev2-panel` and `#ev2-tab-*`).
- **Test hooks:**
  - every bound control carries `data-bind="<addr>"` (the binder sets it)
  - sections carry `data-sec="<id>"`
  - use `data-*` hooks rather than layout classes
  - section ids are globally unique and prefixed (`slot0-adv`, `fx-reverb`, `master-wheels`, `song-notes`,
    `list-file`)
- **No `innerHTML` with user data.** Build with `lib.h`. Text goes through `textContent`.
- **Layout budget:**
  - 1440×900 and 1024×700 with nothing scrolling horizontally (the page, and any host's `scrollWidth ≤ clientWidth`)
  - at 1024 the panel should fit without vertical scroll where the mockup does (`edit-1024.png`); the body may
    scroll as a fallback
  - the ≤ 1250 px media query is where compact rules go
- **Zero `console.error`, no 404s.** Use `console.warn` for recoverable problems.
- **Style:** 2 spaces, single quotes, semicolons, ≤ 120 columns, JSDoc on exports, and comments that say why.

## 5. Accessibility and input rules

- Every control has an accessible name (`aria-label` or a visible `<label>`). Sentence tokens are `<button>`s.
- A toggle exposes `aria-pressed` (the ON tile) or `role=switch` + `aria-checked`. A segmented control is a group
  of buttons with `aria-pressed`.
- **Menus** ("Change instrument ▾", "⋯ Song", "Vibe"):
  - a `role=menu` of `role=menuitem` buttons with ↑/↓/Home/End between items
  - open → focus the first item
  - Esc (through `ctx.onEscape`) closes the menu and returns focus to its button
  - an outside click closes it
  - while open, `ctx.markDialog(true, '<token>')`
- **Confirms** (delete, remove, reset):
  - inline, `role=alertdialog` with a question, a destructive button and Cancel
  - focus Cancel on open
  - `ctx.markDialog(true, …)` while open
  - Esc cancels (`ctx.onEscape` returns true)
  - nothing changes before the confirm
- **Esc inside Edit never panics.** The shell always `preventDefault`s it. ⌘. / Ctrl+. still panics.
  - An input that uses Esc itself (inline rename, search) sets `data-own-escape` and handles Esc there.
- **Arrow keys are global** (←/→ = Prev/Next song, ↑/↓ = mod wheel). When a control of yours consumes an arrow
  key, call `preventDefault()` and `stopPropagation()` (the song list does this; see ui-edit "plain ↑ must not nudge
  the wheel").
- **Pointer clicks blur** buttons, summaries and selects, so Space = sustain keeps working (the shell does this).
  Elements that must keep focus after a click (song rows) are marked `data-keep-focus`.
- Colour is never the only signal: OFF = struck-through name + hollow LED, changed = dot, selected = shape.
  Hit targets are ≥ 28 px (36 px preferred). Text contrast uses the `--faint`/`--muted` tokens (≥ 4.5:1).

---

## 6. Ownership and behaviour checklists

### OWNERSHIP

| Agent | Owns (create/edit only these) | Block / region |
|---|---|---|
| **slot** | `app/js/views/edit/panels/slot.js`, `panels/slot.css`, `test/phase2/edit-v2/panels/slot.test.mjs`; new `app/js/shared/smart-controls.js` + `test/unit/shared/smart-controls.test.mjs` | `slot:0`–`slot:3` |
| **effects** | `panels/effects.js`, `panels/effects.css`, `test/phase2/edit-v2/panels/effects.test.mjs` | `effects` |
| **master** | `panels/master.js`, `panels/master.css`, `test/phase2/edit-v2/panels/master.test.mjs` | `master` (incl. Wheels & pedal) |
| **song** | `panels/song-header.js`, `panels/song.js`, `panels/song-header.css`, `test/phase2/edit-v2/panels/song-header.test.mjs`, `test/phase2/edit-v2/panels/song.test.mjs` | region `head` + block `song` |
| **setlist** | `panels/setlist.js`, `panels/setlist.css`, `test/phase2/edit-v2/panels/setlist.test.mjs` | region `left` |
| **drone+bottom** | `panels/drone.js`, `panels/drone.css`, `panels/bottom.js`, `panels/bottom.css`, `test/phase2/edit-v2/panels/drone.test.mjs`, `test/phase2/edit-v2/panels/bottom.test.mjs` | block `drone` + region `bottom` |
| shell / integrator (not a build agent) | `shell.js`, `lib.js`, `styles-edit-v2.css`, `panels/index.js`, `panels/_stub.js`, this file, `test/phase2/edit-v2/{harness.html,harness.mjs,run.mjs,shell.test.mjs,integration*.test.mjs}`, and later `index.html`, `main.js`, `test/run-all.mjs`, CONTRACT_CHANGES.md | layout, tabs, wiring, selection |

- Screenshots go to `test/phase2/edit-v2/screenshots/<your-id>-*.png`. Always prefix with your panel id.
- Keep the harness smoke test (`smoke(t)`) as the first test of your file. Delete the "stub follows the current
  song" test when your panel replaces the stub.
- Each ui-edit test below names the new owner. "(+)" marks a behaviour that H-v2 adds.

### slot: `panels/slot.js` (the bulk; mockup `edit.png`)

**Title**
- Group icon tile.
- Sentence per concept §1(1): "KEYS plays **Grand Piano** on **every key**, ● **an octave up**, a little into the
  **Hall**, sustain **on**". Each token focuses its control; changed words carry the dot. A shared
  `describeSlot()` belongs in `smart-controls.js`.
- Sub-line: "Piano · sampled (Salamander) · click an underlined word to jump to its control".
- Action "Change instrument ▾" is a menu of instruments grouped by engine group:
  - Order: `INSTRUMENT_GROUPS` (copy edit.js's list, which includes 'Guitar & Plucks'), then unknown groups A–Z,
    then 'My Samples' last. `category:'pluck'` without a group → 'Guitar & Plucks'.
  - Hide `synth:drone-osc` and `it.hidden` unless the instrument is the current one.
  - A missing instrument shows "<id> (not available)".
- Picking an instrument:
  - into an empty slot → `ctx.set('slots.<i>', defaultSlot(i, ref))` (ui-edit "empty a slot and fill it again": Extra
    role default `sends.delay = 0.2`)
  - else `ctx.set('slots.<i>.instrument', ref)`
  - ui-edit "instrument change → engine slot instrument changes, card rebuilt, sound plays"
- Last menu item "Remove this sound…": confirm → `ctx.set('slots.<i>', null)` → a toast with **Undo** that writes the
  captured slot back through `songs.<id>.patch.slots.<i>` (H impl §4). **(+)**
- Empty slot (tab "+ Add a sound"): the body offers the grouped picker. `opts.focus === 'instrument'` opens it.

**ON STAGE column** (= the Perform strip)
- `ctx.C.onTile` = mute (`slots.<i>.muted`). OFF = grey + struck-through (ui-edit "mute toggle": engine gain 0
  while muted, back > 0 after). **(+)** replaces the MUTE toggle.
- Vertical `ctx.C.fader` on `slots.<i>.gain`: taper `2·pos³`, dB label, keyboard arrows, double-click → 0.8,
  `setMuted`, `cancelDrag` on a song switch.
  - ui-edit "slot fader → store (taper) → engine.getParam; keyboard; double-click reset"
  - ui-edit "round2-ui #2: a fader drag still going at a song switch never writes into the new song"
- `stepChip` Space / Echo (`AMOUNT_STEPS`, amount bar), Octave (`OCTAVE_STEPS` −2..+2, "Starts on your next note"
  footnote), Sustain (2-step cycle), and the wide Chorus chip (`sends.chorus`). Each has `setLoaded(baseline)`.
  **(+)**
- "Same switches, same colours as your Perform strip".

**THE SOUND ITSELF**
- Three `lib.wordSlider`s from `smartSlidersFor(meta)` in the new pure `shared/smart-controls.js`: each maps to
  exactly one PARAMS path. Suggested: Brightness → `slots.<i>.eq.high` or a tone param, Warmth → `slots.<i>.eq.low`
  (bipolar), Ring-out → the instrument's release param.
- Params mapped here are hidden from Advanced, with a note there saying where they went.
- Test in node:test that every `listInstruments()` entry gets 3 sliders bound to valid paths.

**WHERE IT PLAYS**
- `ctx.C.miniKeyboard` range with handles (`lowNote`/`highNote`), plus "Whole keyboard".
- Note fields accept "C3", "F#2" or MIDI numbers. An invalid entry toasts "“x” is not a key name — try C4 or
  F#2". Fields are song-bound via `ctx.songField`.
  - ui-edit "split: note fields + mini keyboard write lowNote/highNote"
  - ui-edit "round2-ui #3" (note fields)
- Range text "Whole keyboard" / "C3 to C5".
- "Set lowest…" / "Set highest…" arm a one-shot on the next held note (`editState` `notes`). Esc (`ctx.onEscape`)
  or a click disarms. **(+)**
- Response = `velocityCurve` segmented. Keep Settings' words Light / Normal / Heavy / Fixed (`TOUCH_LABELS`); the
  mockup's "Soft/Hard" differs, so flag it if you change them. Include the curve sparkline canvas
  (`data-curve`, drawn in the slot colour, > 50 px drawn). ui-edit "mute toggle + velocity-curve sparkline".

**Advanced** (a `lib.section('slot<i>-adv')` footer)
- Summary line: "Pan Center · Width 100% · Highs 0 dB · Transpose 0 · Voices All · Pitch bend Off". Show "Light
  touch" when the curve isn't Normal (ui-edit asserts `/Light touch/` in the summary).
- Pan; Width, Lows and Highs only when `hasParam` (Width shows "Mono" at 0 and a %; EQ shows "+6.0 dB"; double-click
  resets). ui-edit "new strip/master params render only when params.describe has them".
- Transpose stepper ±12 ("+1 semitone"); Voices = mono select (Chords / Single note lowest / highest); Pitch bend
  (`bendEnabled`); Sustain pedal.
  - ui-edit "pan / octave / transpose / sustain / mono reach the engine"
- **Instrument settings** from `meta.params`:
  - bool → toggle; enum → select (capitalised); numeric → knob or word slider with `formatInstrumentParam`, the log
    curve when `min > 0`, and double-click → the instrument default
  - "Reset these settings" writes every default explicitly
  - Hints: "This instrument has no extra settings." / "Instrument details appear once sound has started."
  - ui-edit "sends + instrument params reach the engine" (soft-keys tremolo 0.9, double-click → 0.25)
- Footer change line: `changeCount(['patch.slots.<i>'])`.

**Structure and state**
- Rebuild only on an instrument, emptiness or availability change. Song switches keep elements (ui-edit "store →
  view updates in place").
- Slot colour via `--c` / `var(--slot-i)` (ui-edit "M4": slot colours are distinct and never the accent).
- `update({slot})` switches slots without leaving stale bindings.

### effects: `panels/effects.js` (mockup `edit-effects.png`)

**Title**
- "The Space is a **Hall**, the echo is **the song’s own**, and the **Pad** has a gentle **chorus**".
- Action "Vibe: <name|your own mix>" menu over `VIBE_PRESETS`, applied with `applyPreset` through `ctx.set`.
- Vocabulary (polish-2B, ux-round2 #5): the effect is **Space** (never "Reverb" in a label), a room that matches no
  preset is **the song’s own** (tab summary "Song’s own", wiring "Space song’s own", sentence "into the song’s own
  Space" via `lib.spaceNoun`), never "Custom" / "the Space". Tested by `integration-widths.test.mjs` "naming".

**Three lines** (`.ev2-fx-line`: title + blurb | choices | "How much of each sound goes in")
- **Space.** Preset chips over `SPACE_PRESETS` with size hints (Dry *none*, Room *small*, Stage *medium*, Hall
  *big*, Cathedral *huge*, Ambient Wash *pad-only*) · **Song’s own** *<size word>*, shown when the baseline's room
  matches no preset; it writes the baseline's whole `patch.fx.reverb` back in one store change (round3-edit M3). The blurb is the preset's. Fine-tune `lib.section('fx-reverb')`
  holds word sliders for size, darkness (`damp`), pre-delay and level (`returnGain`, taper).
- **Echo.** Chips Off *no echo* · Slapback *1 repeat* · Quarter *on the beat* · Dotted 8th *worship echo* · Trails
  *long, dark* · **Song’s own** *as saved*.
  - Song's own is shown when the baseline's delay matches no preset. Tapping it writes back the baseline's
    `patch.fx.delay` only, as one whole-object write (like Perform's `pickFx`).
  - Fine-tune `fx-delay` holds: Timing select (Free time / Quarter notes / Dotted eighths / Eighth notes =
    `fx.delay.sync`), Time (disabled while synced), Repeats (`feedback`), Tone, Level, Ping-pong toggle.
  - The note reads "<sync> need the song’s tempo — set one…" or "<sync> at 72 BPM = 625 ms"; ms appear only in Edit.
  - A fixed echo reads "A fixed 420 ms echo saved with this song, so it doesn't follow the tempo." (concept 5c).
- **Chorus.** Two word sliders, Depth (subtle…deep) and Speed (slow…fast, Hz). Level `fx.chorus.returnGain` in
  Fine-tune `fx-chorus`.
- **"How much of each sound goes in"** is the **same stepChip** as Perform for each filled slot, bound to
  `slots.<i>.sends.<unit>` with `setLoaded`. Empty slots show a disabled "off". The step panel must stay inside its
  column at 1024 (implementation §2 test).
- The preset chip shows `matchPreset(list, ctx.valueOf)`; a tweak → no chip selected / "Vibe: your own mix".
- ui-edit "presets: Space / Echo / Vibe apply through the store; tweak → your own mix": hall → size 0.65 in store
  and engine; vibe 'set' → sync 1/8d + pingpong + space 'stage' + echo 'dotted'; size moved → your own mix.
- Chips never shrink below their words: the row wraps (`flex: 1 0 auto`; one row at ≥ 1366 px, two at 1280, the
  3-column grid at ≤ 1250). Song’s own keeps its natural width.

**Engine checks** (ui-edit "FX: reverb / delay (sync, pingpong) / chorus / …")
- `fx.reverb.size` 0.8 reaches the engine; `fx.delay.feedback` 0.45; `fx.delay.sync` '1/4' → the time control is
  disabled, 'off' → enabled; pingpong flips; `fx.chorus.depth` 0.3.

**Footer and focus**
- "Tape & finish: Tape off · Tone flat · Glue off · these live on the Master tab" → `ctx.select('master',
  {focus:'tape'})`, plus the change line (`changeCount(['patch.fx.reverb','patch.fx.delay','patch.fx.chorus'])`).
- `opts.focus` 'reverb' | 'delay' | 'chorus' scrolls to that line (the wiring lane buttons send it).

### master: `panels/master.js`

- **Title:** "**MASTER** is at **−6.0 dB**, tape **off**, tone **flat**, glue **off**".
- **Master volume:** fader or word slider on `master.volume` (taper; double-click → −6 dB). ui-edit FX test:
  master 700 → `2·0.7³` in the engine.
- **Tape** (`lib.section('master-tape')`, summary "Off" / "40%"): Amount `fx.lofi.amount`, then a "Tape & vinyl
  details" sub-section with Wow, Flutter, Crackle, Bit crush (`bits`), Tone, Saturation. ui-edit FX test: lofi
  amount 0.4, crackle 0.7 reach the engine.
- **Tone (EQ)** `master-eq`: bipolar Low/Mid/High on `fx.eq.*`, only when `hasParam`. Summary "Flat" or "Low +3.0 dB
  · …". Hint "Whole mix: low = warmth, mid = body, high = air." Double-click resets. ui-edit "new strip/master
  params…" (fx.eq.low +3 → engine, summary, reset → Flat).
- **Glue** `master-glue`: `fx.comp.amount`, only when `hasParam`. Summary "Off"/"50%". Hint "Gently evens out the
  whole mix so it sits together. Off = untouched."
- **Wheels & pedal** `master-wheels`:
  - Mod wheel controls (`song.patch.modWheel.target`, `TARGET_LABELS` from edit.js) with From/To (0–1, %).
  - Expression pedal controls, with From/To.
  - Volume knob controls (`song.patch.volume.target`).
  - Pitch-bend wheel (`song.patch.bend.mode`, `BEND_LABELS`) and Bend range stepper 0–24 ("2 semitones").
  - Swell time (`song.patch.swell.seconds`, 1–60 s log, "8.0 s").
  - ui-edit "routing + drone controls write the song": `engine._routing.modWheel.target === 'macro.wash'`,
    `_routing.bend.mode === 'tape'`.
- **Focus:** `opts.focus` 'wheels' / 'tape' opens and scrolls to that section, on mount and in `update()`.
- **Footer:** the change line (`patch.swell` is the only watched path here).

### song: `panels/song-header.js` (region `head`) + `panels/song.js` (block `song`)

**Header** (one row, 58 px; 48 px at ≤ 1250)
- "☰ Songs": visible ≤ 1250 px, `data-drawer-toggle`, calls `editState.setDrawer(!editState.drawer)`.
- LIVE badge.
- Song name as an inline-editable input (`ctx.songField(input, 'name')`): Enter blurs, and an empty value reverts.
  - ui-edit "song name + notes edit": the setlist row updates
  - ui-edit "round2-ui #3": a name typed before a MIDI song switch goes to the old song
- KEY chip "KEY **D** · you play D ▾" → `ctx.select('song', {focus:'key'})`. It has a dot when
  hearIn/playIn/transposeOctave/minor changed.
- BPM chip "**72** BPM [Tap]": tap tempo.
  - A gap of more than 2 s resets the taps; the last ≤ 4 taps count; 30–300 BPM → `song.tempo` (rounded); the button
    flashes.
  - ui-edit "tap tempo (4 taps @ 500 ms)": within 1.5 BPM of the click times, and `engine.tempo` follows.
  - Clicking the number → `select('song', {focus:'tempo'})`.
- Notes chip → `select('song', {focus:'notes'})`.
- Live hint "The song that’s playing. Changes are heard now and saved with it." (hidden ≤ 1250).
- "Loading…" badge from `controller.onStatus(st => st.loading)`.
- "⋯ Song" menu:
  - Duplicate (`store.duplicateSong`, toast)
  - Rename (focus the name)
  - Export song (`download(safeName(name) + '.rig-song.json', store.exportSong(id))`)
  - **Reset to factory…**, only when `song.factoryId`: confirm "Put this song’s sound back to the factory version?
    The key and notes stay." → `store.resetToFactory(id)`, then toast "“X” reset to factory" or "Already the factory
    sound". ui-edit "reset to factory": Glass Ocean reverb size back to 0.82, and the controls refresh.
  - Delete song… (confirm; `store.deleteSong`, toast)
  - Confirms follow §5.

**Song panel**
- Title: "This song is in **D**, you play in **D**, at **72 BPM**".
- **Easy Transpose** section `song-key`:
  - Play In / Hear In selects (12 pcs, labels `keyName(pc, minor)`, relabelled when `minor` flips)
  - Octave segmented −1/0/+1 (`song.transposeOctave`)
  - Key: Minor toggle
  - Readout: "No transpose — you hear what you play (D)." / "Play in C, sounds in D (+2 semitones)."
  - ui-edit "Easy Transpose": hearIn 2 → `engine.transpose` 2, octave +1 → 14, Bb → −2, minor → "C#m" labels and
    "Bbm" in the readout
- **Tempo** `song-tempo`: number input 30–300 (empty → null, song-bound), Clear, Tap. ui-edit: fill 96 + Enter →
  tempo 96.
- **Notes** `song-notes`: textarea, song-bound, max 10000.
  - Debounced 500 ms; flushed on blur and in `ctx.onLeaveSong`.
  - Placeholder "Notes for this song (shown in Perform)".
  - ui-edit "round2-ui #3": notes typed before a switch land in the old song.
- `opts.focus` 'key' | 'tempo' | 'notes' focuses that control.

### setlist: `panels/setlist.js` (region `left`; ≤ 1250 px it is the drawer)

**Setlist picker** (mockup: a "Sunday 9am — Oct 5 ▾" select)
- Options: "All songs (library)" + `setlistOrder`; `store.setCurrentSetlist`.
- New (then inline rename), Rename (input: Enter commits, Esc cancels, blur commits), Delete (confirm "Delete the
  setlist “X”? Its songs stay in your library.").
- ui-edit "setlist: new (inline rename) + select + delete"; "M1" (setlist confirm + Esc).

**Song list** (`role=listbox`, rows `role=option`, `data-index`, `data-id`, `aria-selected` on the current row)
- Row: number, name, key letter (mockup `em`). The current row is highlighted with the accent.
- Click / Enter → `controller.selectSong(id, {index})`.
- Keys:
  - ↑/↓ move focus (`preventDefault`: never nudge the wheel)
  - Alt+↑/↓ reorder (`store.moveSong`, focus follows)
  - Home/End
  - F2 or double-click → inline rename (Enter/Esc/blur)
  - Delete/Backspace → confirm
- Drag and drop reorder with before/after halves.
  - ui-edit "reorder: Alt+↑ keyboard and drag-and-drop → store.moveSong order"
- Row actions on hover/focus: Rename, Duplicate ("X (copy)"), Remove.
  - Remove confirm in a setlist: "Remove “X” from this set, or delete it from your library everywhere?" with Remove
    from set / Delete song / Cancel. In the library: "Delete “X” from your library?"
  - ui-edit "rename inline, duplicate, delete with confirm"
  - ui-edit "M1: Esc in Edit closes the confirm, never panics; body[data-dialog-open]"
- Search box appears at ≥ 9 songs; it filters by name. Esc clears it (`data-own-escape`); ↓ focuses the first row;
  Enter opens it. "No songs match “x”." ui-edit "song search appears for > 8 songs".
- **Setlist gap** (`settings.setlistGap` + `store.neighbors().gap`):
  - a note "The song you were on was removed from this set. Next plays “Y”." (or "…from the end of this set.")
  - a marker row "removed — Next continues here" / "removed — end of set"
  - no row claims current
  - ui-edit "removing the current song from the set shows where Next continues"
- Empty states: "This setlist is empty — add songs below." / "No songs yet."
- Keep row focus across re-renders.

**Adding songs**
- "+ New" (`store.addSong(null, {select:true, name:'New Song'})`).
- "Factory…" browser: by `CATEGORIES` with `CATEGORY_LABELS` headings; each item shows its name, the
  `firstSentence(notes)` and an "Add" button (`aria-label="Add <name>"`) → `store.addSong(f, {select:true})` + toast.
  - ui-edit "add song from factory browser" (Glass Ocean, `factoryId`, selected)
  - ui-edit "round2-ui #7" (headings "Synth", not "synth")
- "Library…" browser: songs of the library not in this set → `store.addToSetlist`, re-rendered.

**Library file** (`lib.section('list-file')`)
- Export library → "Worship Rig library YYYY-MM-DD.json" (`store.exportJSON`).
- Export song.
- Import… (`.json`, `store.importJSON` merge; toast "Imported N songs and M setlists"; errors toast the store's
  message, e.g. "not valid JSON"; a read failure → "Could not open “f”. Is it a Worship Rig export?").
- Hint "Imported songs are added to your library; nothing is overwritten."
- ui-edit "export library → valid JSON → re-import (merge)"

**Drawer and dialogs**
- Picking a song while the drawer is open closes it (`editState.setDrawer(false)`).
- Every confirm registers `ctx.onEscape` + `ctx.markDialog`.

### drone+bottom: `panels/drone.js` (block `drone`) + `panels/bottom.js` (region `bottom`)

**Drone**
- Title: "**DRONE** holds **D major** · Synth" (the key token → `ctx.select('song', {focus:'key'})`).
- `ctx.C.onTile`: OFF ↔ `droneOnMode(editState.baseline)` from `shared/song-diff.js` (the last source).
- Source segmented Synth / My Pads (`song.drone.mode` 'synth' | 'files'). ui-edit uses
  `[data-bind="song.drone.mode"] button[data-value=…]`; keep `data-value` on the options, including 'off' if it is
  offered.
- Level fader `drone.gain` (taper).
- Word sliders: Brightness, Movement, Width, Key fade (`drone.fade`, 1–20 s).
- Toggles:
  - Chord follow (experimental): disabled + `.disabled` in files mode (ui-edit checks for `ed-disabled`; assert
    your own class)
  - Continues across songs
  - Minor keys use the major pad
- Note text:
  - "The drone is off for this song."
  - "Plays the pad file for this key from your My Pads folder (Settings). Chord follow only works with the synth
    drone."
  - "Synth drone in D: root, fifth and octave (plus a ninth when bright)."
- ui-edit "routing + drone controls write the song": mode synth, brightness 0.7 → engine, files → chord follow
  disabled, off.

**Bottom** (mockup keyboard row, grid `150px 1fr 120px 104px 112px`; at ≤ 1250 `1fr 70px 84px 92px`, no legend)
- Legend: one row per filled slot (colour bar, role, range "all" / "to B3"); a muted slot is dimmed.
- Range bars over the keys, display only: `lowNote`/`highNote` per filled slot, open ends when 0/127, grey or dim
  when muted.
- `ctx.C.pianoKeyboard({from:36, to:96})`: `onNoteOn` → `controller.perform.noteOn(n, v ?? 100)`, `onNoteOff`;
  held keys from `editState` `notes`.
  - ui-edit "on-screen keyboard plays through controller.perform": `[data-note="67"]` held → `.held`, released on
    up
  - `controller.perform.releaseAll()` in destroy
- Output meter `ctx.C.meter({engine})`.
- Fade out → `controller.fadeOutAll()`; PANIC → `controller.panic()`, labelled "⌘ .".

### Shell / integrator (not a build agent)

- ui-edit "boot": the view mounts with ui-core components.
- ui-edit "M1": Esc never panics.
- ui-edit "screenshots … no horizontal overflow" at 1440/1024.
- ui-edit "destroy() cleans up and remount works".
- ui-edit "zero console.error".
- Tabs, wiring and the drawer are covered by `shell.test.mjs` (9 tests).
- The ui-edit "collapsed by default; section open state persists" rule now applies to `lib.section`
  (`localStorage['worship-rig.edit2.sections']`). Each panel keeps its sections closed by default unless the mockup
  shows them open.
- The **11 `settings:` tests** in ui-edit stay with `settings.js`. The integrator moves them to a settings-only
  fixture when `edit.js` is deleted.

---

## 7. Test harness (`test/phase2/edit-v2/harness.mjs`)

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';
after(shutdown);                                      // closes the shared Chromium + server

test('slot: …', async () => {
  const t = await mountPanelForTest('slot', { panelOpts: { slot: 1 }, viewport: { width: 1024, height: 700 } });
  try {
    await smoke(t);                                   // host rendered, ctx fields, title set, store→engine, no errors
    await t.setParam('slots.1.sends.reverb', 0.75);   // store.set in the page → true/false
    assert.equal(await t.readParam('slots.1.sends.reverb'), 0.75);
    await t.untilEngine('slots.1.sends.reverb', 0.75);
    await t.setRange(`${t.host} [data-bind="slots.1.gain"] input[type=range]`, 600);
    await t.click(`${t.host} [data-bind="slots.1.muted"]`);
    await t.select('slot:2');                          // editState.select → update()/remount
    await t.selectSong('Organ Swell');                 // controller.selectSong + wait for load
    await t.screenshot('slot-1024');                   // → test/phase2/edit-v2/screenshots/slot-1024.png
    t.assertNoConsoleErrors();
  } finally { await t.close(); }
});
```

**`mountPanelForTest(panelId, opts)`**
- `opts`:
  - `panelOpts`: mount options, e.g. `{slot:1}` or `{focus:'wheels'}`
  - `full`: mount the whole view; `panelId` = null
  - `viewport`: default 1440×900
  - `song`: factory id, song name or song id, selected before mount
  - `waitLoaded`: default true
  - `components`: `'ui-core'` (default) or `'fallback'`
- Boot: server.js on a **free port** (appDir = the repo root) and one Chromium per process, with
  `--autoplay-policy=no-user-gesture-required`. Each call gets a fresh browser context (fresh localStorage) and
  `harness.html`, which boots store (factory-seeded) → engine → midi/recorder → controller and mounts
  `shell.mountSinglePanel(host, ctx, id, opts)`.
- Handle `t`:

| Member | Meaning |
|---|---|
| `page`, `context`, `origin`, `errors` | Playwright page and context, the server origin, collected console errors |
| `host` | selector of your host (`#view-edit [data-panel="<id>"]`) |
| `ev(fn, arg)`, `until(fn, arg, timeout)`, `sleep(ms)` | evaluate in the page / wait for a condition / wait |
| `song()` | the current song |
| `setParam(addr, v)`, `readParam(addr)` | write / read (with PARAMS default) through the store |
| `engineParam(p)`, `untilEngine(p, v, eps)` | read `engine.getParam`, or wait until it matches |
| `setRange(sel, pos0to1000)` | set a range input by position (fires input + change) |
| `click(sel)` | Playwright click |
| `select(blockId, opts)` | `editState.select` |
| `selectSong(idOrName)` | controller switch, as MIDI does it; waits for the load |
| `playAndMeasure(note)` | peak RMS in dBFS |
| `screenshot(name)` | writes `test/phase2/edit-v2/screenshots/<name>.png` |
| `assertNoConsoleErrors()` | fails on any console error so far |
| `close()` | closes the context |

- In the page:
  - `window.__rig` = `{store, engine, controller, ctx, view, shell, lib, C, toasts, panelCtx, setBaseline(song)}`
    (`lib` and `C` so tests never `import()` inside `page.evaluate`; in full mode `view._debug.ctx(id)` is a
    mounted module's panel ctx)
  - `window.__ev2` = `{ready, panel, full, components}`
- Run commands:
  - `node test/phase2/edit-v2/run.mjs` runs shell + every `panels/*.test.mjs` + `integration*.test.mjs`,
    sequentially.
  - `--only slot,drone` runs just those files. `--list` lists them.
  - A single file: `node --test --test-reporter=spec test/phase2/edit-v2/panels/slot.test.mjs`.
  - Each file runs under `node --test --test-timeout=900000`. Under `--test`, node:test runs each file as one test,
    so this flag is the **per-file budget (900 s)**, not a per-test limit: the old 240 s value killed whole files with
    4–6 mounts on a loaded box. (Without `--test` the flag does nothing, checked on node 22.22.) Single tests are
    bounded by the harness's page waits instead. `run.mjs` also kills a file's whole process group at 900 + 60 s, so
    a hung Chromium cannot stall the run. Override with `EDITV2_FILE_BUDGET_MS` / `EDITV2_TIMEOUT_MS`.
  - `within()` clears its timer (a pending 45 s timer used to keep every file's process alive ~40 s after its last
    test), and the harness treats "audio running + song loaded" as started when `controller.start()` is still
    waiting on MIDI init (headless Chromium sometimes stalls there, which cost a 45 s retry).
  - Timing on the 2-CPU box: 12–25 s per file idle (after the fixes above; the whole suite ≈ 3–4 min).
  - Free ports mean agents can run their files concurrently.
  - `mountPanelForTest` retries a failed boot once and relaunches a dead Chromium. Every page wait has a timeout
    (goto 30 s, `controller.start()` 45 s, song load 60 s), so a boot that is merely slow is not a failure.

---

## 8. Integration (integrator only, after the six panels land) — done in hv2-edit-integrate

All steps below are done (CONTRACT_CHANGES "## hv2-edit-integrate"). Deviations: `styles-edit.css` stays linked
(Settings' `.st-*`, the fallback `.fc-*`, and `.ed-btn/.ed-danger/.ed-select` used by settings.js); its dead `.ed-*`
rules are left for a later prune. `integration.test.mjs` runs on the real app (its own server, appDir = app/).

1. `app/index.html`: add after the `styles-edit.css` line:
   `<link rel="stylesheet" href="./js/views/edit/styles-edit-v2.css">`
2. `app/js/main.js`:
   - `loadModule('./views/edit/shell.js', 'mountEdit')` replaces `./views/edit.js`.
   - The Edit ctx gains `getBaseline: () => performView?.savedSnapshot ?? null` (perform.js `savedSnapshot`).
3. `test/run-all.mjs`: add `{ name: 'edit-v2', groups: ['phase2'], cmd: [node, 'test/phase2/edit-v2/run.mjs'],
   timeout: 15 * MIN }`.
4. Delete `panels/_stub.js`. Write `test/phase2/edit-v2/integration.test.mjs`, which covers:
   - every PARAMS address used by a factory song is bound (`[data-bind]`) and reachable in ≤ 2 clicks
     (H impl §5 "Nothing lost")
   - 1440/1024 screenshots with no overflow
   - Effects "who goes in" chips write the same path as the Perform strip chip
5. Then retire `views/edit.js`, the `.ed-*` rules in `styles-edit.css` (Settings' `.st-*` and fallback `.fc-*`
   stay) and the edit half of the ui-edit suite. Move its settings tests to a settings fixture. Update ui-core's
   `SIBLING_FILES`. Log `## hv2-edit` in CONTRACT_CHANGES.md.
