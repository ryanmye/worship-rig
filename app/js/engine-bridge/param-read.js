// CORE2B: a param's value read off a patch the way audio.js getParam reads its own (app/js/engine/audio.js:1221).
// The bridge shim answers engine.getParam synchronously from its mirror and uses this only for a path it has no
// native answer for yet (bridge-engine.js `getParam`); the mock core (mock-native.js) answers `get param` with it.
// Pure: no DOM, no Web Audio.
import { describe } from '../shared/params.js';

/**
 * The value of `path` in `patch` (contract 2.2 shape), in the PARAMS value space. Slot rows: undefined for an empty
 * slot, the stored value, else the PARAMS default (an optional row: its default, `'natural'` for pedalHold, else
 * undefined);`slots.<i>.params.<key>`: the stored
 * value, else the catalogue default of the slot's instrument; fx.* / master.volume: the stored value, else the
 * default; drone.* (song.drone, not part of the patch): the default. Slot EQ rows read the stored row (the core
 * answers b-rows resolved, fx.js resolveSlotEq).
 * @param {object|null} patch
 * @param {string} path a valid param path
 * @param {Array<{ref:{type:string,id:string}, params?:Array<{key:string, default:*}>}>} [instruments] catalogue
 * @returns {*}
 */
export function patchParam(patch, path, instruments = []) {
  const d = describe(path);
  if (!d) return undefined;
  const m = /^slots\.(\d+)\.(.+)$/.exec(path);
  if (m) {
    const cfg = patch && Array.isArray(patch.slots) ? patch.slots[Number(m[1])] : null;
    if (!cfg) return undefined;
    const rest = m[2].split('.');
    if (rest[0] === 'params') {
      const key = rest.slice(1).join('.');
      const v = cfg.params ? cfg.params[key] : undefined;
      if (v !== undefined && v !== null) return v;
      const ref = cfg.instrument || {};
      const e = instruments.find((x) => x && x.ref && x.ref.type === ref.type && x.ref.id === ref.id);
      const p = e && (e.params || []).find((q) => q.key === key);
      return p ? p.default : undefined;
    }
    let v;
    if (rest[0] === 'eq') v = rest.length === 3 ? cfg.eq?.[rest[1]]?.[rest[2]] : cfg.eq?.[rest[1]];
    else if (rest[0] === 'touch' || rest[0] === 'sends') v = cfg[rest[0]]?.[rest[1]];
    else v = cfg[rest[0]];
    if (v !== undefined && v !== null) return v;
    // CORE2B skeptic: audio.js normalizePatch stores an absent pedalHold as clampParam(undefined) = 'natural' (what
    // the core answers); an absent release reads undefined here and from the core (audio.js: null)
    return d.optional ? (d.default ?? undefined) : d.default;
  }
  const [head, unit, key] = path.split('.');
  const fx = (patch && patch.fx) || {};
  let v;
  if (head === 'master') v = fx.master?.volume;
  else if (head === 'fx') v = fx[unit]?.[key];
  return v ?? d.default;
}
