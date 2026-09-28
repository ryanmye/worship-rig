// Perform mockups: default, Keys quick panel open, Output (master) popover open.
import { page, css, topbar, vf, vm, knob, keyboard } from './lib.mjs';

const SLOTS = [
  { role: 'KEYS', c: 'var(--slot-0)', inst: 'Grand<br>Piano', v: 0.74, db: '−1.9 dB', m: 58, sus: true, oct: '0', space: 0.25 },
  { role: 'PAD', c: 'var(--slot-1)', inst: 'Warm Pad', sub: 'wheel 64%', v: 0.65, db: '−5.2 dB', m: 44, sus: true, oct: '0', space: 0.5 },
  null,
  { role: 'BASS', c: 'var(--slot-3)', inst: 'Sub Bass', v: 0.7, db: '−3.1 dB', m: 30, sus: false, oct: '−1', space: 0 },
];
const EMPTY_ROLES = ['KEYS', 'PAD', 'EXTRA', 'BASS'];

function quickRow(s, open) {
  const pct = Math.round(s.space * 100);
  return `<div class="quick${open ? ' open' : ''}" title="Quick settings for ${s.role.toLowerCase()}">
    <span><small>PEDAL</small><b class="${s.sus ? 'lit' : ''}"><i class="pip${s.sus ? '' : ' off'}"></i>${s.sus ? 'On' : 'Off'}</b></span>
    <span><small>OCT</small><b class="${s.oct !== '0' ? 'lit' : ''}">${s.oct}</b></span>
    <span><small>SPACE</small><b class="${pct ? 'lit' : ''}">${pct ? `<i class="ring" style="--v:${s.space}"></i>${pct}` : '—'}</b></span>
  </div>`;
}

function quickPanel(s) {
  return `<div class="qp">
    <div class="qh"><b>${s.role}</b><span>THIS SONG</span></div>
    <div class="qr"><div class="qline"><span class="ql">Sustain<br><span class="qs">${s.sus ? 'pedal holds' : 'pedal ignored'}</span></span><i class="sw${s.sus ? ' on' : ''}" style="--c:${s.c}"></i></div></div>
    <div class="qr"><span class="ql">Octave</span>
      <div class="step"><span>−</span><b>${s.oct}</b><span>+</span></div></div>
    <div class="qr"><span class="ql">Into Space</span>
      <div class="kn">${knob(s.space, s.c)}<strong>${Math.round(s.space * 100)}%</strong><em>Space is <b>Stage</b></em></div></div>
    <div class="more">Open in Edit ›</div>
  </div>`;
}

function slot(s, i, openIdx) {
  if (!s) {
    return `<div class="panel slot empty" style="--c:var(--slot-${i})"><div class="role">${EMPTY_ROLES[i]}</div>
      <div class="emptytxt">Empty</div></div>`;
  }
  const open = openIdx === i;
  return `<div class="panel slot" style="--c:${s.c}">
    ${open ? quickPanel(s) : ''}
    <div class="role">${s.role}</div><div class="inst">${s.inst}</div><div class="sub">${s.sub || ''}</div>
    <div class="fz">${vf(s.v, s.c)}</div>
    <div class="db">${s.db}</div>
    ${quickRow(s, open)}
    <span class="btn mute">MUTE</span>
  </div>`;
}

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function outputPopover() {
  return `<div class="op">
    <div class="oh"><b>Output &amp; playing</b><span class="scope">ALL SONGS</span></div>
    <div class="orow" style="border-top:0;padding-top:2px"><div><b>Master</b><span>Everything you send to the PA</span></div>
      <div style="display:flex;align-items:center;gap:10px"><div class="hslider" style="--v:62%;width:110px"></div><b style="white-space:nowrap">−6.0 dB</b></div></div>
    <div class="orow"><div><b>Mono</b><span>One speaker or a mono PA</span></div><i class="sw"></i></div>
    <div class="orow"><div><b>Touch</b><span>How hard you play for full volume</span></div>
      <div class="seg"><span>Light</span><span class="on">Normal</span><span>Heavy</span><span>Fixed</span></div></div>
    <div class="orow"><div><b>Sustain pedal</b><span>Pedal: <span style="color:var(--ok)">● up</span></span></div>
      <div style="display:flex;gap:8px;align-items:center"><span class="btn sm">Test</span><span class="btn sm ghost"><i class="sw" style="transform:scale(.7);margin:-4px"></i>Reversed</span></div></div>
    <div class="orow"><div><b>Keyboard picks songs</b><span>Patch buttons 1, 2, 3… = songs</span></div><i class="sw"></i></div>
    <div class="orow"><div><b>Sound stopped?</b><span>Latency 12 ms · Lowest</span></div><span class="btn sm">Restart audio</span></div>
    <div class="ofoot"><span class="faint">Locked while Lock is on</span><a>All settings ›</a></div>
  </div>`;
}

export function performPage({ open = -1, output = false } = {}) {
  const held = new Set([50, 62, 66, 69]);
  const body = `${topbar({ view: 'perform', masterOpen: output })}
<main class="pf">
  <div class="row">
    <div class="panel song"><h1>Sunday Pad + Piano</h1><div class="key"><span class="cap">Key</span><b>D</b></div>
      <span class="btn sm notesbtn">Notes <i class="led acc" style="width:7px;height:7px"></i></span></div>
    <div class="panel tp"><span class="cap">Transpose</span><div class="ctl"><span class="btn">−</span><b>0</b><span class="btn">+</span></div></div>
    <div class="panel sv"><div><span class="cap">Space</span><span class="sel">Stage</span></div><div><span class="cap">Vibe</span><span class="sel">Full Set</span></div></div>
    <div class="panel chord"><span class="cap">Chord</span><b>D</b></div>
  </div>
  <div class="row">
    <div class="panel prev">◀ Prev</div>
    <div class="panel strip">
      <span class="chip on"><small>1</small>Sunday Pad + Piano<small>D</small></span>
      <span class="chip"><small>2</small>Building Swell<small>G</small></span>
      <span class="chip"><small>3</small>Prayer Wash<small>E</small></span>
      <span class="chip"><small>4</small>Organ Swell<small>A</small></span>
      <span class="chip"><small>5</small>Grand Piano<small>C</small></span>
      <span class="chip"><small>6</small>Rhodes<small>F</small></span>
    </div>
    <div class="panel next"><span class="cap">Next ▸</span><b>Building Swell · G</b></div>
  </div>
  <div class="row">
    <div class="panel wheel"><span class="cap">Wheel</span><div class="bar"><i></i></div><big>64%</big>
      <div class="small">→ Pad level<br>Expr 100%</div><span class="btn">◢<br>Swell</span>
      <div class="small" style="display:flex;gap:6px;align-items:center"><i class="led ok" style="width:8px;height:8px"></i>PEDAL</div></div>
    ${SLOTS.map((s, i) => slot(s, i, open)).join('\n    ')}
    <div class="panel drone">
      <div class="hd"><div><span class="cap">Key &amp; drone</span><b>D major · +1.6 dB</b></div>
        <div class="seg"><span>Off</span><span class="on">Synth</span><span>My Pads</span></div></div>
      <div class="keys">${KEYS.map((k) => `<span class="${k === 'D' ? 'on' : ''}">${k}</span>`).join('')}</div>
      <div class="lvl"><div class="seg"><span class="on">Major</span><span>Minor</span></div><span class="cap">Level</span>
        <div class="hslider" style="--v:72%;--c:var(--accent)"></div><b>+1.6 dB</b></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><span class="pill"><i class="led" style="width:8px;height:8px"></i>Follow chords <span class="tag">EXPERIMENTAL</span></span>
        <span class="pill lit"><i class="led acc" style="width:8px;height:8px"></i>Continue across songs</span></div>
      <div class="foot"><span>My Pads: no folder chosen</span><span class="btn sm">Choose folder…</span></div>
    </div>
    <div class="panel notes"><span class="cap">Notes</span>
      <p>The everyday worship sound: grand piano on top of a warm pad, with a soft key drone underneath. Mod wheel (and an
      expression pedal) brings the pad in and out, so you can start with piano alone and swell the pad for the chorus.
      Push the pitch-bend wheel up to lift the drone; pull it down to tuck it away.</p></div>
  </div>
  <div class="row">
    <div class="panel kbwrap">${keyboard(held)}</div>
    <div class="panel bigbtn dim">↺ Revert song</div>
    <div class="panel bigbtn fade">Fade out</div>
    <div class="panel bigbtn panic">PANIC</div>
    <div class="panel bigbtn"><i class="led" style="margin-right:8px"></i>Lock</div>
  </div>
</main>
${output ? outputPopover() : ''}`;
  return page('Perform — angle D', css('common.css') + css('perform.css'), body);
}
