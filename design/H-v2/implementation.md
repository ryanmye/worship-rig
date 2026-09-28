# H-v2: implementation plan

The rules are the same as H: presentation only, plus the one lock-scope behaviour change (concept §1.3), which needs
Ryan's OK.
- **No new store fields, no new PARAMS rows, no engine code.**
- The one new controller wrapper is still `transposeTo(pc)`.
- **H/implementation.md still applies.** This file lists only the deltas and the file mapping.

**Effort: L overall. It ships in two independent halves, Perform first.**

| Half | Effort | vs H |
|---|---|---|
| Perform + Quick + lock rule + changed dots | **M** | Same as H, plus S for the baseline/dot module. The colour fix is CSS only |
| Edit: tabs + panels + Show wiring + Effects tab | **L**, lighter than H's | The tab row is simpler than the SVG map, and H's three FX panels become one Effects panel. `edit.js` (1,748 lines) is still restructured |

## 1. File mapping

| Piece | File(s) | What | Size |
|---|---|---|---|
| `onTile` | new `app/js/views/components/onTile.js`; export in `components/index.js`; mirror in `views/_fallback-components.js` | Solid slot-colour fill when on, grey + `text-decoration: line-through` when off. `aria-pressed` = on. Used by the 4 strips, the drone, and Edit's On stage | S |
| `modChip` | new `components/modChip.js` (+ index, fallback) | `kind: 'amount' \| 'steps' \| 'toggle'`, `lit`, `changed` (renders the inline `.cdi` dot). The tint comes from `--c` | S |
| `stepPanel` | new `components/stepPanel.js` | As in H, plus `loaded` → the "as loaded" line on that step and an optional `footnote` ("Starts on your next note") | S |
| `holdButton` | new `components/holdButton.js` | Lifted from perform.js:353–428 (the Lock hold). Adds a `--hold` progress custom property for the rising fill | S |
| **Baseline + dots** | new `app/js/shared/song-diff.js` (pure) + perform.js | `changedPaths(song, base, watch)` → a Set of store paths that differ. `watch` = the switch-type paths: `patch.slots.i.{muted,sends.reverb,sends.delay,sends.chorus,octave,sustain,instrument}`, `patch.fx.reverb.*` / `patch.fx.delay.*` as a group, `hearIn`, `playIn`, `tempo`, `patch.swell.seconds`, drone key/minor/mode. **Gains and levels are excluded.** `base` = perform.js's existing `snap.song` | S |
| Share the baseline with Edit | perform.js returns it (`get savedSnapshot()` already exists at perform.js:886) → main.js passes a getter into the Edit view ctx | Edit reads it, never writes it. No store field | S |
| Revert count | perform.js `renderRevert()` (perform.js:627) | `n = changedPaths(...).size`; the label shows "● n changed". Disabled when `n === 0 && savedJSON` is equal (as today) | S |
| Strip, header chips, drone tile | `app/js/views/perform.js`, `app/styles.css` | As H §2, with the new tile/chip CSS. The empty-slot column is neutral grey. The Echo/Space chips get a `hint` line (copy in concept §1.5 4a). **Delete the dashed "nearest preset" class** | M |
| 2-chip option | perform.js: one const `STRIP_CHIPS = 4` | With 2: render Space/Echo chips only, plus tag-line badges for Octave ≠ 0 and Sustain off | S |
| Lock table | perform.js, `quick.js` | H §2 "Lock rule", with the table from concept §1.3. Revert and KEY go through `holdButton(600)` while locked. Tooltip and Lock label copy: "playing stays live / hold to unlock" | S |
| Quick sheet | new `app/js/views/quick.js` | As H §3. Only the tempo hint changed (a fixed echo doesn't follow) | M |
| Edit tab row | `app/js/views/edit.js`, `app/styles-edit.css` | `rigTabs(selected)`: 5 sound tabs + a spacer + Effects + Master. Each tab: `--tc`, role, sound name (`stageName()`), playing LED from held notes, off state from `slotMuteState`, a dot when `changedPaths` has any path under that slot/fx. The selected tab is `aria-selected`; arrow keys move between tabs (the tablist pattern) | M |
| Show wiring | edit.js | A CSS grid with the same columns as the tab row. The cells read `sends.reverb/delay/chorus` (×100, rounded) and the drone shows "fixed". **The toggle state is a view-local variable**, not persisted | S |
| Sound panel | edit.js | As H §4 (sentence, On stage, word sliders, Where it plays, Advanced). The changed dot goes into `describeSlot()` tokens as a `changed` flag | L (the bulk) |
| Effects panel | edit.js | Replaces H's separate Space/Echo/Chorus panels. Three `fxLine`s: the sentence (a preset name, or "the song's own" when `matchPreset` returns null), preset chips over `SPACE_PRESETS` / `ECHO_PRESETS` (existing `applyPreset`), a Fine-tune disclosure (word sliders over `fx.reverb.size/damp/predelay/returnGain`, `fx.delay.time/feedback/tone/returnGain`), and "How much of each sound goes in" as 3 `modChip`s bound to `slots.i.sends.<unit>`, with the same `stepPanel`. Chorus has 2 word sliders (`fx.chorus.depth`, `fx.chorus.rate`) | M |
| Master panel | edit.js | H's Tape (`fx.lofi.*`) + Master (`fx.eq`, `fx.comp`, `master.volume`) panels, merged | M |
| Wheels & pedal | edit.js | H's Keyboard panel (wheel/expression/CC7/bend routing, bend range, swell time), opened from the link | S (moved) |
| Esc | `app/js/main.js` (about 5 lines) | Unchanged from H: Perform overlays are `role="group"` + `data-perform-overlay`, and Esc = panic + close | S |

## 2. Tests (in addition to H §5)
- **song-diff (node:test):** changing a slot gain → no path. Changing `sends.reverb` → exactly that path. Applying a
  space preset → one grouped `fx.reverb` entry. Reverting → an empty set.
- **Revert count:** load a song, move the Keys fader and tap Pad Space 75 → the label reads "1 changed". Revert → 0,
  and the button is disabled.
- **Colour contract (Playwright):**
  - An ON tile's computed `background-color` equals its slot colour.
  - An OFF tile's is `#272b32` and its name has `text-decoration-line: line-through`.
  - No element under `.strip` uses `--warn` unless `.perform.locked`.
- **50 % legibility (Playwright + pixel check):** at 1024×700 with `deviceScaleFactor: 0.5`, an ON tile's mean luma
  is at least 2× an OFF tile's (the mockup measures 155 vs 53).
- **Tabs:** the arrow keys move the selection; the selected tab's panel is labelled by the tab (`aria-labelledby`).
- **Show wiring:** each lane value equals `Math.round(sends.<unit> * 100)` for its slot, and toggling it doesn't write
  the store.
- **Effects "who goes in" chips** write the same path as the Perform strip chip, and the step panel stays inside its
  column at 1024.
- **Throw:** assert the `.vf-track` height ≥ 240 px at 1440×900 (4 chips) or ≥ 290 px (2 chips).

## 3. Order
1. `song-diff.js`, `onTile`, `modChip`, `stepPanel`, `holdButton`, and the Esc exemption, with their tests.
2. Perform: the new tile/chip CSS, the chips, the header chips with hints, the Revert count, and the 2-chip const.
3. The Quick sheet, plus the lock table **only if Ryan OKs it**. Otherwise chips go `disabled` under lock like today's
   pickers. **Shippable after step 3.**
4. Edit: the tab row plus the Keys/Pad/Bass/Drone panels (sentence, On stage, word sliders, range).
5. Edit: the Effects + Master panels, Wheels & pedal, Show wiring. Then delete the old right FX column and slot cards.
6. The 1024 pass, screenshots, and `## ui-hybrid` in CONTRACT_CHANGES.md (the lock table + the changed-dot definition).

## 4. Risks
- **Concurrent agents are editing `app/`.** perform.js and edit.js are conflict hotspots. Land this after their merges.
- **The baseline re-snaps on leaving Edit** (today's perform.js:539–540 behaviour), so the dots clear after an Edit
  visit. That's fine for Sunday use (you don't visit Edit mid-set), but the Edit footer copy should say "since the
  song was loaded or you last left Edit" if testers trip on it.
- **The lock-scope change needs sign-off.** It's isolated in one `LOCK` table and can be reverted without layout
  changes. ui-core tests asserting "X disabled when locked" need updating.
- **Fader throw:** 250 / 143 px with 4 chips, 302 / 189 px with 2 (the mockup measured it; the real CSS may differ by a
  few px). Today's is ≈ 315 px.
- **`color-mix()`** is used for the chip tints. That's fine in Electron 44 / current Chrome; the Chrome-fallback
  minimum version should be checked.
- **Tabs hide the at-a-glance "what's sounding" view** that the map gave. The tab LEDs (from held notes) and the
  keyboard range bars cover most of it, and Show wiring covers the rest.
