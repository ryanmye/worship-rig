// UI v6 Settings (U6; native DECISIONS D21; mockup native/docs/design/mockups/settings.html): the one-line current
// state under each category's name ("Built-in output · 42 ms", "3 controls learned"). Pure: no DOM, no storage; the
// v6 Settings (views/v6/settings.js) gathers the inputs and calls these.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "just now", "4 min ago", "2 h ago", "3 days ago".
 * @param {number} at  epoch ms
 * @param {number} now epoch ms
 * @returns {string}
 */
export function ago(at, now) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${plural(Math.floor(h / 24), 'day')} ago`;
}

/**
 * Sound: the output and the delay to the speakers (or the latency choice before audio runs).
 * @param {{output?:string, latencyMs?:number, latencyLabel?:string}} o
 * @returns {string}
 */
export function soundSummary(o = {}) {
  const out = o.output || 'System default';
  const ms = Number(o.latencyMs) || 0;
  return ms ? `${out} · ${Math.round(ms)} ms` : o.latencyLabel ? `${out} · ${o.latencyLabel}` : out;
}

/**
 * Keyboards & MIDI: the keyboard playing (or why none is) and the touch.
 * @param {{midi?:{available?:boolean, connected?:boolean, name?:string}, touch?:string, computerKeys?:boolean}} o
 * @returns {string}
 */
export function keyboardsSummary(o = {}) {
  const m = o.midi || {};
  const dev = m.connected && m.name ? m.name : m.available === false ? 'MIDI off'
    : o.computerKeys ? 'Computer keys' : 'No keyboard';
  return `${dev} · ${o.touch || 'Normal'} touch`;
}

/**
 * MIDI Learn: how many controls are learned (settings.midiLearn, one entry per learned control).
 * @param {object} [midiLearn]
 * @returns {string}
 */
export function learnSummary(midiLearn) {
  const n = Object.values(midiLearn || {}).filter(Boolean).length;
  return n ? `${plural(n, 'control')} learned` : 'nothing learned yet';
}

/**
 * Sounds & Samples: patch packs and bank songs when there are any, else sample instruments; then the My Pads folder.
 * @param {{packs?:{enabled?:boolean, songs?:number, packs?:number, bankSongs?:number}|null, samples?:number,
 *   padFolder?:boolean}} o
 * @returns {string}
 */
export function samplesSummary(o = {}) {
  const p = o.packs;
  if (p && p.enabled && p.songs > 0) return `${plural(p.packs || 0, 'pack')} · ${plural(p.bankSongs || 0, 'bank song')}`;
  const parts = [];
  if (o.samples > 0) parts.push(plural(o.samples, 'sample instrument'));
  parts.push(o.padFolder ? 'My Pads folder set' : 'built-in sounds');
  return parts.join(' · ');
}

/**
 * Perform layout: the right sidebar (open or folded now) and the snapshots row.
 * @param {{sidebarOpen?:boolean, snapsFolded?:boolean}} o
 * @returns {string}
 */
export function layoutSummary(o = {}) {
  return `sidebar ${o.sidebarOpen === false ? 'folded' : 'open'} · snapshots ${o.snapsFolded ? 'folded' : 'shown'}`;
}

/**
 * Look: the theme's name, then Day / Stage / Auto for a theme with the light switch, else dark / light.
 * @param {{name?:string, mode?:'dark'|'light', light?:'day'|'stage'|'auto'|null}} o
 * @returns {string}
 */
export function lookSummary(o = {}) {
  const light = o.light ? { day: 'Day', stage: 'Stage', auto: 'Auto' }[o.light] : o.mode === 'light' ? 'light' : 'dark';
  return `${o.name || 'Theme'} · ${light}`;
}

/**
 * Library & Backup: when this page last backed up (Mac app), else that backups run, else (Chrome) the song count.
 * @param {{electron?:boolean, lastBackupAt?:number|null, now?:number, songs?:number}} o
 * @returns {string}
 */
export function librarySummary(o = {}) {
  if (o.electron && Number.isFinite(o.lastBackupAt)) return `backed up ${ago(o.lastBackupAt, o.now ?? Date.now())}`;
  if (o.electron) return `${plural(o.songs || 0, 'song')} · automatic backups`;
  return `${plural(o.songs || 0, 'song')} · Export to back up`;
}

/**
 * Mac (Mac app only): menu-bar mode and the update check.
 * @param {{menuBarMode?:boolean, updateCheck?:boolean}} o
 * @returns {string}
 */
export function macSummary(o = {}) {
  return `menu bar ${o.menuBarMode ? 'on' : 'off'} · updates ${o.updateCheck === false ? 'off' : 'on'}`;
}

/**
 * About: the app's version (Mac app), else where it runs.
 * @param {{version?:string|null, electron?:boolean}} o
 * @returns {string}
 */
export function aboutSummary(o = {}) {
  if (o.version) return `Version ${o.version}`;
  return o.electron ? 'Mac app' : 'Chrome';
}
