# Review: MIDI learn any param (2.x step 5, DECISIONS O-AW-ML) (skeptic, 2026-11-25)

## Verdict

- **lane-learn (wt-learn on 1959e0f, uncommitted): VERIFIED after four fixes (L1, C1, S1, M1).**
  - L1: the Pedal hold knob did not match its slider, and it could never get back to 'natural'.
  - C1: a knob learned on a footswitch's CC was silently dead.
  - S1: during a song switch, the old song's last knob value landed on the loading song.
  - M1: an NRPN knob, or a bank-select pedal, could be mis-learned.
  - All four are fixed and tested, and the whole gate is green. All 8 builder claims hold after the fixes.
  - Two things are not verified. iPad long-press doesn't work in WebKit (O1). Release's "instrument's own" value
    jumps when a knob takes it over (O2).

## Gate (Linux container, 2 CPUs shared with another agent, xvfb-run, one suite at a time, after all fixes)

| Suite | Result |
|---|---|
| shell (unit / browser / electron under xvfb-run) | 306 / 13 / 22 pass, 0 fail (1 macOS-only skip) |
| `run-all --only unit` | PASS: 679 pass, 0 fail, 11 skip |
| settings | 90/90 (modes app, fixture, mac, bridge), zero console.error in each |
| ui-core | 78/78 |
| edit-v2 | 11/13 files on this base. The 2 failures are `slot` (2) and `song` (4), the Enter regression fixed by 9f5657e. With 9f5657e's controller.js and main.js applied in a /tmp copy, slot and song pass, 2/2. The `learn` file passes, zero console.error. |
| migration-1x | all suites passed |
| `build-engine-api.mjs --check` | up to date. params.js, app/js/engine and native/core and apple are untouched. |

## Findings and fixes

**Curves (claim 2): measured on every bound slider.** A browser probe walked all 7 blocks of a 4-slot song with
every section open. For each learnable `[data-bind]` range input, it set 5–6 values per row and compared the
thumb's position with `valueToCc`.
- Agree within 0.0005, which is the slider's 1/1000 rounding:
  - gain and level rows: taper;
  - Hz, Q and time rows: log;
  - pan, width, sends' rows, EQ dB rows (linear, the same as their sliders), touch and drone rows.
- Instrument params, wheel ranges and swell time are not learnable, as the builder documented.
- **L1 (fixed):** `slots.<i>.pedalHold` was off by up to 0.096.
  - The slider is log 2..40 s, and from 31 s up it reads 'natural' (the field is removed).
  - The knob ran 2..30 s, so the default ('natural') had no position. It was taken over at once, and it could never
    be reached again.
  - Fix: `PEDAL_HOLD_TRACK` in `shared/learn.js`, shared with the slot panel. `ccToValue` returns `null` at the top,
    and the store removes the field. `valueToCc` puts natural at the top.

**Conflicts.**
- CC64 stays unmappable. Learn reports `sustain-pedal-reserved`, and runtime skips 64. 66 and 67 are never a fader.
- **C1 (fixed):** nothing stopped a fader and a button from sharing a CC. Rule 4 reads the first mapping, so a knob
  learned onto a footswitch's CC did nothing, and the menu still toasted "→ CC 20". `controller.learn` now clears
  conflicting mappings and returns `replaced`:
  - a conflict is the same CC or note on an overlapping channel, where either side is a button;
  - fader + fader still share (rule 4);
  - both toasts name what was replaced.
- **Behaviour change, noted:** two *fixed* fader rows on one CC (for example Keys level and Pad level) now both move.
  In 1.x the first won. This is consistent with rule 4, and harmless.
- CC1 and CC11 can be learned. A learned mapping wins over the wheel and expression handling, as in 1.x, so the
  song's mod-wheel target silently stops. See O3.

**14-bit and NRPN.**
- 14-bit controllers: the MSB (CC 0–31) arrives first and is learned. The LSB (CC n+32) is ignored, so a knob gives
  7 bits.
- **M1 (fixed, midi.js):** a fader or button learn took the first CC it saw. For an NRPN knob that is CC 99, the
  constant parameter number. For a program-change pedal it is bank select (CC 0 / 32).
- `LEARN_STRUCTURAL_CCS` (0, 32, 6, 38, 96–101) are now skipped. 'any' learns are unchanged.

**Song switch and scenes.**
- **S1 (fixed):** `store.selectSongId` runs at once, but `dropLearnWrites` and `pickups.clear` ran only at commit,
  after the samples load.
  - In that window, a pending trailing write landed the old song's value on the new song.
  - A knob that was picked up on the old song could also cross straight into the new song.
  - Fix: pickups and pending writes carry the song id. This also helps the fixed rows.
- D6 cue/go goes through the same `applySong`, so it is covered.
- Scenes: only `slots.<i>.gain` and `drone.gain` go through `adjustScene`. A scene recall moves the stored value, and
  the "moved elsewhere" check then unpicks the knob, so it has to cross the value again.

**Channel, edge cases, store.**
- Channel null means any.
- min > max, invert, and a range outside the row are all clamped. A value outside the mapping's range picks up at
  the nearer end. These are covered by the builder's tests, and I re-read them.
- Store validation, migrate idempotence and export / import are as claimed.
- `midiLearn` is library data, as in 1.x. It is not in `DEVICE_LOCAL_SETTINGS` or `DEVICE_BLOCK_SETTINGS`, which is
  consistent with D11.
- 1.1.1 refuses schema-2 files ("made by a newer version"), so custom keys can never reach a 1.x controller. In
  1.x they would play on a cubic taper.

**Load test: 200 CC/s for 10 s, full Edit view mounted.** The test ran 3 params on one CC, plus a fixed row on a
second CC. The box load average was 5 on 2 CPUs. Two runs per mode:
- **Store writes:**
  - custom paths: about 35–40 writes/s per param, all on one CC (target ≤ 50);
  - fixed rows: 120–140/s, unthrottled, as in 1.x.
- **Engine setParam:** equal to the store writes.
- **localStorage:** 1 write (34 KB) at the end. The 300 ms trailing debounce holds through a continuous sweep.
- **Main thread:**
  - mean timer lag 2.8–4.8 ms, against a 1.8–3.0 ms baseline with no mappings;
  - max-lag spikes of 67–460 ms appear in the baseline too, so they are box noise;
  - handler p99 1.7–5 ms.
- Final values are exact: send 33/127, feedback 0.9·33/127, Hz log, gain 2·(33/127)³. The engine matches.

**UI.**
- Right-click opens the menu. Ctrl-click and Chromium long-press both fire `contextmenu`, the same path.
- Esc, outside pointerdown and leaving Edit all close the menu. Outside click also cancels a pending learn.
- Edge placement stays on screen. Learn is focused on open.
- Menu items are 48 / 44 px. Contrast:
  - title 14.8:1; status 7.1:1; items 13.1 and 6.3:1; Forget 7.2:1.
- Screenshots: `test/phase2/edit-v2/screenshots/skeptic-learn-menu.png` and
  `test/phase2/settings/screenshots/<mode>-learn-custom.png` (new in the settings test).
- Settings' Learn / Remove buttons are 30 px high. That is pre-existing for the whole table (O4).

Tests added: `learn.test.mjs` +1 (one assertion changed: natural = 1); `learn-any.test.mjs` +4 (C1, S1, M1, L1).
Each fails on the old code.

## Open items

- **O1, iPad (before the iPad ships):** WebKit fires no `contextmenu` on a touch long-press, so the menu can't open on
  iPad touch. It still opens with a trackpad or mouse right-click. I couldn't verify this here (no WebKit). The fix
  needs its own gesture, for example a pointer long-press for `pointerType === 'touch'` that doesn't fight the range
  input's drag. Rule 7 now says so.
- **O2, release (low):** absent `slots.<i>.release` (the instrument's own) has no knob position, so the first message
  takes it over at the knob's value. The slider shows the instrument's release, which the controller could read from
  `listInstruments`.
- **O3, CC1 / CC11 (UX):** learning the mod wheel or expression to a param silently mutes the song's wheel or pedal
  target. Suggested fix: a line in the toast ("CC 1 is your mod wheel: it now moves …").
- **O4:** Settings' Learn table buttons are 30 px high, below the 44 px rule. This is pre-existing for every row.
- **O5:** an imported odd key (a newer version's id, or `slots.0.mono`) still claims its CC and does nothing. This
  is 1.x behaviour. `learnedAll` could skip ids that are neither a button nor a learnable path.
- **O6, live-only vs edit: Ryan decides, not tier 2.** It changes what gets saved into his songs during a service.
  - My recommendation is to keep knob moves as song edits for now. That matches:
    - Perform's own faders (they write the store and show in Revert);
    - the 1.x learned level faders;
    - an Edit slider drag.
  - The measured cost while a performer rides a knob is small: changed dots and Revert update about 40 times a second.
  - The case for live-only, like wheels or a scene tweak: a knob ridden during worship persists into the song's
    saved sound for next week, and only Revert, before the song switch, undoes it.
  - If Ryan wants MainStage-like behaviour, the cheap version is a per-mapping `live: true`. The controller would
    route it the way `adjustScene` tweaks are routed, held until the song switch. migrate already keeps unknown
    fields.
