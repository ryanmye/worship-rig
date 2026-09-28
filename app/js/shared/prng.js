// Deterministic PRNG (SPEC §0.8): every random decision in the engine comes from one seeded stream.

/**
 * Hash a string seed to a uint32 (FNV-1a).
 * @param {string} s
 * @returns {number}
 */
export function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function toSeed(seed) {
  if (typeof seed === 'string') return hashSeed(seed);
  const n = Number(seed);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

/**
 * mulberry32 generator.
 * @param {number|string} seed uint32 (numbers are truncated with `>>> 0`; strings are hashed)
 * @returns {() => number} returns floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = toSeed(seed);
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} Rng
 * @property {number} seed      the uint32 seed actually used
 * @property {() => number} next             float [0,1)
 * @property {(a:number,b:number) => number} range  float [a,b)
 * @property {(a:number,b:number) => number} int    integer in [a,b] inclusive
 * @property {() => number} gaussian         standard normal (Box–Muller, spare cached)
 * @property {<T>(arr:T[]) => T} pick         uniform element (undefined for empty)
 * @property {<T>(arr:T[]) => T[]} shuffle    NEW shuffled copy (Fisher–Yates); input untouched
 * @property {() => Rng} fork                 independent child stream seeded from this one
 */

/**
 * Create a seeded RNG with helpers.
 * @param {number|string} [seed=0]
 * @returns {Rng}
 */
export function createRng(seed = 0) {
  const s = toSeed(seed);
  const next = mulberry32(s);
  let spare = null;
  const rng = {
    seed: s,
    next,
    range(a, b) {
      return a + (b - a) * next();
    },
    int(a, b) {
      const lo = Math.ceil(Math.min(a, b));
      const hi = Math.floor(Math.max(a, b));
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    gaussian() {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      const u1 = 1 - next(); // (0, 1] so log is finite
      const u2 = next();
      const r = Math.sqrt(-2 * Math.log(u1));
      spare = r * Math.sin(2 * Math.PI * u2);
      return r * Math.cos(2 * Math.PI * u2);
    },
    pick(arr) {
      if (!arr || arr.length === 0) return undefined;
      return arr[Math.floor(next() * arr.length)];
    },
    shuffle(arr) {
      const out = Array.from(arr);
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = out[i];
        out[i] = out[j];
        out[j] = t;
      }
      return out;
    },
    fork() {
      return createRng(Math.floor(next() * 4294967296) >>> 0);
    },
  };
  return rng;
}
