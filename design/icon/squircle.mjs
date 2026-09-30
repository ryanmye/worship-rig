// Continuous-curvature ("squircle") rounded rect in the macOS icon grammar, as an SVG path string.
// Body 824×824 at (100,100) in a 1024 canvas; nominal corner radius 22.37 % of the side (184.3).
// Corner geometry is the well-known continuous-corner Bézier construction (extent 1.5287·r per edge),
// written here from its published coefficients; used once to generate the <path d> pasted into the masters.
// Usage: node design/icon/squircle.mjs [x y size radiusFraction]
const [x = 100, y = 100, s = 824, f = 0.2237] = process.argv.slice(2).map(Number);
const r = s * f;
// One corner, as (u, v): u = distance back along the incoming edge, v = distance along the outgoing edge (× r).
const C = [
  ['M', [1.52866483, 0]],
  ['C', [1.08849323, 0], [0.86840689, 0], [0.66993427, 0.06549600]],
  ['L', [0.63149399, 0.07491100]],
  ['C', [0.37282392, 0.16905899], [0.16906013, 0.37282401], [0.07491176, 0.63149399]],
  ['L', [0.06549600, 0.66993427]],
  ['C', [0, 0.86840689], [0, 1.08849323], [0, 1.52866483]],
];
const X0 = x, Y0 = y, X1 = x + s, Y1 = y + s;
const maps = [
  ([u, v]) => [X1 - u * r, Y0 + v * r], // top-right (incoming: top edge →)
  ([u, v]) => [X1 - v * r, Y1 - u * r], // bottom-right (incoming: right edge ↓)
  ([u, v]) => [X0 + u * r, Y1 - v * r], // bottom-left (incoming: bottom edge ←)
  ([u, v]) => [X0 + v * r, Y0 + u * r], // top-left (incoming: left edge ↑)
];
const n = (p) => p.map((k) => +k.toFixed(2)).join(' ');
let d = '';
maps.forEach((m, i) => {
  for (const [cmd, ...pts] of C) {
    const c = cmd === 'M' ? (i === 0 ? 'M' : 'L') : cmd;
    d += c + pts.map((p) => n(m(p))).join(' ');
  }
});
console.log(d + 'Z');
