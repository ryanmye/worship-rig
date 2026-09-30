# App icon: four original directions (2026-09-30)

Four agents each drew one direction from the same brief (macOS squircle, 1024 master, must read at 16 px, a mono
template tray variant, palette compatible with the dark themes and Daylight Day). `options.png` is the contact sheet
(512 on dark and light, 32, 16, tray on light and dark). Each folder has `icon.svg`, `mono.svg`, previews, a build
script and `NOTES.md`. Nothing is traced or copied; all letterforms are drawn paths. `sheet.mjs` rebuilds the sheet.

## Critic pass (Fable, on the contact sheet)

**A · Lancet window** (`a-lancet/`). The in-app mark itself, grown up: brass arch, candle oculus, four leaded panes,
warm wall glow. Strongest continuity with the top bar and the popover. Problem: at 32 and 16 px the four panes collapse
into an orange/green/blue/purple 2×2 grid, which reads as a well-known OS logo. Fix before shipping: drop to two glass
colours (e.g. amber + violet) or make the leading asymmetric (three panes, or a tall centre light), and keep the brass
frame heavy. The mono tray glyph (arch with strokes) is good.

**B · Swell** (`b-waves/`). A sustained note's envelope as three stacked ribbons, brass on top. Clean, reads at 16 px,
theme-safe. Weakness: generic; the silhouette is close to signal/sleep glyphs, and the tray version reads as Wi-Fi.
Nothing about it says keys, church or room.

**C · Lit room** (`c-room/`). A doorway of light in a plum room, spill across the floor. The most atmospheric at 512 and
the best fit for the Sanctuary/Daylight mood. Weakness: at 16 px it is a bright rectangle with a smear below it (door,
exit sign, projector), and the tray glyph looks like a desk lamp. Identity lives in the glow, which is exactly what
small sizes lose.

**D · W·R ligature** (`d-ligature/`). W and R sharing a stem; the pointed W is the sustain-pedal bracket from piano
scores. Most legible of the four at every size, most distinctive silhouette, unambiguous in the tray. Weakness: it is
a monogram, so it carries less feeling than A or C; the R's leg is heavy and the counters could open a little.

## Ranking and recommendation

1. **D** if you want the crispest product mark (Dock, tray, favicon all read instantly).
2. **A** if continuity with the in-app mark matters more; it needs the pane-colour fix first.
3. C, 4. B.

A hybrid is also possible: D in the Dock and A's arch kept as the in-app mark (they share the plum/brass palette).

## Phase 2 (after Ryan picks)
iconset 16…1024 @1x/@2x → `build/icon.icns` via `iconutil`, `build/icon.png` 1024, `build/trayTemplate{,@2x}.png`
from the mono variant, favicon 32/180 for `docs/site` and `app/mini.html`, `app/assets/mark.svg` only if A wins.
Rebuild, check Dock/Finder/tray, report ICON_OK with a screenshot.
