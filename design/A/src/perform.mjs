import { icon, knob, vfader, hfader, keyboard } from './helpers.mjs';

export function topbar(view, { quickOn = false } = {}) {
  return `<header class="topbar">
    <div class="brand">${icon('bars', 22)}Worship Rig</div>
    <div class="tabs"><button class="${view === 'perform' ? 'on' : ''}">Perform</button><button class="${view === 'edit' ? 'on' : ''}">Edit</button></div>
    ${view === 'perform' ? `<button class="quickbtn${quickOn ? ' on' : ''}">${icon('sliders', 20)}Quick</button>` : ''}
    <button class="iconbtn" title="All settings">${icon('gear', 20)}</button>
    <div class="status">
      <span><i class="led ok"></i>MIDI <span class="dim">Nord Stage 3</span></span>
      <span><i class="led ok"></i>Sound OK <span class="dim">12 ms</span></span>
      <span><i class="led ok"></i><span style="color:var(--ok);letter-spacing:.06em">READY</span></span>
    </div>
    <button class="rec"><i></i>REC</button>
    <span class="timer">00:00</span>
    <div class="hmeter"><div style="--l:58%"></div><div style="--l:54%"></div></div>
    <div class="master">MASTER ${hfader(0.55, '#eef1f5')}<b>−6.0 dB</b></div>
  </header>`;
}

export const PERFORM_CSS = `
.perform { flex: 1; display: grid; gap: 12px; padding: 12px 14px 14px;
  grid-template-columns: 96px 1fr 1fr 1fr 1fr 404px 296px;
  grid-template-rows: 112px 54px 1fr 94px; min-height: 0; position: relative; }
.r1 { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 196px 392px 196px; gap: 12px; min-width: 0; }
.r2 { grid-column: 1 / -1; display: grid; grid-template-columns: 110px 1fr 260px; gap: 12px; min-width: 0; }
.song { padding: 12px 20px; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.song h1 { margin: 0; font-size: 44px; line-height: 1.05; letter-spacing: -.01em; white-space: nowrap; }
.song .key { display: flex; align-items: baseline; gap: 10px; margin-top: 4px; }
.song .key b { color: var(--accent); font-size: 34px; line-height: 1; }
.song .notesbtn { display: none; }
.transpose { padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
.transpose .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.transpose .row button { width: 52px; height: 48px; font-size: 26px; font-weight: 700; border: 1px solid var(--line-2); background: var(--panel-2); border-radius: var(--radius-sm); }
.transpose .row b { font-size: 30px; }
.soundcard { padding: 10px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: stretch; }
.fxpill { border: 1px solid var(--line-2); background: var(--panel-2); border-radius: var(--radius); padding: 8px 12px;
  display: grid; grid-template-columns: auto 1fr auto; grid-template-rows: auto auto; column-gap: 10px; align-items: center; text-align: left; }
.fxpill .ic { grid-row: 1 / 3; color: var(--fx); }
.fxpill .cap { font-size: 11px; }
.fxpill b { font-size: 20px; font-weight: 700; white-space: nowrap; }
.fxpill b small { font-size: 13px; color: var(--muted); font-weight: 600; margin-left: 4px; }
.fxpill > .ic:last-child { grid-row: 1 / 3; grid-column: 3; color: var(--faint); }
.chord { padding: 12px 18px; }
.chord b { display: block; font-size: 46px; line-height: 1.1; margin-top: 4px; }
.prev { display: grid; place-items: center; font-weight: 700; color: var(--muted); border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); font-size: 17px; }
.setlist { display: flex; gap: 8px; overflow: hidden; padding: 6px; }
.chip { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: var(--radius-sm); background: var(--panel-2); border: 1px solid var(--line-2); font-weight: 700; font-size: 17px; white-space: nowrap; }
.chip small { color: var(--faint); font-size: 12px; } .chip em { font-style: normal; color: var(--faint); font-size: 13px; }
.chip.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); } .chip.on small, .chip.on em { color: #5a4600; }
.next { padding: 7px 14px; }
.next .cap { font-size: 11px; } .next b { display: block; font-size: 18px; }

.wheel { grid-column: 1; padding: 12px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.wheel .bar { width: 34px; flex: 1; border-radius: 8px; background: #252a33; position: relative; overflow: hidden; }
.wheel .bar div { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; background: #8d9bb0; border-radius: 8px; }
.wheel .val { font-size: 22px; font-weight: 700; }
.wheel .to { font-size: 11.5px; color: var(--muted); text-align: center; }
.wheel .swell { width: 100%; height: 44px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 13px; }
.wheel .ind { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; color: var(--muted); }
.wheel .ind.on { color: var(--text); } .wheel .ind.on i { background: var(--accent); box-shadow: 0 0 8px var(--accent); }

.strip { --c: var(--slot-0); display: flex; flex-direction: column; align-items: stretch; padding: 10px 9px 9px; gap: 8px;
  border-top: 3px solid var(--c); min-width: 0; position: relative; }
.strip.s1 { --c: var(--slot-1); } .strip.s2 { --c: var(--slot-2); } .strip.s3 { --c: var(--slot-3); }
.strip .head { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.strip .role { display: flex; align-items: center; gap: 6px; color: var(--c); font-weight: 800; font-size: 13px; letter-spacing: .1em; }
.strip .role i { width: 8px; height: 8px; border-radius: 50%; background: var(--led-off); }
.strip.playing .role i { background: var(--c); box-shadow: 0 0 8px var(--c); }
.strip .ico { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: var(--c);
  background: color-mix(in srgb, var(--c) 13%, transparent); }
.strip .name { font-weight: 700; font-size: 17px; line-height: 1.15; }
.strip .tag { font-size: 11.5px; color: var(--muted); font-weight: 600; }
.strip .fz { flex: 1; min-height: 90px; }
.strip .db { text-align: center; font-weight: 700; font-size: 18px; }
.mods { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.mod { position: relative; overflow: hidden; height: 38px; border-radius: 6px; border: 1px solid var(--line); background: transparent;
  display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.05; padding: 0 2px 3px; }
.mod span { font-size: 11px; color: var(--muted); font-weight: 650; }
.mod b { font-size: 14px; color: var(--faint); font-weight: 600; }
.mod.on b { color: var(--text); font-weight: 700; }
.mod i { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--c); }
.mod.on { border-color: color-mix(in srgb, var(--c) 60%, var(--line-2)); background: color-mix(in srgb, var(--c) 10%, var(--panel-2)); }
.mod.on span { color: var(--text); }
.mod.open { border-color: var(--c); box-shadow: 0 0 0 2px var(--c); }
.strip .mute { height: 40px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 800; letter-spacing: .08em; font-size: 14px; }
.strip.empty .fz { display: grid; place-items: center; color: var(--faint); font-weight: 600; text-align: center; font-size: 14px; }
.strip.empty .ico { background: transparent; color: var(--faint); }
.strip.empty .name { color: var(--faint); }

.drone { grid-column: 6; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; border-top: 3px solid var(--drone); }
.drone .hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.drone .hd .t { display: flex; align-items: center; gap: 9px; color: var(--drone); }
.drone .hd .t b { display: block; color: var(--text); font-size: 17px; }
.drone .seg button { height: 38px; white-space: nowrap; } .drone .seg button.on { --c: var(--drone); }
.keygrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.keygrid button { height: 42px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 17px; }
.keygrid button.on { background: var(--drone); color: #1c1606; border-color: var(--drone); }
.drone .lv { display: flex; align-items: center; gap: 10px; }
.drone .lv .hfader { flex: 1; } .drone .lv b { font-size: 14px; min-width: 58px; text-align: right; }
.drone .char { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.drone .char > div { display: flex; align-items: center; gap: 9px; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 10px; }
.drone .char b { display: block; font-size: 14px; } .drone .char small { color: var(--muted); font-size: 12px; }
.drone .tg { display: flex; gap: 8px; flex-wrap: wrap; } .drone .tg .tog { --c: var(--drone); height: 36px; font-size: 13.5px; }
.padsrow { margin-top: auto; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 9px; }
.padsrow b { color: var(--text); font-weight: 600; } .padsrow .btn { margin-left: auto; }
.notes { grid-column: 7; padding: 14px 16px; }
.notes p { margin: 10px 0 0; font-size: 16.5px; line-height: 1.5; color: #dfe4ea; }
.bottom { grid-column: 1 / 8; display: grid; grid-template-columns: 1fr 120px 118px 132px 112px; gap: 12px; }
.kb-card { padding: 8px 10px 10px; }
.bigbtn { border-radius: var(--radius); border: 1px solid var(--line-2); background: var(--panel); font-weight: 700; font-size: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; }
.bigbtn.fade { background: #182231; }
.bigbtn.panic { background: var(--panic-bg); color: var(--panic-text); border: 2px solid var(--danger); font-size: 21px; letter-spacing: .04em; }
.bigbtn.revert { color: var(--faint); background: transparent; border-color: var(--line); }

/* 1024-wide: Notes collapse into a button (as the app does today), strips narrow */
@media (max-width: 1250px) {
  .perform { grid-template-columns: 82px 1fr 1fr 1fr 1fr 352px; grid-template-rows: 94px 50px 1fr 74px; gap: 10px; padding: 10px 12px 12px; }
  .r1 { grid-template-columns: 1fr 168px 210px 120px; gap: 10px; } .r2 { grid-template-columns: 92px 1fr 200px; gap: 10px; }
  .song { padding: 8px 14px; } .song h1 { font-size: 34px; } .song .key b { font-size: 28px; }
  .song { position: relative; } .song .notesbtn { display: flex; position: absolute; right: 12px; bottom: 10px; }
  .transpose { padding: 8px 10px; } .transpose .row button { width: 40px; height: 42px; font-size: 22px; } .transpose .row b { font-size: 24px; }
  .soundcard { grid-template-columns: 1fr; gap: 6px; padding: 7px 8px; }
  .fxpill { padding: 2px 8px; } .fxpill b { font-size: 15px; } .fxpill .cap { font-size: 10px; } .fxpill b small { display: none; }
  .fxpill .ic { width: 16px; }
  .chord { padding: 8px 14px; } .chord b { font-size: 38px; }
  .chip { font-size: 15px; } .next b { font-size: 16px; }
  .notes { display: none; } .padsrow { display: none; }
  .drone { grid-column: 6; padding: 9px 10px; gap: 7px; } .keygrid button { height: 34px; font-size: 15px; }
  .drone .char > div { padding: 3px 8px; } .drone .tg .tog { height: 32px; font-size: 12.5px; padding: 0 9px; }
  .drone .hd .t b { font-size: 15px; } .drone .seg button { height: 32px; padding: 0 9px; font-size: 13px; }
  .strip { padding: 7px 6px 6px; gap: 5px; } .strip .ico { width: 30px; height: 30px; } .strip .ico .ic { width: 20px; height: 20px; }
  .strip .name { font-size: 14.5px; } .strip .db { font-size: 15px; } .strip .fz { min-height: 60px; }
  .mod { height: 32px; } .mod span { font-size: 10px; } .mod b { font-size: 12.5px; }
  .strip .mute { height: 34px; font-size: 12.5px; }
  .wheel { padding: 8px 6px; gap: 5px; } .wheel .val { font-size: 18px; } .wheel .swell { height: 36px; }
  .bottom { grid-column: 1 / 7; grid-template-columns: 1fr 96px 96px 112px 92px; gap: 10px; }
  .bigbtn { font-size: 14px; } .bigbtn.panic { font-size: 18px; }
  .kb-card { padding: 5px 8px 7px; }
  .drone .char .knob-svg { width: 30px; height: 30px; }
}

/* Popover (slot chip → the same knob as Edit) */
.pop { position: absolute; z-index: 20; width: 272px; padding: 14px; border-radius: 12px; background: #20242c; border: 1px solid var(--c);
  box-shadow: 0 18px 50px #000c, 0 0 0 1px #000; --c: var(--slot-1); }
.pop::before { content: ''; position: absolute; bottom: -8px; left: var(--nx, 40px); width: 14px; height: 14px; background: #20242c;
  border-right: 1px solid var(--c); border-bottom: 1px solid var(--c); transform: rotate(45deg); }
.pop .knob-svg { flex: none; }
.pop .ph { display: flex; align-items: center; gap: 8px; }
.pop .ph b { font-size: 16px; } .pop .ph span { color: var(--c); font-weight: 800; font-size: 12px; letter-spacing: .1em; }
.pop .pb { display: flex; align-items: center; gap: 14px; margin-top: 10px; }
.pop .pb .v b { display: block; font-size: 24px; } .pop .pb .v small { color: var(--muted); font-size: 12.5px; line-height: 1.35; display: block; }
.pop .pf { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); display: flex; gap: 6px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); align-items: center; }
.pop .pf .btn { min-height: 28px; font-size: 12.5px; }
`;

const SLOTS = [
  { i: 0, role: 'KEYS', icon: 'piano', name: 'Grand Piano', pos: 0.72, db: '−1.9 dB', room: 25, echo: 10, chorus: 0, oct: '0' },
  { i: 1, role: 'PAD', icon: 'pad', name: 'Warm Pad', tag: 'wheel 100%', pos: 0.6, db: '−5.2 dB', room: 50, echo: 10, chorus: 35, oct: '0' },
  { i: 2, role: 'EXTRA', empty: true },
  { i: 3, role: 'BASS', icon: 'bass', name: 'Sub Bass', pos: 0.66, db: '−3.1 dB', room: 0, echo: 0, chorus: 0, oct: '−1' },
];

function strip(s, { openChip } = {}) {
  if (s.empty) {
    return `<div class="card strip s${s.i} empty"><div class="head"><div class="role"><i></i>${s.role}</div>
      <div class="ico">${icon('empty', 26)}</div><div class="name">Empty</div></div>
      <div class="fz">Nothing here.<br><span style="font-size:12.5px">Add a sound in Edit</span></div></div>`;
  }
  const mod = (label, val, pct, key) => `<button class="mod${pct > 0 || (key === 'oct' && val !== '0') ? ' on' : ''}${openChip === `${s.i}-${key}` ? ' open' : ''}"><span>${label}</span><b>${val}</b>${key !== 'oct' ? `<i style="width:${pct}%"></i>` : ''}</button>`;
  return `<div class="card strip s${s.i} playing">
    <div class="head"><div class="role"><i></i>${s.role}</div>
      <div class="ico">${icon(s.icon, 26)}</div><div class="name">${s.name}</div>${s.tag ? `<div class="tag">↻ ${s.tag}</div>` : ''}</div>
    <div class="fz">${vfader(s.pos, 'var(--c)')}</div>
    <div class="db">${s.db}</div>
    <div class="mods">
      ${mod('Space', s.room ? `${s.room}%` : 'off', s.room, 'room')}${mod('Echo', s.echo ? `${s.echo}%` : 'off', s.echo, 'echo')}
      ${mod('Chorus', s.chorus ? `${s.chorus}%` : 'off', s.chorus, 'chorus')}${mod('Octave', s.oct, 0, 'oct')}
    </div>
    <button class="mute">MUTE</button>
  </div>`;
}

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function performBody({ quick = '', popover = false } = {}) {
  const held = [38, 62, 66, 69]; // D2 + D4 F#4 A4
  return `${topbar('perform', { quickOn: !!quick })}
  <main class="perform">
    <div class="r1"><section class="card song"><h1>Sunday Pad + Piano</h1><div class="key"><span class="cap">Key</span><b>D</b></div>
      <button class="btn sm notesbtn">${icon('note', 16)}Notes</button></section>
    <section class="card transpose"><span class="cap">Transpose</span><div class="row"><button>−</button><b>0</b><button>+</button></div></section>
    <section class="card soundcard">
      <button class="fxpill">${icon('room', 26)}<span class="cap">Space</span><b>Hall</b>${icon('down', 18)}</button>
      <button class="fxpill">${icon('echo', 26)}<span class="cap">Echo</span><b>Custom<small>≈ Quarter</small></b>${icon('down', 18)}</button>
    </section>
    <section class="card chord"><span class="cap">Chord</span><b>D</b></section></div>

    <div class="r2"><div class="prev">◀ Prev</div>
    <div class="card setlist">
      <div class="chip on"><small>1</small>Sunday Pad + Piano<em>D</em></div>
      <div class="chip"><small>2</small>Building Swell<em>G</em></div>
      <div class="chip"><small>3</small>Prayer Wash<em>E</em></div>
      <div class="chip"><small>4</small>Organ Swell<em>A</em></div>
      <div class="chip"><small>5</small>Grand Piano<em>C</em></div>
    </div>
    <div class="card next"><span class="cap">Next ▶</span><b>Building Swell · G</b></div></div>

    <section class="card wheel"><span class="cap">Wheel</span><div class="bar"><div></div></div><div class="val">100%</div>
      <div class="to">→ Pad level</div><button class="swell">◢ Swell</button>
      <div class="ind on"><i class="led"></i>PEDAL</div><div class="ind"><i class="led"></i>BEND</div></section>
    ${SLOTS.map((s) => strip(s, { openChip: popover ? '1-room' : '' })).join('')}
    <section class="card drone">
      <div class="hd"><div class="t">${icon('drone', 26)}<div><span class="cap" style="color:var(--drone)">Key drone</span><b>D major</b></div></div>
        <div class="seg"><button>Off</button><button class="on">Synth</button><button>My Pads</button></div></div>
      <div class="keygrid">${KEYS.map((k) => `<button class="${k === 'D' ? 'on' : ''}">${k}</button>`).join('')}</div>
      <div class="lv"><div class="seg" style="--c:var(--drone)"><button class="on">Major</button><button>Minor</button></div>
        ${hfader(0.68, 'var(--drone)')}<b>+1.6 dB</b></div>
      <div class="char">
        <div>${knob(0.4, 'var(--drone)', 36, { stroke: 4 })}<div><b>Brightness</b><small>Soft · 40%</small></div></div>
        <div>${knob(0.3, 'var(--drone)', 36, { stroke: 4 })}<div><b>Movement</b><small>Gentle · 30%</small></div></div>
      </div>
      <div class="tg"><span class="tog"><i></i>Follow chords</span><span class="tog on"><i></i>Continue across songs</span></div>
      <div class="padsrow">My Pads folder: <b>Worship Pads</b> · 12 keys found<button class="btn sm ghost">Change…</button></div>
    </section>
    <section class="card notes"><span class="cap">Notes</span>
      <p>The everyday worship sound: grand piano on top of a warm pad, with a soft key drone underneath. Mod wheel (and an expression pedal) brings the pad in and out, so you can start with piano alone and swell the pad for the chorus. Push the pitch-bend wheel up to lift the drone; pull it down to tuck it away.</p></section>

    <div class="bottom">
      <div class="card kb-card">${keyboard(36, 96, {
        held,
        ranges: [
          { low: 0, high: 127, color: 'var(--slot-0)' },
          { low: 0, high: 127, color: 'var(--slot-1)' },
          { low: 0, high: 59, color: 'var(--slot-3)' },
        ],
      })}</div>
      <button class="bigbtn revert">↺ Revert</button>
      <button class="bigbtn fade">Fade out</button>
      <button class="bigbtn panic">PANIC</button>
      <button class="bigbtn">${icon('lock', 18)}Lock</button>
    </div>
    ${popover ? `<div class="pop" style="left:248px;top:574px;--nx:40px;transform:translateY(-100%)">
      <div class="ph"><span>PAD</span><b>Space</b><span style="margin-left:auto;color:var(--muted);font-weight:600;letter-spacing:0">into Hall</span></div>
      <div class="pb">${knob(0.5, 'var(--slot-1)', 84)}<div class="v"><b>50%</b><small>How much of the pad goes into the shared room. Same knob as in Edit.</small></div></div>
      <div class="pf">Room sound: <b style="color:var(--text)">Hall</b><button class="btn sm ghost" style="margin-left:auto">Change space…</button></div>
    </div>` : ''}
    ${quick}
  </main>`;
}
