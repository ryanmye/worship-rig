# ui-edit findings (bugs and gaps outside ui-edit's files)

Found while building `app/js/views/edit.js` and `app/js/views/settings.js` and running `test/phase2/ui-edit/run.mjs`.
For each finding: whether it was verified, the workaround in ui-edit's code, and the owner.

## 1. controller: removing an instrument-param key never reaches the engine (verified)
`controller.applyParamDiff` only loops over `Object.keys(next.params)`. If a key is removed, for example with
`store.set('song.patch.slots.0.params', {})`, the store forgets the value but no `engine.setParam` is sent, so the
engine keeps playing the old value until the next re-prepare. A node check with a fake engine showed that
`params.ratio = 5` sends `setParam('slots.0.params.ratio', 5)`, and `params = {}` afterwards sends nothing.
- **Workaround (edit.js):** "Reset instrument settings" writes each param's default explicitly
  (`slots.i.params.<key> = default`) and never clears the object.
- **Fix (shell/controller):** loop over the union of the old and new keys. For a key that was removed, send the
  default from `engine.listInstruments()` (or `registry.paramsFor`).

## 2. store: `slots.<i>.instrument` is not a writable path (verified; a footgun, not a crash)
`store.set('slots.0.instrument', ref)` returns `false` and warns "rejected", because the path is neither a §4
grammar path nor an entity path. The working forms are `song.patch.slots.<i>.instrument` (change the instrument;
params reset) and `song.patch.slots.<i>` (create a slot with `defaultSlot(i, ref)`, or clear it with `null`).
edit.js uses those. It would help to either accept `slots.<i>.instrument` / `slots.<i>` as current-song aliases or
document the two forms in store.js's header.
- `engine.getParam('slots.<i>.instrument')` is `undefined` for the same reason. The tests read `engine.slots[i].ref`.

## 3. engine-instruments / registry: `drone-osc` is offered as a slot instrument (verified)
`engine.listInstruments()` includes `Synth Pads: synth:drone-osc` ("Drone Oscillator"). SPEC §3.3 says it is
drone.js's own voice. The registry skips `d.hidden`, but `PATCHES['drone-osc']` isn't marked `hidden`.
- **Workaround (edit.js):** `HIDDEN_IN_PICKER` removes it from the instrument picker unless a slot already uses it.
- **Fix:** add `hidden: true` to the drone-osc entry in synth.js `PATCHES`.

## 4. params.LEARNABLE lacks `swell` (already reported in CONTRACT_CHANGES shell #4)
- **Workaround (settings.js):** `LEARN_ROWS = [...LEARNABLE, 'swell']` when it's missing. The controller already
  treats `swell` as a learnable button.

## 5. Chrome pad folder: no startup reconnect (gap)
The controller has `attachPads(list)` and Electron `reloadPads()`, but nothing restores a Chrome
(`showDirectoryPicker`) folder after a reload.
- **Workaround (settings.js):** the folder handle is stored in IndexedDB (`worship-rig-ui` / `handles` /
  `padFolder`), and `settings.padFolder = {kind:'fsa', name}`. Settings shows **Reconnect**, which calls
  `requestPermission` (it needs a click) and attaches blob URLs through `controller.attachPads`. Browsers without
  `showDirectoryPicker` fall back to a multi-file input. Those files must be picked again after a reload.
- **Suggestion (main.js/controller):** at startup, if `padFolder.kind === 'fsa'` and
  `handle.queryPermission({mode:'read'}) === 'granted'`, list the folder and attach it without a prompt.

## 6. ui-core styles.css has no rules for `miniKeyboard` (.mini-keyboard / .mkey / .mini-range / .mini-handle)
Without CSS, the split-range selector has no geometry.
- **Workaround (styles-edit.css):** minimal rules scoped as `:where(.ed …)`, with zero specificity, so any rules
  ui-core adds later win automatically.

## 7. Notes (no action needed)
- The Settings modal works whether main.js drives it (`ctx.openSettings/closeSettings` → our `open()/close()`) or
  it is opened directly. The Close button, backdrop and Esc go through `ctx.closeSettings()` so main.js's
  `settingsOpen` flag stays in sync. `close()` never calls back into ctx, so there is no recursion. Esc is
  handled at the window level while the modal is open, with `preventDefault`, so the controller never treats it as
  Panic even when focus has fallen to `<body>`.
- Headless Linux Chromium: `requestMIDIAccess` fails ("MIDI Error" in the top bar of the screenshots). That is the
  environment, not a bug. `midi._inject` still drives the learn and pedal tests.
