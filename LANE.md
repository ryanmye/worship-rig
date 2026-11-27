# LANE.md: skeptic for U-CVD (D32 Colour-blind colours), lane-cvd

Brief: try to break U-CVD (Settings › Look › Colour-blind colours Off / Red–green / Blue–yellow). Check:
- the palette claims (an independent Machado + OKLab check, inks);
- that Off is exactly today (computed styles, purity, slotColor ≥ 7, canvases);
- device-local, the mirror and boot.js;
- the live toggle;
- the number badges (overlap, iPad, a11y);
- the Settings rows;
- the rebase interactions.

Fix real defects with tests that fail first. Write native/docs/reviews/UI6-cvd.md. Commit on lane-cvd only. Run the
gates one at a time with tools/cloud/gates.mjs. Report: verdict, findings + commits, gates, open items, not
verified, lane tip.

## Steps
- [x] Read CLAUDE.md, D32, CONTRACT_CHANGES U-CVD, themes README, the lane diff; check the orchestrator's rebase
  (36ef998): both sides kept, no markers
- [x] Palettes: cvd-check rerun + independent script (/tmp/cvdsk/check.mjs): all 16 pass, numbers match; ON-window
  inks match Chromium
- [x] Off = base: computed styles + canvases, 8 themes × today / v6 × Perform / Edit / Settings (only the new row's
  height differs)
- [x] On: every theme × type × UI resolves --slot-0..15 to the palette, numbers on bars / strips
- [x] Device-local / import / migrate / mirror (code + builder tests)
- [x] Badges: split ranges, iPad sizes, 16 instruments, a11y tree → F1, F2
- [x] Live toggle canvases → F3
- [x] F1–F3 fixed with tests that fail first (commit 31b0f09 after the rebase)
- [x] Rebased onto c10ad59 (CONTRACT_CHANGES conflict: both sides kept)
- [x] Gates on the c10ad59 tree (chain): shell-unit / unit fail only on non-lane flakes (see below); ui-v6 90/90,
  ui-v6-edit 43/43, ui-v6-ipad 29/29, ui-v6-bank 23/23, settings 115/115, ui-core 78/78, themes rc 0
- [x] edit-v2 14/14 files, ui-v6-themes 30/30 clean in 2253 s (c10ad59 tree; logs /tmp/cvdsk/gates2/)
- [x] Rebased onto origin/v2-native 937a04a (tools/cloud only; app/ and test/ are byte-identical to the gated tree)
- [x] gates.mjs shell-unit,unit,ui-v6,ui-v6-edit with UI6_PURITY_BASE=origin/v2-native (the default merge-base is
  the stale local v2-native 36ef998)
- [x] Gates table and verdict (PARTIAL) in the review; committed; hand back

## Findings
- F1 (fixed): a range-bar number floated past the end of a short bar (stagger i × 16 px) → clamped to the bar.
- F2 (fixed): the numbers were read by screen readers ("2 Warm Pad", "1 2 3…") → empty alt text in @supports.
- F3 (fixed): EQ / mini curve / response-curve canvases kept the old colour after a live toggle → onThemeChange
  also watches html's class; the spark redraws on it.
- O1: numbers still collide on same-range short bars at positions ≥ 9 (needs JS placement).
- O2: dark themes' palettes are light pastels / near-white (design).
- O3: Sanctuary Day's palettes are very deep (design).
- O4: thin ΔE margins, model-specific (gamma-space variant: 12/16 < 10).
- O5: on a 16-tab Edit row, the changed dot covers a two-digit number.
- O6: a muted bar's number stays coloured.
- O7: a stale mirror flashes cvd colours.
- O8: screen-reader numbers are a design call.
- Non-lane: shell bank-trial "skeptic F1–F3" fails in the full file on old and new base trees (passes alone);
  unit importer-host "progress snapshots" flakes under load (load avg 13).

## Next step
Done: hand back to the orchestrator.
