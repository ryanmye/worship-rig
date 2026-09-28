# EQ amendment (from Ryan, after seeing the prototypes)

> "I like the EQ that is on the WING-Q mixer. Can we do something similar? Also don't just restrict to these — allow adding points etc."

WING-Q is the iPad remote for the Behringer WING console. Its channel EQ (per wing-docs.com/channel-eq/wing-eq): six fully
parametric bands on channels (L, 1–4, H; eight on buses), low and high bands are shelves by default and switchable to PEQ,
separate low/high cuts, big touch nodes on a graph with the RTA behind, tap a node to select it, drag to move, on/off per band.

## What changes vs DECISION.md

1. **Variable band count, Wing-style nodes.** Up to **8 bands per slot** (Wing bus count) plus a separate **low cut** and
   **high cut**. A band is a point on the graph; the user **adds** one by double-tapping (or double-clicking) empty graph
   space — it appears as a PEQ at that key/frequency with 0 dB and Q 1.0 — and **removes** one by dragging it off the bottom
   of the graph, pressing Delete/Backspace with it selected, or the ✕ on its table row. New songs start with two bands
   (a low shelf at ~120 Hz and a high shelf at ~6 kHz, both 0 dB) so today's presets keep meaning.
2. **Per-band type, switchable:** `off | lowshelf | peak | highshelf | notch | lowcut | highcut` (cuts are per-band types too
   so a user can add a second cut; the dedicated cut rows stay for simplicity). Switching type must not click: fade the
   band's contribution out over 30 ms, swap, fade in (engine).
3. **Interaction (from WING-Q):** large numbered nodes (≥ 40 px touch target), selected node shows Q "wings" (two side
   handles you drag apart/together; pinch on touch; wheel with modifier on desktop), drag = freq × gain, shift-drag = fine,
   double-click node = 0 dB, band on/off toggle in the row and via long-press; RTA/analyser behind the curve; the piano
   axis + Hz ruler, greyed zones, overtones zone, typed cells, paste box and presets from the "curve" prototype all stay.
   Keep the "Acts on: notes C3–D4" readout — that's the part the WING doesn't have and Ryan asked for.
4. **Param model (PARAMS-compatible, scalar paths):** `slots.<i>.eq.b<k>.on` (bool), `.type` (enum above), `.hz`
   (20–20000, log), `.db` (−15..+15), `.q` (0.1–10, log) for k = 1..8; `slots.<i>.eq.cutHz` (20 = off) and
   `slots.<i>.eq.hiCutHz` (20000 = off). Unused bands are `on:false` and absent from the stored song (optional fields).
   Back-compat: existing `eq.low` / `eq.high` (dB shelves at 120 Hz / 6 kHz) keep working — the engine treats them as
   b1 (lowshelf) / b8 (highshelf) when the b-rows are absent, and the UI migrates them into b1/b8 on first edit.
5. **Engine:** 8 k-rate biquads per slot + 2 cuts; `on:false` or 0 dB peaks/shelves are identity (no bypass node needed);
   cuts use the dry/wet crossfade bypass from DECISION.md. CPU budget: ≤ 2.5 % of one core for 4 slots static.
   `getEqResponse(slot, freqs)` and `getSlotPlayRange(slot)` as in DECISION.md.
6. **Presets:** Flat, Warm, Air, Cut mud (Bass), plus "Wing channel" (L shelf, 4 peaks, H shelf, all 0 dB — the WING
   default layout for people who think in those terms).

Everything else in DECISION.md stands (Hz storage, k-rate, low-cut crossfade, Edit placement in H-v2 Advanced → Tone,
mini curve in the panel header, Brightness/Warmth simple mode driving the two shelves).
