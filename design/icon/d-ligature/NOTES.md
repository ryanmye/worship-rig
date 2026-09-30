# D · Ligature

**Idea.** W and R share one stem. The W is drawn as an upturned M, |/\|: two upright stems joined at the baseline by a
pointed notch. That's also the sustain-pedal bracket from piano scores (down, hold, re-pedal, up), so the musical cue
is built into the letter and adds nothing to the mark. Drawn as mitred stroked centre-lines, no font.

**Palette.** Plum tile #2a1d44 → #140c24 (Sanctuary #100a1c/#191327, lifted one step to hold on a dark Dock).
Brass #f4d48a → #e6ba65 (Sanctuary accent). The mono glyph is #000 on transparent.

**16 px checks.** v1 used round-bottomed U's with a note-head on a short middle stem. It read as "ωR"/"LuR";
the head clotted. Switched to the pointed W, raised the stroke to ~1.4 px at 16, and widened the R bowl because its
counter had closed. Mono uses heavier strokes (104).

Regenerate: `node design/icon/d-ligature/build.mjs`.

## Phase 2 (picked)

**Refine.** Following the critique, the R's leg is now its own lighter stroke (74 vs 86; 90 vs 102 in mono). Counters
are more open: the stems are 392 apart, the notch apex sits at 458 and the bowl is 100 radius, 66 wide. 16 px was
re-rendered and checked, and it still reads as WR.

**Exports** (`build.mjs --export`):
- `build/icon.png`: 1024.
- `build/icon.icns`: iconset 16 to 512 @1x/@2x, via `iconutil`.
- `build/trayTemplate.svg`: the mono master. `build/make-tray-icon.mjs` now rasterises it with Chromium, 8×8
  supersampled, into the 22 and 44 px PNGs.
- `docs/site`: favicon-16/32 (squircle crop) and a full-bleed apple-touch-icon at 180.

`tray-base64.txt` holds the TRAY_ICON_1X/2X strings for main.js.

**Dock check.** Both displays had full-screen spaces, so no Dock was drawn and a region capture only showed an editor.
`../dock-check.png` is instead the icon macOS reports for the running app (`NSRunningApplication.icon`, the
image the Dock draws). It is the new W·R.
