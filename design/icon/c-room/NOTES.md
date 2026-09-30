# C · Room

**Idea.** A dark room at dusk with one opening lit: a stage door or sanctuary doorway, brass jamb, warm light
spilling across the floor toward you. Music is about to start.

**Palette** (from `app/js/shared/themes.js`): wall `#191327`→`#100a1c` and floor `#0c0716` (Sanctuary plum);
opening `#fdfbf7`→`#f5ecd8`→`#f4b73f` (Daylight Day paper and amber); jamb and halo `#e6ba65`, bloom `#f6c35a` (brass).

**16 px check.** In v1 the opening was small and the spill faded to mud, so it read as a dim dot. In v2 I widened the
opening (352→388 px) and brightened the top of the spill. v3 swapped a heavy flat brass border for an 8 px jamb and a
blurred bloom. At 16 px it reads as a bright block with a column of light under it on a dark squircle.

**Mono.** The opening over its trapezoid spill, solid black, pixel-aligned at 22 px. `make.mjs` renders
the previews.
