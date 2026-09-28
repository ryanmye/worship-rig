# H-sheet: implementation plan

**Rule:** this is presentation only. The one behaviour change is the same as H's (the lock scope; H concept §4).

- Every control writes the same `store.set(path, v)` or `controller.*` it writes today.
- There are **no new store fields, no new PARAMS rows and no engine changes**.
- The sentence is a **pure function** of the song (`describeLine()`), and it is never stored.

**Effort: L overall. It ships in two halves that don't depend on each other.**

| Half | Effort | Notes |
|---|---|---|
| **Perform + Quick + lock rule** | M | Identical to `design/H/implementation.md` §1–3. Nothing here changes it. |
| **Edit as a song sheet** | L (a light L) | `edit.js` is 1,748 lines. The sheet *reuses* most of its section builders and bind helpers; what's new is the line shell and the sentence module. It's smaller than H's Edit, because it has no rig map, no SVG wiring and no focus-panel routing. |

---

## 1. Shared pieces (do first; most are shared with H's Perform)

| Piece | Where | What | Tests |
|---|---|---|---|
| `onTile` | `views/components/onTile.js` (new; H §1) | Used by the Perform strips **and** the sheet lines. A `size: 'strip' \| 'line'` option sets 46 px vs 38 px. | aria-pressed mirrors `muted` |
| `stepPanel` | `views/components/stepPanel.js` (new; H §1) | Adds `anchor: 'strip' \| 'word'`. `'word'` positions it under an element with a caret, and still uses `role="group"` + `data-perform-overlay` semantics. `steps: [{ value, label, word }]` renders the word on the right. | A step tap writes the path and closes the panel; the panel stays inside `.sheet`'s rect |
| `wordSlider` | `views/components/wordSlider.js` (new; H §1) | A styled `<input type=range>` with a name, word + number, and end words. `bipolar` fills from the centre; double-click resets. It writes on `input` (live sound) and fires `change` for the sentence re-render. | word buckets; bipolar fill |
| `shared/sheet-words.js` | new, **pure** (no DOM) | `describeLine(kind, state, meta) → tokens[]`, where a token is `{ text }` or `{ text, path, ctl: 'steps' \| 'toggle' \| 'list' \| 'instrument' \| 'range' \| 'focus', tone: 'slot' \| 'fx' \| 'warn' }`. `wordFor(kind, v)` gives the buckets (Off/dry, 25/a little, 50/half, 75/mostly, 100/all the way). `hiddenDefaults(slot) → ['octave', 'chorus', …]` lists the settings the Advanced summary shows first. It extends H's `describeSlot()` with drone / hands / effects. | node:test tables: default slot → the shortest sentence; each non-default field adds exactly one phrase; **every token's `path` is a valid PARAMS/store address**; buckets round-trip (25 → "a little" → the 25 step is lit) |
| `shared/smart-controls.js` | new (H §1) | `smartSlidersFor(meta)` (3 per sound, one param each). The sheet adds `droneSliders`, `handsSliders` and `fxSliders`, which are fixed lists. | each slider maps to exactly one path |

`components/index.js` and `_fallback-components.js` must export and mirror the new components (the same obligation as
in H).

## 2. Edit (`app/js/views/edit.js`, `app/styles-edit.css`)

The library column (`renderList`, `songRow`, setlists, import/export: lines 545–935) and the song-head fields
(`renderReset`, `keySelect`, the tempo/tap, and the notes section at about lines 1014–1100) **stay as they are**.
They're restyled into H's header chips. Only the centre and right columns are replaced.

| Change | How |
|---|---|
| **Sheet container** | `section.ed-sheet`, a flex column with `overflow-y: auto`. Seven `sheetLine(kind, i?)` children: slots 0–3, drone, hands, fx. `openLine` is **view state** (persisted in the existing `readSections/writeSections` localStorage, like today's section open state). |
| **`sheetLine()` shell** | `[onTile][sentence][level][chevron]` + a lazily built body + an Advanced fold. It **reuses `bindCtl` / `bindFn` / `destroyGroup`** with a group per line (`line:0` … `line:fx`), so closing a line disposes its bindings the same way today's collapsed `section()` does. |
| **Sentence** | `bindFn(group, rels, render)`. It renders `describeLine()` tokens: plain text → text nodes; control tokens → `<button class="w">` with `data-path`. A click dispatches on `ctl`: `steps` → `stepPanel({ anchor: 'word' })`; `toggle` → `store.set(path, !v)`; `list` → a small `segmented` popover; `instrument` → the existing `pickerOptions()` list in a popover (plus **Remove this sound…** as the last item, from H); `range` / `focus` → open the line and focus the bound control. It re-renders on store change, but **not while a word slider in the same line is being dragged** (it waits for `change`). |
| **Level** | the existing `fader` component (horizontal), bound to `slots.i.gain` / `drone.gain`. |
| **Sound body** | `wordSlider` × 3 from `smartSlidersFor(meta)`, plus *Where it plays* = the existing `miniKeyboard` range code (lines 1270–1300) + "Set lowest/highest…" (arm a one-shot on the controller note-on; from H). |
| **Sound Advanced** | Move the rest of today's `buildSlotBody()` rows into three columns: Mix (Chorus, `pan`, `width`, `eq.high`) · Playing (`octave`, `transpose`, `mono`, `velocityCurve` (with its curve spark), `bendEnabled`) · *engine* (instrument params not mapped to a slider, via `formatInstrumentParam`). The summary line comes from `hiddenDefaults()` + today's `slotSummary()`. |
| **Drone line** | Today's drone section (lines 1422–1455) split up: tile (off ↔ last source, from H), words, 4 sliders, and Advanced (chord follow, relative-major file). |
| **Hands line** | Today's "Wheels & pedals" section (lines 1385–1405). The From/To pairs become one two-handle `wordSlider` each (**or** two single sliders if a two-handle range is too much work: S). The CC7 row goes into Advanced. |
| **Effects line** | Header chips: move `presetPicker('space' \| 'echo' \| 'vibe')` (line 1460) into chip rows styled like Perform's header chips, including the dashed-nearest class and **Song's own** (H §2). Sliders: `fx.reverb.size`, `fx.reverb.returnGain`, `fx.delay.feedback`, `fx.chorus.depth`. "Who goes in" is read-only words from `describeLine('slot')` send tokens, which open the same step popover. Advanced: the rest of today's FX column (reverb/delay/chorus/lofi/eq/comp/master rows). |
| **Keyboard row** | From H: range bars (display only; the open line's bar is bright, the others at 35 %), output meter, Fade out, PANIC ⌘. |
| **Delete** | today's slot cards (`makeCard`, `syncCard`, `curveSpark` moved into Advanced) and the right FX column layout. The bindings survive; the containers change. |
| **CSS** | `styles-edit.css` (367 lines) is mostly replaced. The tokens come from `styles.css`, as H's Perform does, so the two views share colours by construction. |

### Esc and popovers in Edit
Edit keeps today's rule: **Esc never panics in Edit** (ux.md M1). Esc closes a word popover, then blurs. PANIC is the
on-screen button plus ⌘ . That is unchanged from H.

## 3. Tests

- **`sheet-words` unit tables** (node:test). For each of the 5 line kinds:
  - the default-state sentence;
  - each field alone at a non-default value;
  - buckets at 0/12/25/37/50/…/100;
  - every factory song: no sentence exceeds 110 characters at 1440 or wraps past 2 lines at 1024. That makes the
    unverified "fits" claim in concept §6 a test.
- **Round trip:** for every control token in every factory song, clicking it opens a control bound to `token.path`,
  and moving that control changes the store path **and** the rendered word.
- **Perform parity:** tapping a send word opens the same steps as the Perform chip for that slot (same `steps` array),
  and a step tap writes the same value.
- **Nothing lost:** every PARAMS address used by a factory song (the same test as H §5) is reachable in ≤ 2 clicks
  from the sheet (line or word → Advanced).
- **Geometry (Playwright):**
  - 1024×700: the first three lines are fully inside `.ed-sheet` with KEYS open (measured in the mockup: all 7 are);
  - at 1440×900, 7 lines with KEYS open don't overflow;
  - the word popover stays inside the sheet at both sizes.
- **Drag doesn't reflow:** during a word-slider `input`, the sentence DOM doesn't change; on `change`, it does.
- Update the ui-edit Playwright selectors. Keep the `data-testid`s on controls that bind the same path.

## 4. Order

1. `sheet-words.js` + tests (you can test it with no UI), plus `onTile` / `stepPanel(anchor)` / `wordSlider`.
2. `sheetLine()` shell + slot lines (sentence, level, body, Advanced). Delete the slot cards.
3. Effects line (chips + Song's own + sliders + Advanced). Delete the right FX column.
4. Drone and Hands lines.
5. The keyboard row, the 1024 pass, screenshots, and `## ui-sheet` in CONTRACT_CHANGES.md.

Perform (H §2–3) can land before, after or in parallel. The two halves share only the components from step 1.

## 5. Risks

- **Concurrent agents are editing `app/`.** `edit.js` is a conflict hotspot. Land it line kind by line kind (step 2 → 4),
  each behind the old layout until the last one lands.
- **Copy is code.** A wrong bucket word misstates the sound. Keep all wording in `sheet-words.js`, with tables, and
  have a volunteer read the 10 factory songs' sheets aloud before shipping. *[untested]*
- **Re-render churn.** The sentence re-renders on every store change in its line. It's cheap (under 20 tokens), but it
  must not rebuild the open popover's anchor. Key tokens by `path` and patch the text in place.
- **The two-handle range slider** for the Hands From/To ranges is the only new control shape. If it slips, use two
  single sliders (the fallback in §2).
- **The lock scope and fader throw** are H's risks, not this proposal's.
