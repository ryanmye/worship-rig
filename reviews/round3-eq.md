# Round 3 review: slot EQ (eq-engine / eq-ui / eq-build)

Scope: `engine/fx.js` (SlotEq, resolveSlotEq, slotEqResponse), `engine/audio.js` (eq setParam/getParam, getEqResponse,
getSlotPlayRange), `shared/eq-math.js`, `shared/params.js` eq rows, `views/components/eq-keyboard.{js,css}`, and the
`store.js` normalizeSlot depth change. I also checked how `views/edit/panels/slot.js` hosts the editor.

Suites (run one at a time, box load 1–5):
- `node test/phase2/eq/run.mjs`: 22/22 (55.7 s).
- `node test/phase1/engine/run.mjs`: 65/65. eqCpu this run: all ten filters × 4 slots = 3.9 % of a core.
- `npm run test:unit`: 275/275.
- `node test/phase1/shell/run.mjs --only unit`: all passed.

Experiments are in `/tmp/claude-0/-home-claude/7e62a35d-8374-53c8-b5e9-fdad80c27279/scratchpad/review3-eq/`
(`exp1`–`exp8*.mjs`, `paste.mjs`). They use the eq fixture page or the real app (server.js, Playwright). No repo file
was changed except this report.

## Findings

### M1 (major, CONFIRMED): a coalesced slot write that is still pending at a song switch lands on the next song's reused channel

- **Where:** `engine/audio.js:814` (eq) and `:820` (gain). The same pattern appears in the other `coalesce.push` calls
  (pan, sends, fx units). `engine/fx.js:205-233` (`Coalescer`): nothing cancels its pending entries.
  `engine/audio.js:514` (`commit`) never touches the coalescer.
- **Problem:** Each pending closure captures `sc` and the old song's `cfg` or value. The timer that fires it runs after
  the audio clock passes `last + 10 ms`. In wall time that is often 10–50 ms, while a same-instrument switch commits in
  5–27 ms. The closure then fires after `commit()` has applied song B, and it re-applies song A's value to the reused
  channel. Audio and engine state now disagree: `getParam`, `getEqResponse` and the UI show song B's values, while the
  channel plays song A's. This lasts until that parameter is next written.
- **Measured (exp8, 6/6 runs):**
  - Two quick EQ writes on song A (b2 +3, then +12 dB; the second is coalesced), then `controller.selectSong(B)`,
    where B has the same instrument. Commit took 4.6–26.6 ms. 600 ms later the live `strip.eq.want.b2` is
    `on, peak, +12 dB`, while `engine._patch.slots[0].eq.b2` and the store are both `null`.
  - Control (exp8ctl), the same with 150 ms before the switch: b2 is off, as it should be.
  - The same with `slots.0.gain` (exp8gain, 6/6): song B's fader stays at 0.05 (−26 dB) while cfg and store say 0.8.
    A fader or EQ drag at the moment of a MIDI Next leaves the next song's slot nearly silent or wrongly EQ'd.
- **Fix:**
  - Add `Coalescer.cancelAll()` (clear `pending`; queued timer callbacks already no-op on a missing entry). Call it
    in `commit()` before the slot loop, and in `applyState` and `_teardown`. The commit applies the whole new state,
    so dropping stale entries loses nothing.
  - Belt and braces for EQ: resolve at fire time, e.g.
    `(tt) => { const c = this._patch.slots[d.slot]; const s = this.slots[d.slot]; if (c && s) s.strip.setEq(c.eq, tt); }`.
  - Add an engine test: a coalesced write, then prepare+commit of a same-instrument song, then assert the live EQ and
    gain equal the new cfg.

### M2 (major, CONFIRMED): the Tone editor survives a song switch (same instrument) and writes the old song's edit into the new song

- **Where:**
  - `panels/slot.js`: the rebuild key `slotKey` (`:153`) depends only on the instrument, so the editor is not rebuilt
    on a song switch. `ctx.onLeaveSong` (`:1041`) does not touch `toneEq`.
  - `eq-keyboard.js`: `refresh()` (`:334`) has no notion of song identity, and `drag`, `sel`, focused cells and
    `abState` carry across. `onCell` (`:486`) writes to whatever song is current.
- **Measured:**
  - **Real app (exp2).** Edit › Keys › Advanced › Tone is open. Song B's slot 0 gets the same instrument as A. Drag
    b8 down on A, call `controller.selectSong(B)` mid-drag, and keep moving. `tone()` still shows created 1 /
    destroyed 0.
    - Song A ends at b8 −7 dB.
    - Song B gets b8 **−15 dB** plus a migrated b1, and the engine plays it (`getParam(b8.db) = −15`).
    - The integration test only switches between songs with different instruments, so it never covers this.
  - **Cell typing (exp1 X2).** Type −9 into b8's dB cell on A, the song switches, then Enter. Song B gets
    `b8.db = −9` (and b1/b8 migration writes). Song A is untouched.
  - **A/B (exp1 X3).** Press B on A (b2 +6 dB goes `on:false` in the store), then switch to B:
    - The editor keeps `ab = 'b'` and draws song A's snapshot (b2 440 Hz +6) over song B, whose own b3 −4 dB is
      audible and not bypassed.
    - Song A stays persisted with b2 off (autosave) until A is pressed.
    - Restore is correct afterwards (it goes to `songs.A.patch…`).
- **Fix:**
  - In `eqKeyboard`, remember `songId` and, in `refresh()`, when `song()?.id` changes:
    - `cancelDrag()` and drop `pinch`.
    - Blur any focused cell after resetting `value = defaultValue`.
    - `leaveAB()` (it already restores to the old song's path).
    - Set `sel = null` and `builtSig = null`.
  - Also add a `slot.js` `onLeaveSong` → `toneEq?.update()`, or a new `toneEq.songChanged()`, so the host stops
    relying on the rebuild key.
  - Add an integration case with the same instrument in both songs, a mid-drag switch, and an assertion that B is
    unchanged.
  - This is the EQ instance of round3-edit M2 (step-panel drag into the next song).

### m1 (minor, CONFIRMED): keys pressed on the focused EQ plot leak into the app's global shortcuts, and modifier chords are hijacked

- **Where:** `eq-keyboard.js:1523-1600` (plot `keydown`). `controller.js:892-944` acts on any event that is not
  `defaultPrevented`.
- **Measured (exp5):**
  - All bands removed (b1/b8 `type:'off'`), plot focused, → pressed: **the song changes** (`controller.nextSong`).
    The `!b` branch (`:1558`) returns without `preventDefault` when `model.bands` is empty.
  - The low cut is selected on the plot (`sel = 'lc'`), ↓ ×5: **the mod wheel goes 1 → 0.5**. The `lc`/`hc` branch
    (`:1545`) handles only ←/→/Delete, so ↑/↓ reach `nudgeWheel`, and ⇧↑ would trigger swell.
  - Modifiers are never checked: **Ctrl+0 set b2 to 0 dB, and Ctrl+N added a band.** ⌘/Ctrl+O, B and 1–8 likewise
    toggle on/off, toggle A/B and select a band. In Chrome this also blocks zoom reset.
  - From reading the code: removing a band with its row ✕ rebuilds `tbody`, so focus falls to `<body>` and a keyboard
    user loses their place.
- **Fix:**
  - Return early at the top on `e.metaKey || e.ctrlKey` (keep ⌥/⇧).
  - While the plot is focused, `preventDefault()` every arrow key, even when nothing is selected or there are no
    bands.
  - Give `lc`/`hc` ↑/↓ a meaning (a semitone like ←/→) or swallow them.
  - After a row removal, focus the plot (or the neighbour row's ✕).

### m2 (minor, CONFIRMED): a hidden, still-mounted Tone editor runs `resize()` on every frame (in Perform, too)

- **Where:** `eq-keyboard.js:1699-1712`. When `G.w` is 0 (the Edit view is `hidden`), `frame()` calls `resize()` every
  frame. That does two `getBoundingClientRect` calls, `getComputedStyle`, canvas resizes and `syncTable()`, and
  `syncTable()` runs `actsOn`, which is 401 `magDb` per band. `slot.js` keeps the editor mounted while the user is in
  Perform.
- **Measured (exp6/7, real app, 8 bands, CDP metrics over 4 s):**
  - Perform with the hidden editor: script **180–231 ms** and task 1552–1806 ms.
  - The same after closing Tone: script **21–27 ms** and task 232–257 ms.
  - `getComputedStyle` runs 60 times a second while hidden.
- **Fix:** In `frame()`, when `!G.w`, just return; the ResizeObserver already calls `resize()` when the element gets
  a size. Better still, stop the rAF loop while `el.clientWidth === 0` and restart it from the ResizeObserver or
  `update()`.

### m3 (minor, CONFIRMED): the paste parser reads decimal commas wrongly without saying so, and reports REW boilerplate as skipped lines

- **Where:** `shared/eq-math.js:775-916` (`parseForeign`).
- **Measured (`paste.mjs`):**
  - `Filter 1: ON PK Fc 63,5 Hz Gain -3,5 dB Q 4,32` is **applied** as 63 Hz, −3 dB, Q 4, with no note.
    Decimal-comma locales (REW and APO files from EU systems) are the likely source. `Fc 1,000 Hz` → "no frequency
    found".
  - A full REW "Filter Settings file" gives 7 "skipped: not a filter line" rows. These are the header lines, plus
    `Filter 2: ON None`: the `^none` check (`:792`) runs before the `on`/`off` prefix is stripped, so it never
    matches REW's `ON None`.
  - For 10 input bands, both extra lines say "a **10th** band" (`:901` uses `found.length`, not the line's rank).
  - Free prose becomes a band and replaces the EQ. `Target: Harman (bass +6 dB below 100 Hz)` becomes PK 100 Hz +6.
    `Room size 5k` becomes PK 5 kHz 0 dB.
- **Fix:**
  - Normalise `(\d),(\d{1,2})\b` to `$1.$2` when the line has no `.` decimals, and strip thousands separators in
    `Fc`. Add a note whenever a comma was reinterpreted.
  - Test `none` on `t` (after the on/off strip), and silently drop REW header lines, or collapse them into one
    "n header lines ignored" row.
  - Use the line's own rank in the message ("a 9th band").
  - Require a filter keyword or an `Fc` before accepting a line as a band.

### m4 (minor, CONFIRMED retention; SUSPECTED wrong rate): the getEqResponse shadow cache outlives `restart()`

- **Where:** `engine/audio.js:863` (`this._eqShadow`), which `_teardown`/`restart` never clear.
- **Measured (exp1 X5):** After `engine.restart()`, the cached shadow node's `context` is the old, closed context, so
  it stays alive. At the same sample rate the numbers are still right (6.0 dB before and after).
- **Suspected:** after a restart onto a device at a different rate, every cached spec keeps answering at the old rate,
  until each band's spec changes. `slotEqResponse` still clamps to the new Nyquist.
- **Fix:** Clear `this._eqShadow = null` in `_teardown()`, or key the cache by `ctx`.

### m5 (minor, CONFIRMED): views still call the engine for EQ; the controller pass-throughs from eq-build were never added

- **Where:**
  - `controller.js` has no `getEqResponse`, `getSlotPlayRange`, `eqAudition`, `slotAnalysers` or `auditionNote`.
  - `eq-keyboard.js:69-71` therefore falls back to `engine.*`, and it also reads `engine.ctx` and `engine.analyserL/R`
    directly.
- **Problem:** The component works, but it breaks CLAUDE.md's "views never call the engine", and A/B stays on the
  store fallback, whose persisted-bypass risk makes M2's A/B case worse.
- **Fix:** Add null-safe `controller.getEqResponse/getSlotPlayRange` pass-throughs. A proper `eqAudition` (a
  non-persisted engine bypass) would remove the store A/B path and its autosave risk entirely.

Not repeated here: round3-edit m1 (Brightness/Warmth show an off shelf's dB). It is the same `shelfDb`/`shelfWrites`
root cause and was confirmed there.

## Solid (checked, no action)

- **DSP vs getFrequencyResponse:** the suite's `eqBandResponse` matches rendered audio to ≤ 1e-4 dB for peak, both
  shelves, notch, band cuts, dedicated cuts, legacy rows, and all 8 bands with both cuts.
  - `rbjCoeffs` matches the Web Audio spec formulas term by term: shelves with S = 1, peaking/notch with linear Q,
    HP/LP with dB Q. Band-cut Q = 20·log10(q) is used identically in fx.js, eq-math and the shadow nodes.
  - Q ↔ bandwidth uses the digital (bilinear) relation. The wings sit at the half-gain points for PEQ and at −3 dB
    for a notch, which is the correct RBJ definition for each.
- **Chain rebuilds under storms (exp3, realtime):** 60 type changes 7 ms apart (peak/notch/shelves/cuts), with on/off
  and cut toggles interleaved; type fades interrupted mid-fade (→ lowshelf → peak within 10 ms, → shelf → notch →
  peak, a fade with on/off mid-fade); and a no-gap batch.
  - After every scenario: no `incoming` left, every member is wired with the right type, Hz, gain and Q, the leftover
    bands are identity at 0 dB, and the active chain gain is 1.
  - Switches serialise through `_dirty`, and no timer callback threw.
- **Zipper:** k-rate on every EQ param. The suite's `eqDragZipper` and `eqSwitchClicks` report 0 clicks, and the
  positive control is detected. I did not listen.
- **Legacy compatibility:** `resolveSlotEq` and eq-math's `readEq` agree field by field, including default Hz for
  mid1/mid2, and `on`/`type` defaults for partial b-rows.
  - The first edit migrates every on-screen legacy band and zeroes `low/high/mid1/mid2`, so gains never double.
  - Factory songs carry no `eq`. `calibrate`/`audition` run with the identity defaults (`eqIdentity` 2.4e-7).
- **store normalizeSlot depth change:** it copies containers on the way down and never mutates `raw`. `SLOT_EXTRA`
  multi-segment rows exist only under `eq.*`, so no other nested param is affected. A corrupt scalar `eq.b1` is kept
  as an unknown field, and the engine and eq-math both ignore it. `setIn` replaces a scalar container with an object.
- **Greyed zone live:** the octave, transpose and split tests pass. After a song switch to a different
  split/octave, the zone is right on the next frame: exp1 X4 showed 48–108 → 9–47, which matches the engine.
- **Destroy:** the suite's listener, subscription and rAF accounting passes. The long-press timer, toast timer and
  pointer capture are released, and B is restored before `destroyed` is set.
- **CPU:** 8 bands × 4 slots cost 3.9 % of a core with all ten filters (up to 6 per slot fits the 2.5 % budget). That
  is already documented in eq-engine. A drag move with 8 bands costs a median 8 ms and p90 26 ms of main thread,
  including the store microtask and a `setTimeout(0)`. The box was at load 3 on 2 CPUs, so I treat this as
  inconclusive, not a finding.

## Prioritized fix list

1. **M1:** add `Coalescer.cancelAll()` in `commit`/`applyState`/`_teardown`, and resolve the EQ at fire time. Add an
   engine test (the gain case has the same cause).
2. **M2:** make the Tone editor song-aware (cancel the drag, revert and blur a focused cell, `leaveAB`, reset the
   selection), plus a slot.js `onLeaveSong` hook. Add the same-instrument integration test.
3. **m1:** in the plot keydown, ignore Ctrl/⌘, always swallow the arrows, handle `lc`/`hc` ↑/↓, and restore focus
   after a row removal.
4. **m2:** stop the rAF/resize loop while the editor is hidden.
5. **m5:** add the controller pass-throughs, then a real `eqAudition`, which also retires the store-mode A/B risk.
6. **m3:** paste parser decimal commas, REW `ON None` and header lines, the ordinal, and a stricter line filter.
7. **m4:** clear `_eqShadow` on teardown.
