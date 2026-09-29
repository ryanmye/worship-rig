# Review round 4: perform (after polish-2A)

Scope: `app/js/views/perform.js`, `app/js/main.js` (renderer), `app/styles.css`, `app/js/views/components/*.js` (not
eq-keyboard). Reviewer: review4-perform, 2026-09-28. Read-only apart from this file (and one appended request in
`reviews/for-local.md`).

**Suite:** `node test/phase2/ui-core/run.mjs` passed **46/46** (182 s, load 1–4).

**Experiments:** `scratchpad/review4-perform/exp.mjs`. It uses the real app and server, Playwright Chromium, and CDP
`Memory.getDOMCounters` after a forced GC. Named runs: `sizes quick holdcap bstrip revert lamps lockkeys lockban leak
switchleak winleak four l20`. The screenshots are in `scratchpad/review4-perform/shots/`.

**Local (CC) session, as of 22:05Z** (public repo `ryanmye/worship-rig`, `.cloud-outbox/status.md`):
- SYNC 20260928T215342Z merged cleanly (d921d4d). The fast suite gave **8/10**.
- The two failures are new, macOS font-metric findings:
  - **L-20** is in this area: ui-core "polish-2A responsive" at 1280×800 has `div.song-name` 42 px tall, over the
    40 px allowed. It is reproduced below as P2.
  - **L-21** is in the eq cells at 1100 px. It belongs to the edit/eq owner.
- L-8 is verified. L-10 is resolved by a soak soft-cap rule (2835a26). L-9 is green.
- 26 GarageBand/Logic packs were imported.
- Running now: full run + soak, then build, then PACKS, then PERF. A MAC-REVIEW+README agent and a MENUBAR Electron agent
  (branch `menubar-local`) are also running.

## Findings (most severe first)

### P1 · major · CONFIRMED: the hold hints on Revert and Lock are drawn below the screen
- **Where:** `app/styles.css:521` (`.hold-btn .hb-cap { bottom: -30px }`) and `:669`.
- **Problem:** the bottom-row hold buttons fill the `--p-bottom` row, which ends 10–14 px above the window edge. Their
  caption ("press and hold (0.6 s)" / "keep holding… (0.6 s)") sits 30 px below the button, so it is off-screen.
- **Measured** after one tap on Revert:
  - 1440×900: the caption spans y 893–915 with the view ending at 900, so 7 px are visible.
  - 1024×700: 5 px visible.
  - 1280×800: 5.7 px visible.
  - Lock (locked, tapped): the caption spans 892–914 at 900.
- The Transpose captions show in full (22 px). Revert is *always* a hold, and unlocking is a hold. Right now a tap on
  either gives only a 2 px amber ring (screenshot `shots/holdcap-revert-1024.png`).
- **Fix:** `.p-bottom .hold-btn .hb-cap { bottom: auto; top: -30px; }` (above the button; the keyboard row is not
  live-critical under it). Alternatively, show the caption inside the button in place of `.hb-body` while hinting.
- **Test:** ui-core. Tap Revert (with a change) and a locked Lock at 1440×900 and 1024×700. Assert the `.hb-cap` rect
  lies wholly inside `#view-perform`.

### P2 · major · CONFIRMED (local L-20, reproduced on Linux): the song name's line box is smaller than its glyphs
- **Where:** `app/styles.css:640` (`.song-name … /1.05`, `overflow: hidden`), with the padding at `:636`.
- **Problem:** at `line-height: 1.05`, fonts with taller ascent + descent overflow the clipped box. The name is
  `overflow:hidden`, so descenders (the "y" in "Sunday") can lose 1–3 px. The Mac fails the responsive test at
  1280×800 (42 > 40).
- **Reproduced here** by forcing the font on `.song-name` and reading scrollHeight / clientHeight:

  | Font | 1280×800 | 1440×900 | 1024×700 |
  |---|---|---|---|
  | Carlito | **42/40** (the Mac numbers) | 45/42 | 36/34 |
  | DejaVu Sans | 41/40 | 44/42 | — |
  | Linux default | — | 43/42 (passes only through the probe's +1 px slack) | — |

- **Fix:** make the line box ≥ 1.12 em and take the height from the padding.
  - `.song-name` line-height 1.12.
  - `.song-block` padding `clamp(2px, calc((var(--p-head-h) - 98px) / 2), 8px)`.
  - `.song-sub` margin-top 2px.
  - At ≤ 1250 px: `.song-block { padding: 4px 14px }`.

  Budget check: at head 102, inner 100 − 2·2 − 42.6 − 2 − 44 ≈ 7. At 112 (pad 7): 110 − 14 − 44.8 − 2 − 44 ≈ 5. At
  1024 (94, pad 4): 92 − 8 − 35.8 − 2 − 44 ≈ 2.
  - Alternative: `overflow: clip; overflow-clip-margin: 4px`. Verify that `text-overflow: ellipsis` still works with
    `clip` in Chromium first.
- **Test:** in ui-core, force `font-family: Carlito` (or any font with ascent + descent ≥ 1.2 em) on `.song-name` at
  1280×800, 1440×900 and 1024×700. Assert `scrollHeight <= clientHeight` with **no** +1 slack, and that the song-sub
  still fits the head row.

### P3 · major · CONFIRMED: Quick › "If something's wrong" says "Sound OK" while the top bar says Paused or Muted
- **Where:** `app/js/views/perform.js:1281` (`sound: a === 'stalled' ? … : 'ok'`), with `quickSheet.js` render.
- **Problem:** a `status.audio` of `'suspended'` shows the top bar "Paused" with an amber LED. The Quick sheet, the
  panel a player opens when nothing sounds, shows **"Sound OK · 42 ms"** with a **green** LED and offers only the 1 s
  hold-to-restart. That is measured.
- A secondary instance (top bar "Muted") maps to "Sound OK" the same way. That is by code: the synthetic status was
  overwritten by the controller's 1 s tick before it could be read.
- **Fix:**
  - Pass the real state: `sound: secondary ? 'muted' : a === 'running' ? 'ok' : a` (`suspended` → 'paused').
  - quickSheet renders "Sound paused" / "Muted (another window is open)" with a warn LED.
  - For 'paused', show the one-click `qs-restart` (or `controller.resumeAudio()`).
- **Test:** ui-core. Dispatch `status` with `audio:'suspended'` and with `instance:'secondary'` while the sheet is
  open, and assert the text and LED class. Re-send the patched status on an interval so the 1 s tick can't overwrite
  it.

### P4 · minor · CONFIRMED: the expanded banner strip stays over the Settings modal, covering its close button
- **Where:** `app/js/main.js:283-293` (the strip overlay), `:393/:400` ("Open Settings" actions) and `:156`
  (`openSettings` doesn't fold the strip); `app/styles.css:276` (`.bstrip.open .bstrip-list { z-index: 60 }` against
  `.settings-modal { z-index: 50 }`).
- **Measured:** expand the strip (library danger + instance warn), then tap the banner's own "Open Settings".
  - Settings opens, and the strip stays open over it (list y 56–174).
  - `elementFromPoint` on the Settings close button returns the banner.
  - Esc closes both, and any tap outside folds it (not swallowed), so it can be recovered from.
  - This is on the "Changes are NOT being saved" path. Screenshot `shots/bstrip-over-settings.png`.
- **Fix:** call `setBstripOpen(false)` at the top of `openSettings()`, or in a wrapper around every banner action's
  `run`. Also drop the open list's z-index below the modal (e.g. 45; it only needs to be above the stage, and toasts
  are at 80).
- **Test:** the ui-core banners test. Expand, click "Open Settings", and assert the strip is folded and the Settings
  close button is the hit target.

### P5 · minor · CONFIRMED: the "Sing it in…" popover leaks its DOM on every open (Perform's disposer keeps it)
- **Where:** `app/js/views/perform.js:741` (`d.listen(back, 'click', …)`) and `:745` (`blurAfterPointer(back, d)`).
- **Problem:** both register on the view-lifetime disposer `d`. The closures keep `back` alive, and with it the whole
  detached popover, including the 12-key grid.
- **Measured** (CDP, after GC):
  - 100 open/close cycles: **+5200 nodes, +2600 listeners** (52 nodes and 26 listeners per open).
  - 100 song switches with the popover open: +5211 / +3003.
  - For comparison, 100 step-panel or Quick open/close cycles: Δ0.
- **Fix:** create a per-popover `const pd = disposer()` for `back` and dispose it in the overlay's `onClose`, next to
  `sing.destroy()`.
- **Test:** ui-core, CDP `HeapProfiler.collectGarbage` + `Memory.getDOMCounters`. 50 open/close cycles should give
  Δnodes < 20.

### P6 · minor · CONFIRMED: lock gaps: "Use that library" is live under lock, and the LOCK table doesn't match the code
- **Where:** `app/js/main.js:408-425`, `app/js/views/perform.js:44-54` (LOCK) and `:1265` (padBtn).
- **Problem:**
  - Locked, the newer-library banner still offers **"Use that library"** (measured: buttons `["Use that library","Not
    now"]` while locked). One tap replaces the whole library mid-service. "Open Settings" is correctly withheld under
    lock, and it comes back on the next status tick after unlocking (verified).
  - The LOCK table says `pad folder` is frozen, but in Electron with pads loaded the button ("Rescan") stays enabled
    under lock (`padBtn.disabled = locked && !(isElectron && padsInfo.total > 0)`).
  - The table also doesn't cover the top-bar master fader, REC, Quick, the compact "Notes" toggle, or banner actions.
    `lockBtn.title` mirrors the table.
- **Fix:**
  - Under lock, show only "Not now" on the offer, or make "Use that library" a hold. Add
    `'banner: Open Settings / Use that library'` to `frozen`.
  - Either freeze Rescan under lock, or move "pad folder rescan (Electron)" to `live`.
  - Add the top-bar items to the table so the ui-core LOCK test can walk it.
- **Test:** extend ui-core "Perform lock (H-v2 LOCK table)" with a status carrying `otherLibrary` while locked.

### P7 · minor · CONFIRMED: the MIDI "starting" toast outlives the connection, and Chrome can show the prompt advice twice
- **Where:** `app/js/main.js:636-640` and `:833-841`.
- **Measured:** status pending, then connected 50 ms later. The lamp reads "Keystation", but the toast "MIDI starting…
  answer the browser's permission prompt if it appears." stays for its full 10 s.
- In Chrome with `permissions.query({name:'midi'}).state === 'prompt'`, `firstRunHints()` already toasts "Chrome will
  ask to use your MIDI devices — click Allow". The 5 s pending toast then says the same thing again. This part is by
  code: headless can't enter the prompt state.
- **Fix:** dismiss `MIDI_PENDING_TEXT` (and the Electron variant) as soon as `!pending`. Skip the pending toast when
  firstRunHints already showed its prompt hint (share a flag).
- **Test:** ui-core polish-1 L-3 test. Pending, then connected: assert no pending toast is left within 300 ms.

### P8 · minor · CONFIRMED: an error toast is evicted by later info toasts
- **Where:** `app/js/main.js:56` (`while (liveToasts.size > 2) dismiss(first)`).
- **Measured:** `toast(err,'error'); toast('info one'); toast('info two')` leaves only the two infos. So "Recording
  didn't start…" or "That library could not be loaded…" can vanish at once under a pads-reconnected or MIDI toast.
- **Fix:** when trimming, evict the oldest toast of the lowest severity first (info/ok before warn before error).
- **Test:** unit-style ui-core. Error, then 2 infos: the error is still shown.

### P9 · minor · CONFIRMED: at more than 1250 px wide, short windows get less fader throw than the 1024 layout
- **Where:** `app/styles.css:606-611` (the clamp minimums 102 / 48 / 76, gap 10).
- **Problem:** at more than 1250 px wide the minimums are taller than the ≤ 1250 px fixed rows (94 / 50 / 74). So:

  | Window | Throw |
  |---|---|
  | 1366×700 | **115.8 px** |
  | 1340×700 | 115.8 px |
  | 1280×720 | 135.5 px |
  | 1440×720 | 135.5 px |
  | 1024×700 | 140.8 px |

  The polish-2A test checks "≥ 140 at 700" only at 1024. At 1366×768, 177 px is fine.
- **Fix:** add `@media (max-height: 740px) and (min-width: 1251px) { :root { --p-head-h: 94px; --p-bot-h: 74px;
  --p-gap: 10px; --p-pad-b: 12px } }`, or lower the clamp minimums to 94 / 46 / 72.
- **Test:** add [1366, 700] and [1280, 720] to VIEWPORTS with the ≥ 140 rule.

### P10 · minor · CONFIRMED: Sing it in… drops a saved octave transpose
- **Where:** `app/js/views/perform.js:785-790` (`singItIn`) and `:757` (`back.disabled = semis === 0`).
- **Measured:**
  - A song baselined with `transposeOctave: 1` shows Transpose "+12". The popover says "+12", and "Back to C" is
    enabled.
  - Pressing it sets the octave to 0, and Revert then shows "1 changed" (`transposeOctave`).
  - Tapping any key in the grid also discards the octave, because `singItInShift` is −6…+5 and the delta is taken
    against the total including 12·oct.
- The ordinary paths are right: +2 then Back, +7 (octave flip) then Back, and sing-G all count 1 → 0 and disable
  Revert.
- **Fix:** keep the current octave. The target total is `singItInShift(playIn, pc) + 12 * (s.transposeOctave || 0)`,
  and Back is disabled when `semis === 12 * oct`. Rarely hit: it needs a song saved with an octave transpose.
- **Test:** ui-core Sing-it-in test with `transposeOctave: 1` in the baseline.

### P11 · minor · CONFIRMED: the Quick sheet's fixed 178 px height overhangs the strips below 900 px tall
- **Where:** `app/styles.css:963`.
- **Measured:** at 1280×800 and 1366×768 the sheet's bottom is at 246 and the strips' top at 237–238, so it covers 8–9
  px of strip padding. The ON tiles are clear by 1–2 px.
- **Fix:** `height: calc(var(--p-head-h) + var(--p-gap) + var(--p-nav-h))`, which keeps it "exactly over the header +
  setlist rows" as the comment says.

### P12 · minor · CONFIRMED (by code): the wheel caption still says "Reverb"
- **Where:** `app/js/views/perform.js:74` (`'fx.reverb.returnGain': 'Reverb'`).
- **Problem:** polish-2B made "Space level" the one name (Edit, Settings learn table). Perform's wheel caption would
  read "→ Reverb".
- **Fix:** `'Space'` (or `'Space level'` if it fits the 76–92 px column; the caption ellipsizes).

### P13 · minor · SUSPECTED: `fitName` forces a layout on every store write
- **Where:** `app/js/views/perform.js:944` and `:1099-1109`.
- **Problem:** `renderSong` runs on every store change (each fader tick) and pushes `fitName`. That clears the font
  size, reads the computed style, and loops over `scrollWidth`, forcing a synchronous layout once per frame during
  drags. Not measured; the perf-profile agent may quantify it.
- **Fix:** push only when the name text changes (and from the ResizeObserver).

## Solid (verified, no action)
- ui-core 46/46.
- **Odd sizes.** 1100×750, 1600×1000 and 1024×900 (each with and without a banner, and with 2 or 4 filled strips),
  plus 1251×760, 1340×700 and 1341×700, have:
  - zero clipped or overflowing elements under the polish-2A probe;
  - no page scroll;
  - nothing cut by the viewport edge.
  - Throw: 190.8 at 1100×750 (182.8 with a banner), 356.7 at 1600×1000, 340.8 at 1024×900.
  - Container queries switch where they should: `pmain` ≤ 450 at 1100×750, `pfx` ≤ 600 at 1251, and the drone card
    at ≤ 390.
- **Step panels** at those sizes, plus 1280×720, 1440×720 and 1366×700:
  - steps are 45–77 px (never under 44);
  - the panel stays inside its strip;
  - it never covers the ON tile ('up' when there is room, else 'cover').
- **Listener leaks.**
  - 100 plain song switches: Δnodes 0 and Δlisteners 0 after a 3 s settle. There is a transient +7 per switch before
    retired voices and old DOM are collected.
  - Over 40 switches, the listener sets on window, document, controller, engine, midi and #view-perform do not change.
  - 100 step-panel and 100 Quick open/close cycles: Δ0.
- **Revert count.** The key counts once across hearIn / playIn / transposeOctave. +2 → 1, and Back → 0 (disabled).
  +7 (octave flip) → 1, and Back → 0.
- **Lock.**
  - KEY ▾ opens only with a hold.
  - Arrows on the focused drone grid and on Major/Minor are refused.
  - Synth / My Pads, Touch and Reversed are disabled.
  - `settings.view='edit'` bounces back to Perform.
  - Setlist chips are not draggable.
  - "Open Settings" on the library banners is withheld, and comes back after unlock.
- **Banner strip.** Esc with the strip open over Settings closes both, and Esc never panics.

## Prioritized fix list
1. P1: move the bottom-row hold captions above their buttons (Revert and unlock hints are invisible today).
2. P2: song-name line box ≥ 1.12 em plus padding rebalance (local L-20; unblocks the Mac fast suite). Test with a
   tall-metric font and no +1 slack.
3. P3: the Quick sheet reports the real audio state (paused / muted) and offers the right action.
4. P4: fold the banner strip when Settings opens; open-list z-index below the modal.
5. P6: under lock, hide or hold-gate "Use that library"; reconcile the LOCK table (pad Rescan, top bar, banners).
6. P5: per-popover disposer for Sing it in….
7. P7 and P8: toast hygiene (dismiss the pending toast on connect, one prompt hint, severity-aware eviction).
8. P9: short-wide windows: row minimums matching the 1024 layout at ≤ 740 px tall, plus viewports in the test.
9. P10, P11, P12: the octave in Sing it in…, Quick sheet height from the row variables, "Space" on the wheel caption.
10. P13 (optional): only re-fit the name on a rename or resize.
