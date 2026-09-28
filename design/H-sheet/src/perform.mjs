import { icon, vfader, hfader, keyboard } from './helpers.mjs';

// H = A-v2's Perform frame (same positions as today) + B's lit ON tiles, one-tap shared-effect chips,
// and the "lock protects the song file, not your playing" rule.

export function topbar(view, { quickOn = false, locked = false } = {}) {
  return `<header class="topbar">
    <div class="brand">${icon('bars', 22)}<span class="bt">Worship Rig</span></div>
    <div class="tabs"><button class="${view === 'perform' ? 'on' : ''}">Perform</button><button class="${view === 'edit' ? 'on' : ''}${locked ? ' frozen' : ''}">Edit</button></div>
    ${view === 'perform' ? `<button class="quickbtn${quickOn ? ' on' : ''}">${icon('sliders', 20)}Quick</button>` : ''}
    <button class="iconbtn${locked ? ' frozen' : ''}" title="All settings">${icon('gear', 20)}</button>
    <div class="status">
      <span><i class="led ok"></i>MIDI <span class="dim">Nord Stage 3</span></span>
      <span><i class="led ok"></i>Sound OK <span class="dim">12 ms</span></span>
      <span><i class="led ok"></i><span style="color:var(--ok);letter-spacing:.06em">READY</span></span>
    </div>
    <button class="rec"><i></i>REC</button>
    <span class="timer">00:00</span>
    <div class="hmeter"><div style="--l:58%"></div><div style="--l:54%"></div></div>
    <div class="master"><span class="ml">MASTER</span> ${hfader(0.55, '#eef1f5')}<b>−6.0 dB</b></div>
  </header>`;
}

export const PERFORM_CSS = `
:root { --panic: #d9363a; --sel-fx: #3a4250; }
.frozen { opacity: .38; }
.perform { flex: 1; display: grid; gap: 12px; padding: 12px 14px 14px;
  grid-template-columns: 92px 1fr 1fr 60px 1fr 400px 270px;
  grid-template-rows: 112px 54px 1fr 94px; min-height: 0; position: relative; }
.perform.full4 { grid-template-columns: 92px 1fr 1fr 1fr 1fr 400px 240px; }
.r1 { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) 176px 584px 128px; gap: 12px; min-width: 0; }
.r2 { grid-column: 1 / -1; display: grid; grid-template-columns: 110px 1fr 250px; gap: 12px; min-width: 0; }
.song { padding: 10px 20px; min-width: 0; display: flex; flex-direction: column; justify-content: center; position: relative; }
.song h1 { margin: 0; font-size: 42px; line-height: 1.05; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song .key { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.keybtn { display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 10px 0 12px; border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line-2)); background: color-mix(in srgb, var(--accent) 8%, var(--panel-2)); }
.keybtn b { color: var(--accent); font-size: 28px; line-height: 1; }
.keybtn .ic { color: var(--accent); }
.keybtn.open { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.song .bpm { font-size: 14px; color: var(--muted); font-weight: 600; }
.song .playin { font-size: 15px; font-weight: 700; color: var(--text); padding: 4px 10px; border-radius: 8px; background: #2e2716; }
.song .playin span { color: var(--muted); font-weight: 600; }
.song .notesbtn { display: none; }
.hold { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 800; letter-spacing: .08em; color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 60%, transparent); border-radius: 5px; padding: 1px 5px; line-height: 14px; white-space: nowrap; }
.transpose { padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
.transpose .th { display: flex; justify-content: space-between; align-items: center; }
.transpose .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.transpose .row button { width: 46px; height: 48px; font-size: 26px; font-weight: 700; border: 1px solid var(--line-2); background: var(--panel-2); border-radius: var(--radius-sm); }
.transpose .row b { font-size: 30px; } .transpose .row b.shift { color: var(--accent); }

/* shared-effect chips: one tap, neutral colour (never a slot colour) */
.fxcard { padding: 9px 12px; display: grid; grid-template-rows: 1fr 1fr; gap: 8px; min-width: 0; }
.fxrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fxrow .lab { width: 70px; flex: none; display: flex; align-items: center; gap: 7px; color: var(--fx); }
.fxrow .lab span { font-size: 11.5px; font-weight: 800; letter-spacing: .1em; color: var(--muted); }
.fxc { height: 40px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 14.5px; white-space: nowrap; color: #d7dce3; }
.fxc.on { background: var(--sel-fx); border: 2px solid #f1f4f8; color: #fff; }
.fxc.near { border: 1.5px dashed #8e99a8; }
.fxc.own { display: inline-flex; flex-direction: column; justify-content: center; line-height: 1.05; font-size: 13.5px; }
.fxc.own small { font-size: 11px; font-weight: 600; color: #b9c2cd; }
.fxc.more { padding: 0 8px; color: var(--muted); display: inline-flex; align-items: center; }
.fxpill { display: none; }
.chord { padding: 12px 18px; }
.chord b { display: block; font-size: 46px; line-height: 1.1; margin-top: 4px; }
.prev { display: grid; place-items: center; font-weight: 700; color: var(--muted); border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); font-size: 17px; }
.setlist { display: flex; gap: 8px; overflow: hidden; padding: 6px; }
.chip { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: var(--radius-sm); background: var(--panel-2); border: 1px solid var(--line-2); font-weight: 700; font-size: 17px; white-space: nowrap; }
.chip small { color: var(--faint); font-size: 12px; } .chip em { font-style: normal; color: var(--faint); font-size: 13px; }
.chip.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); } .chip.on small, .chip.on em { color: #5a4600; }
.next { padding: 6px 12px 6px 14px; display: flex; align-items: center; gap: 10px; text-align: left; }
.next .cap { font-size: 11px; display: block; } .next b { display: block; font-size: 18px; white-space: nowrap; } .next b em { font-style: normal; color: var(--accent); }
.next .ic { margin-left: auto; color: var(--muted); }

.wheel { grid-column: 1; padding: 12px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.wheel .bar { width: 34px; flex: 1; border-radius: 8px; background: #252a33; position: relative; overflow: hidden; }
.wheel .bar div { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; background: #8d9bb0; border-radius: 8px; }
.wheel .val { font-size: 22px; font-weight: 700; }
.wheel .to { font-size: 11.5px; color: var(--muted); text-align: center; }
.wheel .swell { width: 100%; height: 44px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 13px; }
.wheel .ind { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; color: var(--muted); }
.wheel .ind.on { color: var(--text); } .wheel .ind.on i { background: var(--accent); box-shadow: 0 0 8px var(--accent); }

/* ---- strips: ON tile (= mute) on top, fader, 2×2 modifier chips at the foot */
.strip { --c: var(--slot-0); display: flex; flex-direction: column; align-items: stretch; padding: 9px 9px 10px; gap: 7px; min-width: 0; position: relative; }
.strip.s1 { --c: var(--slot-1); } .strip.s2 { --c: var(--slot-2); } .strip.s3 { --c: var(--slot-3); }
.ontile { height: 46px; flex: none; border-radius: 9px; display: flex; align-items: center; gap: 8px; padding: 0 7px 0 10px;
  border: 1.5px solid var(--c); background: color-mix(in srgb, var(--c) 17%, var(--panel-2)); text-align: left; }
.ontile i { width: 11px; height: 11px; border-radius: 50%; background: var(--c); box-shadow: 0 0 9px var(--c); flex: none; }
.ontile .r { font-weight: 800; font-size: 14px; letter-spacing: .1em; color: var(--c); }
.ontile .st { margin-left: auto; font-size: 12.5px; font-weight: 800; letter-spacing: .06em; padding: 3px 7px; border-radius: 5px; background: var(--c); color: #0d0f12; }
.strip .who { display: flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; }
.strip .who .ic { color: var(--c); }
.strip .name { font-weight: 700; font-size: 17px; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.strip .tagline { height: 20px; flex: none; display: flex; justify-content: center; align-items: center; gap: 5px; }
.strip .tagline .tg { font-size: 11.5px; color: var(--muted); font-weight: 600; white-space: nowrap; }
.strip .tagline .bd { font-size: 11.5px; font-weight: 700; padding: 0 7px; border-radius: 10px; color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 55%, transparent); white-space: nowrap; line-height: 17px; }
.strip .fz { flex: 1; min-height: 80px; }
.strip .db { text-align: center; font-weight: 700; font-size: 18px; }
.mods { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mod { position: relative; overflow: hidden; height: 46px; border-radius: 8px; border: 1.5px solid var(--line-2); background: transparent;
  display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.12; padding: 0 2px 3px; color: #9aa3af; }
.mod span { font-size: 13px; font-weight: 800; }
.mod b { font-size: 13px; font-weight: 600; }
.mod.on { background: var(--c); border-color: var(--c); color: #0d0f12; } .mod.on b { font-weight: 800; }
.mod > i { position: absolute; left: 0; bottom: 0; height: 4px; background: #0d0f1266; }
.mod.open { box-shadow: 0 0 0 3px var(--bg), 0 0 0 5px var(--c); }
.mod.sus { flex-direction: row; gap: 7px; }
.mod.sus em { width: 10px; height: 10px; border-radius: 50%; background: var(--led-off); flex: none; }
.mod.sus.lit { border-color: color-mix(in srgb, var(--c) 60%, var(--line-2)); color: var(--text); }
.mod.sus.lit em { background: var(--c); box-shadow: 0 0 8px var(--c); }
.mod.sus.offwarn { border-color: var(--warn); color: var(--warn); }
/* empty slot collapses to a narrow column (B) */
.strip.empty { padding: 8px 4px; align-items: center; justify-content: center; gap: 12px; border: 1.5px dashed color-mix(in srgb, var(--c) 45%, var(--line-2)); background: transparent; }
.strip.empty .vt { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 12px; font-weight: 800; letter-spacing: .14em; color: var(--c); white-space: nowrap; }
.strip.empty .vt span { color: var(--faint); font-weight: 600; letter-spacing: .04em; }
.strip.empty .plus { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--line-2); display: grid; place-items: center; color: var(--muted); }
/* OFF (muted): the tile turns grey with a loud amber OFF; everything that says "sounding" greys out */
.strip.off .ontile { border-color: color-mix(in srgb, var(--warn) 70%, transparent); background: #1d1a14; }
.strip.off .ontile i { background: var(--led-off); box-shadow: none; }
.strip.off .ontile .r { color: #7d8693; }
.strip.off .ontile .st { background: var(--warn); color: #1d1400; font-size: 13.5px; padding: 3px 9px; }
.strip.off .who, .strip.off .tagline { opacity: .45; }
.strip.off .vf-fill { background: #4d5562 !important; }
.strip.off .db { color: var(--faint); text-decoration: line-through; text-decoration-thickness: 2px; }
.strip.off .mod, .strip.off .mod.on { background: transparent; border-color: #3a414d; color: #6b7380; }
.strip.off .mod > i { display: none; } .strip.off .mod.sus em { background: var(--led-off); box-shadow: none; }

/* ---- in-strip step panel (chip → big steps), never wider than its own strip */
.amt { position: absolute; z-index: 20; left: 5px; right: 5px; top: 5px; bottom: 160px; border-radius: 10px; background: #1f242c;
  border: 2px solid var(--c); box-shadow: 0 14px 40px #000c; display: flex; flex-direction: column; padding: 9px 8px 8px; }
.amt.low { bottom: 108px; }
.amt::after { content: ''; position: absolute; bottom: -9px; left: var(--ax, 22%); width: 14px; height: 14px; background: #1f242c;
  border-right: 2px solid var(--c); border-bottom: 2px solid var(--c); transform: rotate(45deg); }
.amt .ah { display: flex; align-items: flex-start; gap: 6px; }
.amt .ah b { font-size: 15px; line-height: 1.15; } .amt .ah b span { color: var(--c); font-size: 11px; letter-spacing: .1em; display: block; }
.amt .ah .x { margin-left: auto; width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--line-2); background: var(--panel-2); display: grid; place-items: center; flex: none; }
.amt .to { font-size: 12px; color: var(--muted); margin: 2px 0 8px; } .amt .to em { font-style: normal; color: var(--fx); font-weight: 700; }
.amt .ab { flex: 1; display: grid; grid-template-columns: 1fr 26px; gap: 8px; min-height: 0; }
.amt .ab.nofine { grid-template-columns: 1fr; }
.steps { display: flex; flex-direction: column; gap: 5px; }
.steps button { flex: 1; min-height: 32px; border-radius: 7px; border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 800; font-size: 15px; }
.steps button.on { background: var(--c); color: #0d0f12; border-color: var(--c); }
.fine { position: relative; }
.fine .t { position: absolute; left: 10px; width: 6px; top: 4px; bottom: 4px; border-radius: 3px; background: var(--track); overflow: hidden; }
.fine .t em { position: absolute; left: 0; right: 0; bottom: 0; background: var(--c); }
.fine .th { position: absolute; left: 0; width: 26px; height: 16px; border-radius: 4px; background: linear-gradient(#fbfcfd, #d5dae1); box-shadow: 0 1px 4px #0009; }
.amt .af { font-size: 11px; color: var(--faint); margin-top: 7px; text-align: center; line-height: 1.3; }

/* ---- key & drone (Tonic pattern: ON tile, source, key, level, 2 character sliders) */
.drone { grid-column: 6; padding: 9px 14px 12px; display: flex; flex-direction: column; gap: 10px; --c: var(--drone); }
.drone .hd { display: flex; align-items: center; gap: 10px; }
.drone .ontile { flex: 1; }
.drone .ontile .r { white-space: nowrap; }
.drone .ontile .r small { color: var(--text); letter-spacing: 0; font-size: 15px; margin-left: 6px; font-weight: 700; }
.drone .seg button { height: 46px; white-space: nowrap; } .drone .seg button.on { --c: var(--drone); }
.keygrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.keygrid button { height: 48px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 17px; }
.keygrid button.on { background: var(--drone); color: #1c1606; border-color: var(--drone); }
.drone .lv { display: flex; align-items: center; gap: 10px; }
.drone .lv .hfader { flex: 1; } .drone .lv b { font-size: 14px; min-width: 58px; text-align: right; }
.drone .char { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.drone .char > div { display: grid; grid-template-columns: 1fr auto; align-items: center; }
.drone .char b { font-size: 13.5px; } .drone .char small { color: var(--muted); font-size: 12px; text-align: right; }
.drone .char .hfader { grid-column: 1 / 3; }
.drone .tg { display: flex; gap: 8px; flex-wrap: wrap; } .drone .tg .tog { --c: var(--drone); height: 36px; font-size: 13.5px; }
.drone .lockline { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.padsrow { margin-top: auto; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 9px; }
.padsrow b { color: var(--text); font-weight: 600; } .padsrow .btn { margin-left: auto; }
.drone.off .ontile { border-color: #4a5260; background: var(--panel-2); } .drone.off .ontile i { background: var(--led-off); box-shadow: none; }
.drone.off .ontile .st { background: var(--warn); color: #1d1400; }
.notes { grid-column: 7; padding: 14px 16px; overflow: hidden; }
.notes p { margin: 10px 0 0; font-size: 16px; line-height: 1.5; color: #dfe4ea; }
.bottom { grid-column: 1 / 8; display: grid; grid-template-columns: 1fr 120px 118px 150px 124px; gap: 12px; }
.kb-card { padding: 8px 10px 10px; }
.bigbtn { border-radius: var(--radius); border: 1px solid var(--line-2); background: var(--panel); font-weight: 700; font-size: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; flex-direction: column; }
.bigbtn .l { display: flex; align-items: center; gap: 7px; }
.bigbtn small { font-size: 11px; letter-spacing: .06em; opacity: .8; font-weight: 700; }
.bigbtn.fade { background: #182231; }
.bigbtn.panic { background: var(--panic); color: #fff; border: 0; font-size: 24px; letter-spacing: .06em; gap: 0; box-shadow: 0 0 22px #d9363a55; }
.bigbtn.revert { color: var(--muted); background: transparent; border-color: var(--line); }
.bigbtn.locked { border: 2px solid var(--warn); color: var(--warn); background: #231c0c; }
.bigbtn.locked small { color: #e8cf98; }

/* ---- "Sing it in…" popover (from the KEY button) */
.keypop { position: absolute; z-index: 25; left: 34px; top: 118px; width: 452px; padding: 14px 16px 14px; border-radius: 12px; background: #1f242c;
  border: 2px solid var(--accent); box-shadow: 0 20px 56px #000d; }
.keypop::before { content: ''; position: absolute; top: -9px; left: 34px; width: 14px; height: 14px; background: #1f242c;
  border-left: 2px solid var(--accent); border-top: 2px solid var(--accent); transform: rotate(45deg); }
.keypop h3 { margin: 0; font-size: 19px; } .keypop p { margin: 3px 0 12px; font-size: 13.5px; color: var(--muted); line-height: 1.4; }
.keypop p b { color: var(--text); }
.keypop .keygrid button { height: 48px; font-size: 18px; position: relative; }
.keypop .keygrid button.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.keypop .keygrid button.hands::after { content: 'you play'; position: absolute; left: 0; right: 0; bottom: 3px; font-size: 9.5px; font-weight: 700; color: var(--muted); }
.keypop .kf { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--line); font-size: 13.5px; }
.keypop .kf b { color: var(--accent); } .keypop .kf .btn { margin-left: auto; }
.keypop .kn { font-size: 12px; color: var(--faint); margin-top: 9px; line-height: 1.4; }

/* lock banner in the song block */
.lockbar { position: absolute; right: 12px; top: 10px; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--warn); }

/* 1024-wide: Notes collapse into a button (as today); shared-effect chips collapse to two pills */
@media (max-width: 1250px) {
  .perform { grid-template-columns: 76px 1fr 1fr 44px 1fr 330px; grid-template-rows: 94px 50px 1fr 74px; gap: 10px; padding: 10px 12px 12px; }
  .perform.full4 { grid-template-columns: 76px 1fr 1fr 1fr 1fr 330px; }
  .r1 { grid-template-columns: minmax(0, 1fr) 160px 250px 104px; gap: 10px; } .r2 { grid-template-columns: 90px 1fr 200px; gap: 10px; }
  .song { padding: 8px 14px; } .song h1 { font-size: 32px; } .keybtn { height: 34px; } .keybtn b { font-size: 24px; } .song .bpm { display: none; }
  .song .notesbtn { display: flex; position: absolute; right: 12px; bottom: 10px; }
  .transpose { padding: 8px 10px; } .transpose .row button { width: 40px; height: 42px; font-size: 22px; } .transpose .row b { font-size: 24px; }
  .fxcard { padding: 7px 8px; gap: 6px; } .fxrow { display: none; }
  .fxpill { display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: 8px; text-align: left;
    border: 1px solid var(--line-2); background: var(--panel-2); border-radius: 8px; padding: 0 9px; }
  .fxpill .ic { color: var(--fx); } .fxpill span { font-size: 10.5px; font-weight: 800; letter-spacing: .1em; color: var(--muted); }
  .fxpill b { font-size: 15px; white-space: nowrap; } .fxpill b small { font-size: 12px; color: var(--muted); font-weight: 600; }
  .fxpill > .ic:last-child { color: var(--faint); }
  .chord { padding: 8px 14px; } .chord b { font-size: 38px; }
  .chip { font-size: 15px; } .next b { font-size: 16px; }
  .notes { display: none; } .padsrow { display: none; }
  .drone { grid-column: 6; padding: 8px 10px 9px; gap: 7px; } .keygrid button { height: 34px; font-size: 15px; }
  .drone .ontile { height: 40px; } .drone .ontile .r small { font-size: 13px; margin-left: 4px; } .drone .seg button { height: 40px; padding: 0 9px; font-size: 13px; }
  .drone .tg .tog { height: 32px; font-size: 12.5px; padding: 0 9px; }
  .drone .char { gap: 10px; } .drone .char b { font-size: 12.5px; } .drone .char .hfader { height: 20px; } .drone .char .hf-thumb { width: 18px; height: 18px; } .drone .char .hf-track { top: 7px; }
  .strip { padding: 7px 6px 7px; gap: 5px; } .strip .who .ic { display: none; }
  .ontile { height: 40px; padding: 0 5px 0 8px; gap: 6px; } .ontile .r { font-size: 12.5px; letter-spacing: .07em; } .ontile .st { font-size: 11.5px; padding: 2px 5px; }
  .strip .name { font-size: 14.5px; } .strip .db { font-size: 15px; } .strip .fz { min-height: 60px; }
  .strip .tagline { height: 17px; } .strip .tagline .tg, .strip .tagline .bd { font-size: 10.5px; }
  .mods { gap: 4px; } .mod { height: 42px; } .mod span, .mod b { font-size: 12.5px; }
  .wheel { padding: 8px 6px; gap: 5px; } .wheel .val { font-size: 18px; } .wheel .swell { height: 36px; }
  .bottom { grid-column: 1 / 7; grid-template-columns: 1fr 92px 96px 118px 100px; gap: 10px; }
  .bigbtn { font-size: 14px; } .bigbtn.panic { font-size: 20px; }
  .kb-card { padding: 5px 8px 7px; }
  .amt { bottom: 140px; padding: 7px 6px 6px; } .amt .af { display: none; } .amt .to { margin-bottom: 5px; } .steps { gap: 4px; } .steps button { font-size: 13.5px; min-height: 24px; } .amt .ah .x { width: 26px; height: 26px; }
}
`;

export const SLOTS = [
  { i: 0, role: 'KEYS', icon: 'piano', name: 'Grand Piano', pos: 0.72, db: '−1.9 dB', room: 25, echo: 10, chorus: 0, oct: 0, sus: true },
  { i: 1, role: 'PAD', icon: 'pad', name: 'Warm Pad', tag: '↻ wheel 100%', pos: 0.6, db: '−5.2 dB', room: 50, echo: 10, chorus: 35, oct: 0, sus: true },
  { i: 2, role: 'EXTRA', empty: true },
  { i: 3, role: 'BASS', icon: 'bass', name: 'Sub Bass', pos: 0.66, db: '−3.1 dB', room: 0, echo: 0, chorus: 0, oct: -1, sus: false },
];

const sgn = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

function stepPanel(s, which) {
  if (which === 'oct') {
    const steps = [2, 1, 0, -1, -2];
    return `<div class="amt low" role="group" aria-label="${s.role} octave" style="--ax:72%">
      <div class="ah"><b><span>${s.role}</span>Octave</b><button class="x" title="Close">${icon('close', 15)}</button></div>
      <div class="to">shifts only the ${s.role.toLowerCase()}</div>
      <div class="ab nofine"><div class="steps">${steps.map((p) => `<button class="${p === s.oct ? 'on' : ''}">${p === 0 ? 'Normal' : `${sgn(p)} oct`}</button>`).join('')}</div></div>
      <div class="af">Tap one: done.</div>
    </div>`;
  }
  const v = which === 'room' ? s.room : s.echo;
  const label = which === 'room' ? 'Space' : 'Echo';
  const dest = which === 'room' ? 'Hall' : 'the Echo';
  const step = [100, 75, 50, 25, 0];
  return `<div class="amt" role="group" aria-label="${s.role} ${label} amount" style="--ax:${which === 'room' ? 22 : 72}%">
    <div class="ah"><b><span>${s.role}</span>${label}</b><button class="x" title="Close">${icon('close', 15)}</button></div>
    <div class="to">how much goes into <em>${dest}</em></div>
    <div class="ab">
      <div class="steps">${step.map((p) => `<button class="${p === v ? 'on' : ''}">${p ? `${p}%` : 'Off'}</button>`).join('')}</div>
      <div class="fine" title="Drag for in-between values"><div class="t"><em style="height:${v}%"></em></div><div class="th" style="bottom:calc(${v}% - 8px)"></div></div>
    </div>
    <div class="af">Tap a step: done.<br>Slide for in-between.</div>
  </div>`;
}

function strip(s, { step, off } = {}) {
  if (s.empty) {
    return `<div class="card strip s${s.i} empty" title="Empty slot: add a sound in Edit">
      <button class="plus">${icon('plus', 18)}</button><div class="vt">${s.role} <span>· empty</span></div></div>`;
  }
  const isOff = off === s.i;
  const amt = (label, pct, key) => `<button class="mod${pct > 0 ? ' on' : ''}${step === `${s.i}-${key}` ? ' open' : ''}"><span>${label}</span><b>${pct ? `${pct}%` : 'off'}</b>${pct ? `<i style="width:${pct}%"></i>` : ''}</button>`;
  const oct = `<button class="mod${s.oct ? ' on' : ''}${step === `${s.i}-oct` ? ' open' : ''}"><span>Octave</span><b>${s.oct ? sgn(s.oct) : 'normal'}</b></button>`;
  const sus = `<button class="mod sus${s.sus ? ' lit' : ' offwarn'}"><em></em><span>${s.sus ? 'Sustain' : 'Sus. off'}</span></button>`;
  const tagline = [s.tag ? `<span class="tg">${s.tag}</span>` : '', s.chorus ? `<span class="bd">Chorus ${s.chorus}%</span>` : ''].join('');
  const panel = step && step.startsWith(`${s.i}-`) ? stepPanel(s, step.split('-')[1]) : '';
  return `<div class="card strip s${s.i}${isOff ? ' off' : ''}">
    <button class="ontile" title="Tap to turn ${s.role} ${isOff ? 'on' : 'off'}"><i></i><span class="r">${s.role}</span><span class="st">${isOff ? 'OFF' : 'ON'}</span></button>
    <div class="who">${icon(s.icon, 20)}<span class="name">${s.name}</span></div>
    <div class="tagline">${tagline}</div>
    <div class="fz">${vfader(s.pos, 'var(--c)')}</div>
    <div class="db">${s.db}</div>
    <div class="mods">${amt('Space', s.room, 'room')}${amt('Echo', s.echo, 'echo')}${oct}${sus}</div>
    ${panel}
  </div>`;
}

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function keyPopover() {
  return `<div class="keypop" role="group" aria-label="Sing it in">
    <h3>Sing it in…</h3>
    <p>Tap the key the band will sing in. <b>Your hands stay in D</b>; the app shifts every sound (Easy Transpose).</p>
    <div class="keygrid">${KEYS.map((k) => `<button class="${k === 'G' ? 'on' : ''}${k === 'D' ? ' hands' : ''}">${k}</button>`).join('')}</div>
    <div class="kf">Band hears <b>G</b> · you play D · <b>+5</b><button class="btn sm">Back to D</button></div>
    <div class="kn">Want to play in G yourself too? Use the key grid in <b style="color:var(--drone)">Key &amp; drone</b>.</div>
  </div>`;
}

function fxPills() {
  return `<button class="fxpill">${icon('room', 18)}<b><span>SPACE&nbsp;</span> Hall</b>${icon('down', 15)}</button>
    <button class="fxpill">${icon('echo', 18)}<b><span>ECHO&nbsp;</span> Song’s own <small>420 ms</small></b>${icon('down', 15)}</button>`;
}

/**
 * opts.quick: sheet HTML; opts.step: '1-room' | '3-oct' opens a strip step panel; opts.off: slot index shown OFF;
 * opts.keyPop: show "Sing it in…" (and the transposed state it produces); opts.locked: Perform-lock on.
 */
export function performBody({ quick = '', step = '', off = -1, keyPop = false, locked = false } = {}) {
  const held = [38, 62, 66, 69]; // D2 + D4 F#4 A4
  const shifted = keyPop;
  const holdTag = locked ? '<span class="hold">HOLD</span>' : '';
  const fr = locked ? ' frozen' : '';
  return `${topbar('perform', { quickOn: !!quick, locked })}
  <main class="perform">
    <div class="r1"><section class="card song"><h1>Sunday Pad + Piano</h1>
      <div class="key"><span class="cap">Key</span><button class="keybtn${keyPop ? ' open' : ''}" title="Sing it in a different key"><b>${shifted ? 'G' : 'D'}</b>${icon('down', 18)}</button>
        ${shifted ? '<span class="playin"><span>you play</span> D</span>' : '<span class="bpm">you play D · 72 BPM</span>'}${holdTag}</div>
      <button class="btn sm notesbtn">${icon('note', 16)}Notes</button></section>
    <section class="card transpose"><div class="th"><span class="cap">Transpose</span>${holdTag}</div><div class="row"><button>−</button><b class="${shifted ? 'shift' : ''}">${shifted ? '+5' : '0'}</b><button>+</button></div></section>
    <section class="card fxcard" aria-label="Shared effects (this song)">
      <div class="fxrow"><div class="lab">${icon('room', 20)}<span>SPACE</span></div>
        <button class="fxc">Dry</button><button class="fxc">Room</button><button class="fxc">Stage</button><button class="fxc on">Hall</button><button class="fxc">Cathedral</button><button class="fxc more" title="Ambient Wash · Vibe">${icon('more', 18)}</button></div>
      <div class="fxrow"><div class="lab">${icon('echo', 20)}<span>ECHO</span></div>
        <button class="fxc">Off</button><button class="fxc">Slap</button><button class="fxc near" title="closest preset">¼</button><button class="fxc">Dotted ⅛</button><button class="fxc">Trails</button><button class="fxc own on">Song’s own<small>420 ms</small></button></div>
      ${fxPills()}
    </section>
    <section class="card chord"><span class="cap">Chord</span><b>${shifted ? 'G' : 'D'}</b></section></div>

    <div class="r2"><div class="prev">◀ Prev</div>
    <div class="card setlist">
      <div class="chip on"><small>1</small>Sunday Pad + Piano<em>${shifted ? 'G' : 'D'}</em></div>
      <div class="chip"><small>2</small>Building Swell<em>G</em></div>
      <div class="chip"><small>3</small>Prayer Wash<em>E</em></div>
      <div class="chip"><small>4</small>Organ Swell<em>A</em></div>
      <div class="chip"><small>5</small>Grand Piano<em>C</em></div>
    </div>
    <button class="card next"><span><span class="cap">Next</span><b>Building Swell · <em>G</em></b></span>${icon('chevron', 22)}</button></div>

    <section class="card wheel"><span class="cap">Wheel</span><div class="bar"><div></div></div><div class="val">100%</div>
      <div class="to">→ Pad level</div><button class="swell">◢ Swell</button>
      <div class="ind on"><i class="led"></i>PEDAL</div><div class="ind"><i class="led"></i>BEND</div></section>
    ${SLOTS.map((s) => strip(s, { step, off })).join('')}
    <section class="card drone">
      <div class="hd"><button class="ontile" title="Tap to turn the drone off"><i></i><span class="r">DRONE<small>${shifted ? 'G' : 'D'} major</small></span><span class="st">ON</span></button>
        <div class="seg${fr}"><button class="on">Synth</button><button>My Pads</button></div></div>
      <div class="keygrid">${KEYS.map((k) => `<button class="${k === (shifted ? 'G' : 'D') ? 'on' : ''}">${k}</button>`).join('')}</div>
      <div class="lv"><div class="seg" style="--c:var(--drone)"><button class="on">Major</button><button>Minor</button></div>
        ${hfader(0.68, 'var(--drone)')}<b>+1.6 dB</b></div>
      ${locked ? `<div class="lockline"><span class="hold">HOLD</span>a key or Major/Minor to change it while locked</div>` : ''}
      <div class="char${fr}">
        <div><b>Brightness</b><small>Soft · 40%</small>${hfader(0.4, 'var(--drone)')}</div>
        <div><b>Movement</b><small>Gentle · 30%</small>${hfader(0.3, 'var(--drone)')}</div>
      </div>
      <div class="tg${fr}"><span class="tog"><i></i>Follow chords</span><span class="tog on"><i></i>Continue across songs</span></div>
      <div class="padsrow${fr}">My Pads folder: <b>Worship Pads</b> · 12 keys found<button class="btn sm ghost">Change…</button></div>
    </section>
    <section class="card notes"><span class="cap">Notes</span>
      <p>The everyday worship sound: grand piano on top of a warm pad, with a soft key drone underneath. Mod wheel (and an expression pedal) brings the pad in and out, so you can start with piano alone and swell the pad for the chorus. Push the pitch-bend wheel up to lift the drone; pull it down to tuck it away.</p></section>

    <div class="bottom">
      <div class="card kb-card">${keyboard(36, 96, {
        held,
        ranges: [
          { low: 0, high: 127, color: off === 0 ? '#4d5562' : 'var(--slot-0)' },
          { low: 0, high: 127, color: off === 1 ? '#4d5562' : 'var(--slot-1)' },
          { low: 0, high: 59, color: off === 3 ? '#4d5562' : 'var(--slot-3)' },
        ],
      })}</div>
      <button class="bigbtn revert"><span class="l">↺ Revert</span>${locked ? '<span class="hold">HOLD</span>' : ''}</button>
      <button class="bigbtn fade">Fade out</button>
      <button class="bigbtn panic">PANIC<small>Esc</small></button>
      ${locked ? `<button class="bigbtn locked"><span class="l">${icon('lock', 18)}Locked</span><small>hold to unlock</small></button>` : `<button class="bigbtn"><span class="l">${icon('lock', 18)}Lock</span></button>`}
    </div>
    ${keyPop ? keyPopover() : ''}
    ${quick}
  </main>`;
}
