// Daylight v2 "Today": the daily hook (concept.md §8). A working, self-contained module, NOT linked from the app yet.
// The preview (shoot.mjs) imports it into the real, running app; landing it is one import in main.js:
//   import { mountToday } from '../themes/daylight-v2/today.js';   // after the views are mounted
//   mountToday({ store, controller });
//
// What it does, with no store schema change (all of its own state is per-Mac, in localStorage, like the Edit
// sections' open state):
//  1. Today card at the top of Perform's Notes column: the next service, where you are in the set, what you played
//     last time. On the day it reads "Today · Sunday morning · song 3 of 6 · 18 minutes in".
//  2. The before-service sheet inside #overlay-start (the browser's required first tap): day, set, Last time, Since
//     then, Day · Stage · Auto, and one Start sound button. The tap still goes to main.js's own overlay handler, so
//     the audio-unlock path is unchanged; the light toggle stops its pointerdown so choosing a light doesn't start.
//  3. The light: body[data-mode] = day | dusk | (none = Auto), remembered per Mac. Lock sets Stage and it stays Stage
//     after unlock (unlocking mid-service must never flood the room with white). On a service-day morning with no
//     choice made, the sheet pre-selects Stage.
//  4. A session log: {day, minutes, setId, lastSongId, lastKey} per app session, and a snapshot of the set's songs, so
//     "Since then" can say what changed in words (shared/song-diff.js's watch list).
// It only reads the store (store.get / subscribe) and never calls the engine: views never call the engine.
import { keyName } from '../../js/shared/music.js';
import { changedPaths } from '../../js/shared/song-diff.js';

const LOG_KEY = 'worship-rig.today.v1';
const LIGHT_KEY = 'worship-rig.light';
const ROLES = ['Keys', 'Pad', 'Extra', 'Bass'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MON_RE = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a, b) => Math.round((atMidnight(b) - atMidnight(a)) / 864e5);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const fmtLong = (d) => `${cap(DAYS[d.getDay()])} ${d.getDate()} ${cap(MONTHS[d.getMonth()])}`;
const fmtShort = (d) => `${d.getDate()} ${cap(MONTHS[d.getMonth()]).slice(0, d.getMonth() === 8 ? 4 : 3)}`;
const partOfDay = (d) => (d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening');

/**
 * The next service date from a setlist name, else the next Sunday (today if it is Sunday).
 * Understands "2026-10-04", "4 Oct", "Oct 4", "Sunday 4th", "10/4" (month/day; day/month when the first number is
 * over 12) and weekday words ("Wed night"). A date already in the past falls back to the next Sunday.
 * @param {string} name setlist name
 * @param {Date} now
 * @returns {{date: Date, fromName: boolean}}
 */
export function nextService(name = '', now = new Date()) {
  const n = String(name).toLowerCase();
  const today = atMidnight(now);
  const ok = (d) => (d && !Number.isNaN(+d) && d >= today ? { date: d, fromName: true } : null);
  const guessYear = (m, day) => {
    const d = new Date(now.getFullYear(), m, day);
    return daysBetween(now, d) < -180 ? new Date(now.getFullYear() + 1, m, day) : d; // "4 Jan" named in December
  };
  let m;
  if ((m = n.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return ok(new Date(+m[1], +m[2] - 1, +m[3])) || nextSunday(now);
  if ((m = n.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON_RE})[a-z]*\\b`)))) {
    return ok(guessYear(MONTHS.findIndex((x) => x.startsWith(m[2].slice(0, 3))), +m[1])) || nextSunday(now);
  }
  if ((m = n.match(new RegExp(`\\b(${MON_RE})[a-z]*\\.?\\s+(\\d{1,2})\\b`)))) {
    return ok(guessYear(MONTHS.findIndex((x) => x.startsWith(m[1].slice(0, 3))), +m[2])) || nextSunday(now);
  }
  if ((m = n.match(/\b(\d{1,2})\/(\d{1,2})\b/))) {
    const [a, b] = [+m[1], +m[2]];
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    return ok(guessYear(mo - 1, d)) || nextSunday(now);
  }
  const wd = DAYS.findIndex((d) => new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?\\b`).test(n));
  if (wd >= 0) {
    const d = atMidnight(now);
    d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7));
    return { date: d, fromName: true };
  }
  return nextSunday(now);
}
function nextSunday(now) {
  const d = atMidnight(now);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return { date: d, fromName: false };
}

/** Plain words for what changed in a song since a snapshot (song-diff's watch list; levels never count). */
export function describeChange(song, base) {
  const paths = [...changedPaths(song, base)]; // a Set
  const out = [];
  const seen = new Set();
  const add = (s) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
  for (const p of paths) {
    let m;
    if ((m = p.match(/^patch\.slots\.(\d)\.instrument/))) add(`a new ${ROLES[+m[1]] || 'part'} sound`);
    else if ((m = p.match(/^patch\.slots\.(\d)\.sends\.(\w+)/))) add(`${{ reverb: 'Space', delay: 'Echo', chorus: 'Chorus' }[m[2]] || 'effect'} on ${ROLES[+m[1]]}`);
    else if ((m = p.match(/^patch\.slots\.(\d)\.(octave|sustain)/))) add(`${ROLES[+m[1]]} ${m[2]}`);
    else if (p.startsWith('patch.fx.reverb')) add('a different Space');
    else if (p.startsWith('patch.fx.delay')) add('a different Echo');
    else if (/^(hearIn|playIn|transposeOctave|minor)$/.test(p)) add('a new key');
    else if (p === 'tempo') add('a new tempo');
    else if (p === 'patch.swell.seconds') {
      add((song.patch?.swell?.seconds || 0) > (base.patch?.swell?.seconds || 0) ? 'a longer swell' : 'a shorter swell');
    } else if (p.startsWith('drone.')) add('drone settings');
  }
  return out.length > 2 ? `${out.slice(0, 2).join(', ')} and more` : out.join(' and ');
}

function readJSON(storage, key, fallback) {
  try { const v = JSON.parse(storage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
}
function writeJSON(storage, key, v) {
  try { storage.setItem(key, JSON.stringify(v)); } catch { /* private window / full: Today still renders */ }
}

/**
 * Mount the Today card, the before-service sheet and the light switch.
 * @param {{store: object, controller?: object, now?: () => Date, storage?: Storage, doc?: Document}} o
 * @returns {{destroy: () => void, setLight: (mode: 'day'|'dusk'|'auto') => void, render: () => void}}
 */
export function mountToday({ store, controller = null, now = () => new Date(), storage = globalThis.localStorage, doc = document } = {}) {
  const body = doc.body;
  const log = readJSON(storage, LOG_KEY, { sessions: [], snap: {} });
  if (!Array.isArray(log.sessions)) log.sessions = [];
  const baseline = log.snap && typeof log.snap === 'object' ? log.snap : {}; // the set as it was last session
  const started = now();
  const session = { day: dayKey(started), minutes: 0, setId: null, lastSongId: null, lastKey: null };
  const prior = log.sessions.filter((s) => s && s.minutes >= 3).slice(-1)[0] || null;
  log.sessions.push(session);
  log.sessions = log.sessions.slice(-120);

  // ------------------------------------------------------------------ state from the store
  const setInfo = () => {
    const st = store.get();
    const sl = st.settings.currentSetlistId ? st.setlists[st.settings.currentSetlistId] : null;
    const ids = sl && sl.songIds.length ? sl.songIds : st.songOrder;
    const cur = st.settings.currentSongId;
    const pos = Number.isInteger(st.settings.setlistIndex) && ids[st.settings.setlistIndex] === cur
      ? st.settings.setlistIndex : ids.indexOf(cur);
    return { st, sl, ids, pos, song: st.songs[cur] || null };
  };
  const songKey = (song) => (song ? keyName(song.hearIn ?? song.playIn ?? 0, !!song.minor) : '');

  // ------------------------------------------------------------------ the light
  const LIGHTS = ['day', 'dusk', 'auto'];
  const applyLight = (mode) => {
    const set = () => { if (mode === 'auto') delete body.dataset.mode; else body.dataset.mode = mode; };
    if (body.dataset.mode === (mode === 'auto' ? undefined : mode)) return;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (doc.startViewTransition && !reduce && body.isConnected) doc.startViewTransition(set); else set();
  };
  let current = 'auto';
  const setLight = (mode) => {
    if (!LIGHTS.includes(mode)) return;
    current = mode;
    try { storage.setItem(LIGHT_KEY, mode); } catch { /* per-viewer convenience only */ }
    applyLight(mode);
    renderLightSeg();
  };
  const storedLight = () => { try { return storage.getItem(LIGHT_KEY); } catch { return null; } };
  const service = () => nextService(setInfo().sl?.name, now());
  const isServiceDay = () => daysBetween(now(), service().date) === 0;
  // no choice yet + a service-day morning → Stage (the critique's "opened unlocked in a dim sanctuary" case)
  const initial = LIGHTS.includes(storedLight()) ? storedLight() : isServiceDay() && now().getHours() < 13 ? 'dusk' : 'auto';
  current = initial;
  applyLight(initial);
  let lastLock = !!store.get().settings.performLock;

  // ------------------------------------------------------------------ DOM helpers
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const icon = (name) => {
    const i = el('i', 'dl-ic');
    i.style.setProperty('--m', `url('/themes/daylight-v2/${name}.svg')`);
    i.setAttribute('aria-hidden', 'true');
    return i;
  };

  // ------------------------------------------------------------------ the Today card (Perform › Notes)
  const card = el('section', 'dl-today');
  card.setAttribute('aria-label', 'Today');
  const cardH = el('div', 'dl-today-h');
  const cardD = el('div', 'dl-today-d');
  const cardS = el('div', 'dl-today-s');
  const cardBar = el('div', 'dl-today-bar');
  cardBar.setAttribute('aria-hidden', 'true');
  card.append(cardH, cardD, cardS, cardBar);

  let cardSig = '';
  function renderCard(force = false) {
    const notes = doc.querySelector('.perform .p-notes');
    if (!notes) return;
    if (card.parentNode !== notes) { notes.querySelector('.notes-head')?.after(card); force = true; }
    const { ids, pos, st } = setInfo();
    const t = now();
    // the store notifies on every fader tick: only touch the DOM when something the card shows has changed
    const sig = [ids.join(), pos, dayKey(t), partOfDay(t), Math.round(session.minutes), st.setlists[st.settings.currentSetlistId]?.name].join('|');
    if (sig === cardSig && !force) return;
    cardSig = sig;
    const svc = service();
    const days = daysBetween(t, svc.date);
    const wd = cap(DAYS[svc.date.getDay()]);
    cardH.replaceChildren(icon('today'), document.createTextNode(days === 0 ? 'Today' : `Practice for ${wd}`));
    cardD.textContent = days === 0 ? `${wd} ${partOfDay(t)}` : fmtLong(svc.date);
    const bits = [];
    if (days > 0) bits.push(days === 1 ? 'tomorrow' : `in ${days} days`);
    if (pos >= 0) bits.push(['song ', b(`${pos + 1} of ${ids.length}`)]);
    if (days === 0 && session.minutes >= 1) bits.push(`${Math.round(session.minutes)} minutes in`);
    else if (prior && prior.lastSongId && st.songs[prior.lastSongId]) {
      bits.push(['last played ', b(st.songs[prior.lastSongId].name), ` in ${prior.lastKey || songKey(st.songs[prior.lastSongId])}, ${fmtShort(new Date(`${prior.day}T12:00`))}`]);
    }
    cardS.replaceChildren(...bits.flatMap((x, i) => [...(i ? [' · '] : []), ...(Array.isArray(x) ? x : [x])])
      .map((x) => (typeof x === 'string' ? doc.createTextNode(x) : x)));
    cardBar.replaceChildren(...ids.slice(0, 24).map((_, i) => el('i', i < pos ? 'done' : i === pos ? 'now' : '')));
  }
  function b(text) { return el('b', '', text); }

  // ------------------------------------------------------------------ the before-service sheet (#overlay-start)
  const overlay = doc.getElementById('overlay-start');
  const sheet = el('div', 'dl-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Today');
  let lightSeg = null;
  function renderLightSeg() {
    if (!lightSeg) return;
    for (const btn of lightSeg.children) {
      btn.classList.toggle('on', btn.dataset.light === current);
      btn.setAttribute('aria-pressed', String(btn.dataset.light === current));
    }
  }
  function renderSheet() {
    if (!overlay) return;
    overlay.classList.add('dl-has-today');
    if (sheet.parentNode !== overlay) overlay.append(sheet);
    const { st, sl, ids } = setInfo();
    const t = now();
    const svc = service();
    const days = daysBetween(t, svc.date);
    const left = el('div', 'dl-sheet-l');
    const kick = el('div', 'dl-kick');
    const mark = el('img');
    mark.src = '/themes/daylight-v2/mark.svg';
    mark.alt = '';
    kick.append(mark, doc.createTextNode(days === 0 ? 'Today' : `Practice for ${cap(DAYS[svc.date.getDay()])}`));
    const serviceDays = new Set(log.sessions.filter((s) => s.minutes >= 3 && new Date(`${s.day}T12:00`).getDay() === svc.date.getDay()).map((s) => s.day));
    serviceDays.add(dayKey(svc.date));
    const count = serviceDays.size >= 2 ? ` · your ${ordinal(serviceDays.size)} ${cap(DAYS[svc.date.getDay()])} with the rig` : '';
    left.append(kick,
      el('div', 'dl-day', days === 0 ? `${cap(DAYS[t.getDay()])} ${partOfDay(t)}` : fmtLong(svc.date)),
      el('div', 'dl-date', days === 0 ? `${fmtLong(t).replace(/^\w+ /, '')}${count}` : `${days === 1 ? 'tomorrow' : `in ${days} days`}${count}`));
    const first = st.songs[ids[0]];
    const set = el('div', 'dl-set');
    set.append(el('b', '', sl?.name || 'All songs'), el('span', '', `${ids.length} song${ids.length === 1 ? '' : 's'}${first ? ` · starts in ${songKey(first)}` : ''}`));
    const list = el('ol', 'dl-songs');
    ids.slice(0, 4).forEach((id, i) => {
      const li = el('li', i === 0 ? 'first' : '');
      li.append(el('span', 'n', String(i + 1)), el('span', '', st.songs[id]?.name || ''), el('span', 'k', songKey(st.songs[id])));
      list.append(li);
    });
    if (ids.length > 4) {
      const li = el('li');
      li.append(el('span', 'n'), el('span', 'more', `and ${ids.length - 4} more`), el('span'));
      list.append(li);
    }
    left.append(set, list);

    const right = el('div', 'dl-sheet-r');
    const lastCard = el('div', 'dl-card');
    lastCard.append(el('h4', '', 'Last time'));
    const lp = el('p');
    if (prior) {
      const d = new Date(`${prior.day}T12:00`);
      const song = prior.lastSongId && st.songs[prior.lastSongId];
      lp.append(`${fmtLong(d)}, `, b(`${Math.max(1, Math.round(prior.minutes))} minutes`), '.');
      if (song) lp.append(' You finished on ', b(song.name), ` in ${prior.lastKey || songKey(song)}.`);
    } else lp.append('This is your first time here. Welcome.');
    lastCard.append(lp);
    const sinceCard = el('div', 'dl-card');
    sinceCard.append(el('h4', '', 'Since then'));
    const sp = el('p');
    const changes = ids.map((id) => st.songs[id] && baseline[id] ? [st.songs[id].name, describeChange(st.songs[id], baseline[id])] : null)
      .filter((x) => x && x[1]);
    if (!prior) sp.append('Nothing to compare yet. Next time this shows what you changed.');
    else if (!changes.length) sp.append('No songs in this set have changed.');
    else {
      changes.slice(0, 2).forEach(([name, what], i) => sp.append(...(i ? [' '] : []), b(name), ` has ${what}.`));
      if (changes.length > 2) sp.append(` ${changes.length - 2} more changed too.`);
      else sp.append(' Nothing else changed.');
    }
    sinceCard.append(sp);
    lightSeg = el('div', 'dl-light');
    lightSeg.setAttribute('role', 'group');
    lightSeg.setAttribute('aria-label', 'Light');
    for (const [id, label, ic] of [['day', 'Day', 'sun'], ['dusk', 'Stage', 'moon'], ['auto', 'Auto', null]]) {
      const btn = el('button', '', undefined);
      btn.type = 'button';
      btn.dataset.light = id;
      if (ic) btn.append(icon(ic));
      btn.append(label);
      // choosing a light must not also start the sound: main.js's overlay handler listens for pointerdown
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => { e.stopPropagation(); setLight(id); });
      lightSeg.append(btn);
    }
    const go = el('button', 'dl-go', 'Start sound');
    go.type = 'button';
    right.append(lastCard, sinceCard, lightSeg, go, el('div', 'dl-small', 'Your browser needs one tap before it can play.'));
    sheet.replaceChildren(left, right);
    renderLightSeg();
  }

  // ------------------------------------------------------------------ the log
  const snapshotSet = () => {
    const { st, ids } = setInfo();
    const snap = {};
    for (const id of ids) if (st.songs[id]) snap[id] = st.songs[id];
    return snap;
  };
  const save = () => {
    const { sl, song } = setInfo();
    session.setId = sl?.id || null;
    if (song) { session.lastSongId = song.id; session.lastKey = songKey(song); }
    // the baseline for NEXT session: only once this session is worth remembering, so a quick peek doesn't reset it
    if (session.minutes >= 3) log.snap = snapshotSet();
    writeJSON(storage, LOG_KEY, log);
  };
  let tickAt = started;
  const tick = () => {
    const t = now();
    const running = !controller || controller.status?.audio === 'running';
    if (doc.visibilityState !== 'hidden' && running) session.minutes += Math.min(5, (t - tickAt) / 60000);
    tickAt = t;
    save();
    renderCard();
  };
  const timer = setInterval(tick, 30000);
  const onHide = () => { if (doc.visibilityState === 'hidden') tick(); };
  doc.addEventListener('visibilitychange', onHide);
  globalThis.addEventListener?.('pagehide', tick);

  const unsub = store.subscribe((state) => {
    const locked = !!state.settings.performLock;
    if (locked && !lastLock) setLight('dusk'); // sticky: unlocking later does not switch back
    lastLock = locked;
    renderCard();
  });
  renderCard();
  renderSheet();
  save();

  return {
    setLight,
    render: () => { renderCard(true); renderSheet(); },
    destroy() {
      clearInterval(timer);
      doc.removeEventListener('visibilitychange', onHide);
      globalThis.removeEventListener?.('pagehide', tick);
      unsub?.();
      card.remove();
      sheet.remove();
      overlay?.classList.remove('dl-has-today');
    },
  };
}
