// UI6-cvd O1 (CVD2): shared/cvd-badges.js placeBadges, the range-bar number placement. Geometry only: the badges of
// rows that touch never overlap, each badge stays on (or, for a bar shorter than it, touches) its own bar, a long bar
// keeps the old stagger (2 px + i × 16 px), slivers at the keyboard's edge don't stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeBadges, badgeWidth, BADGE_H, BADGE_GAP } from '../../../app/js/shared/cvd-badges.js';

/** Rows as keyboard.js lays them out: n bars in H px, pitch ≤ 10, the centre lines. */
const rowsY = (n, H = 26) => {
  const pitch = Math.min(10, H / n);
  const thick = Math.max(1.5, Math.min(7, pitch * 0.7));
  const top0 = H - ((n - 1) * pitch + thick);
  return Array.from({ length: n }, (_, r) => top0 + r * pitch + thick / 2);
};
function check(bars, W, at, { onBar = true } = {}) {
  const pos = placeBadges(bars, W);
  const boxes = bars.map((b) => ({ i: b.i, x: b.L + pos.get(b.i), w: badgeWidth(b.i), y: b.y, b }));
  for (const a of boxes) {
    assert.ok(a.x >= -0.01 && a.x + a.w <= W + 0.01, `${at}: ${a.i + 1} inside the keyboard (${a.x})`);
    const visL = Math.max(a.b.L, 0);
    const visR = Math.min(a.b.R, W);
    if (!onBar || (onBar === 'first' && a.i >= 2)) {
      // more numbers than the bars' room: none stacks, each as near its bar as the others allow
    } else if (visR - visL >= a.w) {
      // (placeBadges rounds to 0.1 px)
      assert.ok(a.x >= visL - 0.06 && a.x + a.w <= visR + 0.06, `${at}: ${a.i + 1} on its bar`);
    }
    else {
      assert.ok(a.x < visR && a.x + a.w > visL, `${at}: ${a.i + 1} touches its short bar`);
    }
    for (const c of boxes) {
      if (c === a || Math.abs(c.y - a.y) >= BADGE_H) continue;
      const apart = a.x + a.w + BADGE_GAP <= c.x + 0.01 || c.x + c.w + BADGE_GAP <= a.x + 0.01;
      assert.ok(apart, `${at}: ${a.i + 1} and ${c.i + 1} overlap (${a.x.toFixed(1)}, ${c.x.toFixed(1)})`);
    }
  }
  return boxes;
}

test('long bars keep the old stagger (2 px + i × 16 px from the bar start)', () => {
  const y = rowsY(8);
  const bars = y.map((yy, i) => ({ i, L: 0, R: 1000, y: yy }));
  const pos = placeBadges(bars, 1000);
  for (const b of bars) assert.equal(pos.get(b.i), 2 + b.i * 16);
  check(bars, 1000, 'long');
});

test('16 instruments, split and identical short ranges: no number stacks (skeptic UI6-cvd O1 case)', () => {
  for (const W of [700, 900, 1180]) {
    const y = rowsY(16);
    const oct = W / 7.4; // ≈ one octave of 52 white keys
    // pairs of identical one-octave ranges across the keyboard, positions 9+ included
    const bars = y.map((yy, i) => {
      const k = Math.floor(i / 2) % 7;
      return { i, L: k * oct, R: (k + 1) * oct, y: yy };
    });
    check(bars, W, `pairs at ${W}`);
    // three on one octave (a split song's doubled layer): on their bar, apart
    check(y.slice(9, 12).map((yy, k) => ({ i: 9 + k, L: 3 * oct, R: 4 * oct, y: yy })), W, `three at ${W}`);
    // all 16 on one octave: more numbers than the octave holds; still none stacks
    check(y.map((yy, i) => ({ i, L: 3 * oct, R: 4 * oct, y: yy })), W, `same octave at ${W}`, { onBar: false });
    // a fifth each
    check(y.map((yy, i) => ({ i, L: (i % 8) * oct * 0.6, R: (i % 8) * oct * 0.6 + oct * 0.58, y: yy })), W,
      `fifths at ${W}`);
  }
});

test('slivers at the keyboard edges (a range mostly off the keys shown) do not stack at x = 0', () => {
  const y = rowsY(12);
  const bars = y.map((yy, i) => (i % 2 ? { i, L: -400, R: 6 + i, y: yy } : { i, L: 990 - i, R: 1600, y: yy }));
  // six slivers in 10–20 px at each edge, on rows that touch: they can't all sit on their bars; the first on each side
  // does, and none stacks
  const boxes = check(bars, 1000, 'slivers', { onBar: 'first' });
  // (check() proved no two touching rows share a spot; rows far enough apart may: 2 and 12 both at 0)
  const left = boxes.filter((b) => b.i % 2).map((b) => Math.round(b.x));
  assert.ok(new Set(left).size >= 5, `spread out: ${left}`);
});

test('few bars, rows apart (8 px or more between centres of non-touching rows) may share x', () => {
  const bars = [{ i: 0, L: 100, R: 160, y: 2 }, { i: 9, L: 100, R: 160, y: 2 + BADGE_H }];
  const pos = placeBadges(bars, 500);
  assert.equal(pos.get(0), 2);
  check(bars, 500, 'apart');
});

test('bad input is skipped; an empty list gives an empty map', () => {
  assert.equal(placeBadges([], 500).size, 0);
  const pos = placeBadges([{ i: 0, L: NaN, R: 3, y: 1 }, { i: 1, L: 0, R: 100, y: 1 }], 500);
  assert.deepEqual([...pos.keys()], [1]);
});
