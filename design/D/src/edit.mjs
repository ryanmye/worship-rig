// Edit mockups: mixer + inspector. sel = 'keys' (a sound) | 'space' (a shared effect).
import { page, css, topbar, vf, vm, knob, keyboard } from './lib.mjs';

const CH = [
  { col: 'k', role: 'KEYS', c: 'var(--slot-0)', inst: 'Grand Piano', sub: 'Piano', range: [0, 0], sends: [0.25, 0.1, 0], act: true, pan: 'C', v: 0.74, db: '−1.9', m: 58 },
  { col: 'p', role: 'PAD', c: 'var(--slot-1)', inst: 'Warm Pad', sub: 'Synth pad', range: [0, 0], sends: [0.5, 0.15, 0.4], act: true, pan: 'C', v: 0.65, db: '−5.2', m: 44 },
  null,
  { col: 'b', role: 'BASS', c: 'var(--slot-3)', inst: 'Sub Bass', sub: 'Synth · mono', range: [0, 60.7], sends: [0, 0, 0], pan: 'C', v: 0.7, db: '−3.1', m: 30 },
];
const RET = [
  { col: 'rv', row: 'sp', name: 'SPACE', preset: 'Stage', kind: 'Reverb', v: 0.79, db: '0.0', m: 30 },
  { col: 'dl', row: 'ec', name: 'ECHO', preset: 'Dotted ⅛', kind: 'Delay', v: 0.77, db: '−0.9', m: 18 },
  { col: 'ch', row: 'chr', name: 'CHORUS', preset: 'Chorus', kind: 'Shimmer', v: 0.67, db: '−4.4', m: 12 },
];
const ROWS = ['sp', 'ec', 'chr'];

const at = (col, row, cls, inner, style = '') =>
  `<div class="${cls}" style="grid-column:${col};grid-row:${row};${style}">${inner}</div>`;

function channel(ch, sel) {
  const s = sel === ch.role.toLowerCase();
  const hot = sel === 'space';
  let h = at(ch.col, 'head / -1', `card${s ? ' sel' : ''}`, '', `--c:${ch.c}`);
  h += at(ch.col, 'head', 'cell hd', `<div class="r">${ch.role}<i class="act${ch.act ? ' on' : ''}"></i></div><b><u>${ch.inst}</u></b><span>${ch.sub}</span>`, `--c:${ch.c}`);
  h += at(ch.col, 'range', 'cell', `<div class="rg"><i style="--a:${ch.range[0]}%;--b:${ch.range[1]}%"></i></div>`, `--c:${ch.c}`);
  ch.sends.forEach((v, i) => {
    const pct = Math.round(v * 100);
    h += at(ch.col, ROWS[i], `cell`, `<div class="snd${pct ? '' : ' zero'}"><div class="t"><i style="--v:${pct}%"></i></div><b>${pct || '0'}</b></div>`,
      `--c:${ch.c}${hot && i === 0 ? ';filter:brightness(1.15)' : ''}`);
  });
  h += at(ch.col, 'fad', 'cell fz', vf(ch.v, ch.c));
  h += at(ch.col, 'db', 'cell dbv', `${ch.db} dB`);
  h += at(ch.col, 'mute', 'cell', `<span class="btn mute">MUTE</span>`);
  return h;
}

function mixer(sel) {
  const hot = sel === 'space';
  let h = '';
  h += at('k / s1', 'grp', 'grp', 'Sounds · click a name to open it');
  h += at('rv / s2', 'grp', 'grp', 'Shared effects');
  h += at('ma', 'grp', 'grp', 'Out');
  // backgrounds
  h += at('x', 'head / -1', 'card ghost', '');
  h += at('d', 'head / -1', 'card', '', '--c:var(--drone)');
  RET.forEach((r) => { h += at(r.col, 'head / mute', `card ret${hot && r.col === 'rv' ? ' sel' : ''}`, '', `--c:var(--fx)`); });
  h += at('ma', 'head / mute', 'card mas', '', '--c:var(--fx)');
  if (hot) h += at('gut / rv', 'sp', 'bandhot', '');
  // buses (drawn under cells, over cards)
  h += at('k / rv', 'sp', `bus${hot ? ' hot' : ''}`, '');
  h += at('k / dl', 'ec', 'bus', '');
  h += at('k / ch', 'chr', 'bus', '');
  // gutter labels
  const g = [['range', 'Range', ''], ['sp', 'Space', ' bus-l'], ['ec', 'Echo', ' bus-l'], ['chr', 'Chorus', ' bus-l'], ['fad', 'Level', '']];
  for (const [row, t, c] of g) h += at('gut', row, `gut${c}${hot && row === 'sp' ? ' hot' : ''}`, t, row === 'fad' ? 'align-items:flex-start;padding-top:12px' : '');
  // channels
  CH.forEach((ch) => { if (ch) h += channel(ch, sel); });
  // extra (empty) — collapsed
  h += at('x', 'head / -1', 'ghostcol', `<span class="plus">+</span><span class="v">EXTRA <span>· add a sound</span></span>`);
  // drone
  h += at('d', 'head', 'cell hd', `<div class="r">DRONE<i class="act on"></i></div><b><u>Synth drone</u></b><span>Song key</span>`, '--c:var(--drone)');
  h += at('d', 'range / fad', 'block dr', `<big>D</big><small>major</small><div class="mini"><span>Bright <b>50</b></span><span>Move <b>30</b></span></div>`);
  h += at('d', 'fad', 'cell fz', vf(0.84, 'var(--drone)'));
  h += at('d', 'db', 'cell dbv', '+1.6 dB');
  h += at('d', 'mute', 'cell', `<span class="pill2">↻ Continues</span>`);
  // returns
  RET.forEach((r) => {
    const isSel = hot && r.col === 'rv';
    h += at(r.col, 'head', 'cell hd', `<div class="r rt">${r.name}</div><b><u>${r.preset}</u></b><span>${r.kind}</span>`, '--c:var(--fx)');
    const dots = CH.filter(Boolean).map((ch) => {
      const v = ch.sends[ROWS.indexOf(r.row)];
      const d = v ? 5 + Math.round(v * 8) : 5;
      return `<i style="--c:${ch.c};width:${d}px;height:${d}px;${v ? '' : 'opacity:.18'}"></i>`;
    }).join('') + (r.col === 'rv' ? '<i title="drone: fixed" style="--c:var(--drone);width:6px;height:6px;opacity:.7"></i>' : '');
    h += at(r.col, r.row, `cell jn${isSel ? ' hot' : ''}`, `<span class="in">${dots}</span>`);
    h += at(r.col, 'fad', 'cell fz', vf(r.v, 'var(--fx)'));
    h += at(r.col, 'db', 'cell dbv', `${r.db} dB`);
  });
  h += at('s2', 'fad', 'arrow', '›');
  // master
  h += at('ma', 'head', 'cell hd', `<div class="r rt">MASTER</div><b><u>Full Set</u></b><span>Vibe</span>`, '--c:var(--fx)');
  h += at('ma', 'range / fad', 'block ms', `<div>Tone<b>Flat</b></div><div>Glue<b>Off</b></div><div>Tape<b>Off</b></div>`);
  h += at('ma', 'fad', 'cell fz', vf(0.63, 'var(--thumb)') + vm(52, 48));
  h += at('ma', 'db', 'cell dbv', '−6.0 dB');
  return `<div class="panel mixer"><div class="mx">${h}</div></div>`;
}

function inspKeys() {
  return `<div class="panel insp" style="--c:var(--slot-0)">
    <div class="ih"><div class="sw2"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v8M12 5v8M16 5v8M8 13v6M12 13v6M16 13v6"/></svg></div>
      <div><div class="r">KEYS · SOUND 1</div><h2>Grand Piano</h2></div><div class="nav"><span>‹</span><span>›</span></div></div>
    <div class="tabs"><span class="on">Sound<small>Piano</small></span><span>Range<small>Whole kbd</small></span><span>Response<small>Normal</small></span><span>Effects<small>Space 25</small></span></div>
    <div class="ib">
      <section><div class="lab">Instrument</div>
        <div class="picker"><div><b>Grand Piano</b><span>Piano · sampled (Salamander)</span></div></div></section>
      <section><div class="lab">Shape the piano <em>from the instrument</em></div>
        <div class="knobs">
          <div class="kcell">${knob(1, 'var(--slot-0)', '', 62)}<b>Tone</b><span>Bright · 100%</span><small>darker ↔ brighter</small></div>
          <div class="kcell">${knob(0.42, 'var(--slot-0)', '', 62)}<b>Release</b><span>Natural · 0.35 s</span><small>short ↔ long</small></div>
        </div></section>
      <section><div class="lab">Pitch</div>
        <div class="prow"><span>Octave</span><div class="seg"><span>−2</span><span>−1</span><span class="on">0</span><span>+1</span><span>+2</span></div></div>
        <div class="prow"><span>Transpose</span><div class="stp"><span>−</span><b>0 semitones</b><span>+</span></div></div>
        <div class="hint">Changing the song’s key? Use <b>Key D</b> at the top — it moves every sound together.</div></section>
    </div>
    <div class="ifoot"><a>Reset Keys to factory</a><span class="btn sm ghost">Clear slot</span></div>
  </div>`;
}

function inspSpace() {
  const P = [
    ['Dry', 'No reverb — for a wet PA'], ['Room', 'Small, quick, close'], ['Stage', 'Medium hall. The Sunday default'],
    ['Hall', 'Big hall; pads bloom'], ['Cathedral', 'Huge, dark, long tail'], ['Ambient Wash', 'Maximum size, pad disappears'],
  ];
  return `<div class="panel insp" style="--c:var(--fx)">
    <div class="ih"><div class="sw2"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 20h18M5 20V10l7-6 7 6v10"/><path d="M9 20v-5h6v5"/></svg></div>
      <div><div class="r">SHARED EFFECT · REVERB</div><h2>Space: Stage</h2></div><div class="nav"><span>‹</span><span>›</span></div></div>
    <div class="tabs" style="--n:3"><span class="on">Presets<small>Stage</small></span><span>Fine-tune<small>size 42%</small></span><span>Fed by<small>Keys, Pad</small></span></div>
    <div class="ib">
      <section><div class="lab">Pick a space <em>one tap sets it all</em></div>
        <div class="presets">${P.map(([n, b]) => `<div class="pc${n === 'Stage' ? ' on' : ''}"><b>${n}</b><span>${b}</span></div>`).join('')}</div></section>
      <section><div class="lab">Sounds going in <em>= the Space row</em></div>
        <div class="sends">
          <div style="--c:var(--slot-0)"><span>Keys</span><div class="t"><i style="--v:25%"></i></div><b>25%</b></div>
          <div style="--c:var(--slot-1)"><span>Pad</span><div class="t"><i style="--v:50%"></i></div><b>50%</b></div>
          <div class="off" style="--c:var(--slot-2)"><span>Extra</span><div class="t"></div><b>—</b></div>
          <div style="--c:var(--slot-3)"><span>Bass</span><div class="t"><i style="--v:0%"></i></div><b>0%</b></div>
        </div></section>
    </div>
    <div class="ifoot"><span class="faint">Level 0.0 dB — the Space fader</span><a>Fine-tune ›</a></div>
  </div>`;
}

export function editPage({ sel = 'keys' } = {}) {
  const held = new Set([50, 62, 66, 69]);
  const songs = [['Sunday Pad + Piano', 'D'], ['Building Swell', 'G'], ['Prayer Wash', 'E'], ['Organ Swell', 'A'], ['Grand Piano', 'C'],
    ['Rhodes', 'F'], ['Felt Piano', 'Bb'], ['Lofi Rhodes', 'Eb'], ['Dusty Piano', 'C'], ['Glass Ocean', 'D']];
  const keysOn = sel === 'keys';
  const body = `${topbar({ view: 'edit' })}
<main class="ed">
  <aside class="panel lib"><span class="cap">Setlist</span><div class="sel">Sunday 9am</div>
    <div class="songs">${songs.map(([n, k], i) => `<div class="${i === 0 ? 'on' : ''}"><small>${i + 1}</small>${n}<em>${k}</em></div>`).join('')}</div>
    <div class="btns"><span class="btn sm">+ New</span><span class="btn sm">Factory</span><span class="btn sm">Library</span></div>
    <div class="file"><span>Library file</span><span>Export / import ›</span></div></aside>
  <section class="main">
    <div class="panel songbar"><span class="btn sm songsbtn">☰ Songs</span><h1>Sunday Pad + Piano</h1>
      <span class="sp"><small>KEY</small>D <em>· you play D</em> ▾</span>
      <span class="sp"><small>TEMPO</small>72 BPM <span class="t">Tap</span></span>
      <span class="sp">Notes <i class="led acc" style="width:7px;height:7px"></i></span>
      <span class="sp opt"><small>WHEEL</small>Pad level <em>· bend → drone</em> ▾</span>
      <span class="btn sm ghost right">Reset to factory</span></div>
    <div class="work">${mixer(sel)}${sel === 'space' ? inspSpace() : inspKeys()}</div>
  </section>
  <div class="panel kbrow">
    <div class="legend"><span class="cap" style="margin-bottom:2px">Where each sound plays</span>
      <div style="--c:var(--slot-0)" class="${keysOn ? '' : 'dim'}"><i></i>Keys<em>whole</em></div>
      <div style="--c:var(--slot-1)" class="${keysOn ? 'dim' : 'dim'}"><i></i>Pad<em>whole</em></div>
      <div style="--c:var(--slot-3)" class="dim"><i></i>Bass<em>up to B3</em></div></div>
    <div class="kbcol">
      <div class="rbar${keysOn ? ' on' : ''}" style="--c:var(--slot-0)"><i style="--a:0%;--b:0%"></i></div>
      <div class="rbar" style="--c:var(--slot-1)"><i style="--a:0%;--b:0%"></i></div>
      <div class="rbar" style="--c:var(--slot-3)"><i style="--a:0%;--b:60.7%"></i></div>
      ${keyboard(held)}</div>
    <div class="outm"><span class="cap">Output</span><div class="hmeter" style="width:100%"><b></b><b></b></div></div>
  </div>
</main>`;
  return page('Edit — angle D', css('common.css') + css('edit.css'), body);
}
