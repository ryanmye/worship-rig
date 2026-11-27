// UI6-cvd O1 (CVD2; native DECISIONS D32): where each range bar's instrument number goes, so no two numbers stack.
// Pure geometry (no DOM): views/components/cvd-badges.js measures the bars and applies the result as --cvd-x.
//
// Before, CSS placed the badge at 2 px + i × 16 px from the bar's start, clamped into the bar (skeptic UI6-cvd F1).
// CSS can't see the other bars: two short bars with the same range at positions 9+ clamped to the same spot ("10" on
// "16"), and slivers at the keyboard's edge stacked their numbers at x = 0. Here every badge is placed in turn
// (number order), at the spot nearest that same staggered start which overlaps no badge already placed on a row it
// touches: first wholly on the visible part of its own bar; then (a bar shorter than its badge, or crowded) still
// touching its bar; then anywhere on the keyboard, nearest its bar. Only if the keyboard is full does a badge sit at
// its preferred spot over another.

/** Badge sizes (styles.css `.rbar[data-slot]::before`): 13 px tall plus the 1 px ring; one digit 14 px, two 20. */
export const BADGE_H = 15;
export const BADGE_GAP = 2;
export const badgeWidth = (i) => (i + 1 >= 10 ? 20 : 14);

/**
 * Place the range bars' number badges.
 * @param {{i:number, L:number, R:number, y:number}[]} bars  i = the instrument's position (0-based); L / R = the bar's
 *   ends and y = its centre line, px in the bars box (L / R may lie outside 0..W: a range past the keys shown)
 * @param {number} W  the bars box's width (px)
 * @param {{start?:number, step?:number, edge?:number}} [o]  start / step: the preferred stagger (2 px + i × 16 px from
 *   the bar's start); edge: how far a badge that can't fit on its bar must still reach onto it (px)
 * @returns {Map<number, number>} i → the badge's left edge, px from its bar's start (L)
 */
export function placeBadges(bars, W, o = {}) {
  const start = o.start ?? 2;
  const step = o.step ?? 16;
  const edge = o.edge ?? 4;
  const width = Math.max(0, Number(W) || 0);
  const placed = []; // {x, w, y}
  const out = new Map();
  const list = bars.filter((b) => b && Number.isFinite(b.L) && Number.isFinite(b.R) && Number.isFinite(b.y))
    .slice().sort((a, b) => a.i - b.i);
  const clashes = (x, w, y) => placed.some((p) => Math.abs(p.y - y) < BADGE_H
    && x < p.x + p.w + BADGE_GAP && p.x < x + w + BADGE_GAP);
  for (const b of list) {
    const w = badgeWidth(b.i);
    const visL = Math.max(b.L, 0);
    const visR = Math.min(b.R, width);
    const pref = b.L + start + b.i * step;
    const e = Math.min(edge, Math.max(0, visR - visL));
    const tiers = [
      // on the visible part of its bar (a bar shorter than it: at its start, or its end at the keyboard's right edge)
      [Math.min(visL, width - w), Math.min(Math.max(visL, visR - w), width - w)],
      [Math.max(0, visL - w + e), Math.min(width - w, visR - e)], // reaching at least `edge` px onto it
      [0, Math.max(0, width - w)], // anywhere on the keyboard
    ];
    let x = null;
    for (const [lo, hi] of tiers) {
      if (hi < lo) continue;
      const near = Math.min(hi, Math.max(lo, pref));
      const cands = [near, lo, hi];
      for (const p of placed) {
        if (Math.abs(p.y - b.y) >= BADGE_H) continue;
        cands.push(p.x + p.w + BADGE_GAP, p.x - w - BADGE_GAP);
      }
      const ok = cands.filter((c) => c >= lo - 1e-6 && c <= hi + 1e-6).sort((a, c) => Math.abs(a - pref)
        - Math.abs(c - pref) || a - c).find((c) => !clashes(c, w, b.y));
      if (ok !== undefined) {
        x = ok;
        break;
      }
    }
    if (x === null) x = Math.min(Math.max(visL, pref), Math.max(0, width - w)); // the keyboard is full
    placed.push({ x, w, y: b.y });
    out.set(b.i, Math.round((x - b.L) * 10) / 10);
  }
  return out;
}
