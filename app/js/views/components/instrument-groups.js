// Instrument group order for pickers (Edit's instrument select, any Perform list) — one source of truth.
// engine.listInstruments() passes each def's `group` string through; unknown groups go after the known ones
// (never silently into 'Synth Pads').

/** Display order. 'Brass & Leads' (synth-extra) sits between Synth Keys and Mallets & Bells; user samples last. */
export const INSTRUMENT_GROUPS = Object.freeze([
  'Piano',
  'Electric Piano',
  'Organ',
  'Synth Pads',
  'Synth Keys',
  'Brass & Leads',
  'Mallets & Bells',
  'Guitar',
  'Bass',
  'My Samples',
]);

/** Group for an engine.listInstruments() entry (user: ids without a group → 'My Samples'). */
export function groupOf(item) {
  if (item && typeof item.group === 'string' && item.group) return item.group;
  if (item && item.ref && String(item.ref.id || '').startsWith('user:')) return 'My Samples';
  return 'Other';
}

/**
 * Group a list in display order: known groups first (INSTRUMENT_GROUPS order), then any new group names
 * alphabetically, then 'Other'. Empty groups are dropped.
 * @param {Array<{ref:{type:string,id:string}, name:string, group?:string, hidden?:boolean}>} list
 * @returns {Array<{group:string, items:Array}>}
 */
export function groupInstruments(list) {
  const map = new Map();
  for (const it of list || []) {
    if (!it || it.hidden) continue;
    const g = groupOf(it);
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(it);
  }
  const extra = [...map.keys()].filter((g) => !INSTRUMENT_GROUPS.includes(g) && g !== 'Other').sort();
  return [...INSTRUMENT_GROUPS, ...extra, 'Other'].filter((g) => map.has(g)).map((group) => ({ group, items: map.get(group) }));
}

/** Stage name for an instrument: library credits in parentheses are dropped ("Grand Piano (Salamander)" → "Grand Piano"). */
export function stageName(name, ref) {
  let s = String(name || '').trim();
  if (!(ref && String(ref.id || '').startsWith('user:'))) s = s.replace(/\s*\((?:Salamander|MusyngKite|FluidR3(?:_GM)?|VSCO[^)]*|Sonatina[^)]*|Versilian[^)]*|Freesound[^)]*|CC0[^)]*|FatBoy[^)]*|[A-Z][A-Za-z]+Kite)\)\s*$/, '');
  if (s === 'Drone Oscillator') s = 'Sub Drone';
  return s;
}
