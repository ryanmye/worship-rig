import { icon, vfader, hfader, keyboard } from './helpers.mjs';
import { topbar } from './perform.mjs';

// H-v2 Edit: H's "one part at a time" panel with the sentence title, but the rig map is tamed into ONE calm row of
// tabs (Keys · Pad · Extra · Bass · Drone · Effects · Master) in Perform's colours. The send lanes live behind
// "Show wiring" and use numbers instead of dot sizes. The selected tab opens straight into its panel (folder tab),
// which replaces H's coloured tie-line.

const SOUNDS = [
  { id: 'keys', role: 'KEYS', c: 'var(--slot-0)', ic: 'piano', name: 'Grand Piano', lvl: 0.72, db: '−1.9 dB', sends: [25, 10, 0], oct: 1, chg: true, playing: true },
  { id: 'pad', role: 'PAD', c: 'var(--slot-1)', ic: 'pad', name: 'Warm Pad', lvl: 0.6, db: '−5.2 dB', sends: [75, 10, 35], chg: true, playing: true },
  { id: 'extra', role: 'EXTRA', c: 'var(--slot-2)', empty: true },
  { id: 'bass', role: 'BASS', c: 'var(--slot-3)', ic: 'bass', name: 'Sub Bass', lvl: 0.66, db: '−3.1 dB', sends: [0, 0, 0], oct: -1, playing: true },
  { id: 'drone', role: 'DRONE', c: 'var(--drone)', ic: 'drone', name: 'D major', sub: 'Synth', lvl: 0.68, drone: true, playing: true },
];

export const EDIT_CSS = `
.edit { flex: 1; min-height: 0; display: grid; gap: 12px; padding: 12px 14px 14px; position: relative;
  grid-template-columns: 252px minmax(0, 1fr); grid-template-rows: 58px 1fr 108px; }
/* library */
.lib { grid-row: 1 / 3; display: flex; flex-direction: column; padding: 12px; gap: 10px; min-height: 0; }
.lib .sel { height: 38px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); display: flex; align-items: center; justify-content: space-between; padding: 0 12px; font-weight: 600; }
.songs { flex: 1; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
.song-row { display: flex; align-items: center; gap: 9px; height: 38px; padding: 0 10px; border-radius: var(--radius-sm); font-weight: 600; font-size: 14.5px; color: #d9dee5; }
.song-row small { color: var(--faint); width: 16px; text-align: right; font-size: 12px; }
.song-row em { margin-left: auto; font-style: normal; color: var(--faint); font-size: 12.5px; font-weight: 700; }
.song-row.on { background: var(--panel-3); color: var(--text); box-shadow: inset 3px 0 0 var(--accent); }
.song-row.on em { color: var(--accent); }
.lib .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; } .lib .actions .btn { justify-content: center; padding: 0 6px; font-size: 13px; }
.lib .file { font-size: 13px; color: var(--muted); display: flex; justify-content: space-between; border-top: 1px solid var(--line); padding-top: 10px; }

/* song header */
.shead { display: flex; align-items: center; gap: 10px; padding: 0 12px 0 16px; }
.shead h1 { margin: 0 8px 0 0; font-size: 25px; white-space: nowrap; }
.hchip { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 19px; border: 1px solid var(--line-2); background: var(--panel-2); font-size: 14px; font-weight: 600; white-space: nowrap; }
.hchip .cap { font-size: 10.5px; } .hchip b { font-size: 15px; } .hchip .ic { color: var(--muted); }
.hchip .tapb { margin-left: 2px; padding: 3px 8px; border-radius: 10px; background: var(--panel-3); font-size: 12px; font-weight: 700; }
.shead .sp { flex: 1; }
.live { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 12px; background: #16301f; color: #8fe0b1; font-size: 12px; font-weight: 800; letter-spacing: .06em; }
.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 7px var(--ok); }
.shead .livehint { font-size: 12.5px; color: var(--faint); line-height: 1.3; max-width: 250px; text-align: right; }

/* ---------------- the rig: one row of tabs; the selected tab opens into its panel */
.rp { --c: var(--slot-0); display: flex; flex-direction: column; min-height: 0; background: #101318; overflow: hidden; }
.rp-top { display: flex; align-items: center; gap: 12px; height: 34px; padding: 0 14px; flex: none; }
.rp-top .hint { font-size: 12.5px; color: var(--faint); }
.rp-top .sp { flex: 1; }
.linkbtn { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--line-2); background: transparent; font-size: 12.5px; font-weight: 650; color: var(--muted); }
.linkbtn .ic { color: var(--muted); }
.wiretog { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 650; color: var(--muted); }
.wiretog .switch { width: 34px; height: 20px; border-radius: 10px; --c: var(--fx); }
.wiretog .switch::after { width: 14px; height: 14px; top: 3px; left: 3px; }
.wiretog .switch.on::after { left: 17px; }
.wiretog.on { color: var(--text); }
.tabs7 { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)) 18px repeat(2, minmax(0, .9fr)); padding: 0 10px; flex: none; position: relative; }
.tabs7::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1px; background: var(--line-2); z-index: 0; }
.tab { position: relative; z-index: 1; height: 60px; margin: 0 2px; border: 1px solid transparent; border-bottom: 0; border-radius: 10px 10px 0 0; background: transparent;
  text-align: left; padding: 7px 11px 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; color: var(--text); }
.tab::before { content: ''; position: absolute; left: 10px; right: 10px; top: 0; height: 3px; border-radius: 0 0 3px 3px; background: var(--tc); opacity: .9; }
.tab .t1 { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800; letter-spacing: .1em; color: var(--tc); }
.tab .t1 i { width: 8px; height: 8px; border-radius: 50%; background: var(--tc); box-shadow: 0 0 7px var(--tc); flex: none; }
.tab b { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab b small { color: var(--muted); font-weight: 600; font-size: 12.5px; }
.tab:hover { background: #171b21; }
.tab.sel { background: var(--panel); border-color: var(--line-2); }
.tab.sel::before { opacity: 1; left: -1px; right: -1px; height: 4px; border-radius: 10px 10px 0 0; }
.tab.sel::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--panel); }
.tab.empty { color: var(--faint); } .tab.empty::before { background: repeating-linear-gradient(90deg, #4a515d 0 6px, transparent 6px 10px); }
.tab.empty .t1 { color: var(--faint); } .tab.empty .t1 i { display: none; } .tab.empty b { font-weight: 600; color: var(--faint); }
.tab.fxt { --tc: var(--fx); } .tab.fxt .t1 i { display: none; }
.tab.off b { text-decoration: line-through; color: var(--faint); } .tab.off .t1 { color: var(--faint); } .tab.off .t1 i { background: transparent; box-shadow: inset 0 0 0 1.5px #6b7380; }
.tab .cd { position: absolute; top: 9px; right: 9px; width: 8px; height: 8px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px #101318, 0 0 6px #fffa; }
.tab.sel .cd { box-shadow: 0 0 0 2px var(--panel), 0 0 6px #fffa; }

/* "Show wiring": lanes under the tabs, aligned to the same columns; numbers, not dot sizes */
.wire { flex: none; background: var(--panel); border-bottom: 1px solid var(--line); padding: 6px 10px 8px; }
.rp.wired .wsl { gap: 8px; } .rp.wired .ws .wse { display: none; } .rp.wired .fb { padding: 10px 0 8px; } .rp.wired .onstage .same { display: none; } .rp.wired .fh { height: 62px; }
.rp.wired .play { gap: 10px; } .rp.wired .rhint { display: none; }
.wire .wcap { font-size: 12px; color: var(--faint); padding: 0 12px 6px; }
.wire .wcap b { color: var(--muted); font-weight: 650; }
.wg { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)) 18px repeat(2, minmax(0, .9fr)); grid-template-rows: repeat(3, 26px); position: relative; }
.wlane { grid-column: 1 / 7; position: relative; }
.wlane::before { content: ''; position: absolute; left: 10%; right: 0; top: 50%; height: 2px; background: #3a414d; }
.wlane.hot::before { background: var(--fx); }
.wlane .ln { position: absolute; left: 2px; top: 50%; transform: translateY(-50%); font-size: 11.5px; font-weight: 700; color: var(--faint); background: var(--panel); padding-right: 6px; }
.wdrop { position: relative; z-index: 1; display: grid; place-items: center; }
.wdrop::before { content: ''; position: absolute; left: 50%; top: -6px; bottom: -6px; width: 2px; margin-left: -1px; background: var(--c); opacity: .35; }
.wdrop.first::before { top: -2px; } .wdrop.hot::before { opacity: 1; width: 3px; }
.wv { position: relative; min-width: 44px; height: 22px; padding: 0 8px; border-radius: 11px; font-size: 12.5px; font-weight: 800; display: grid; place-items: center;
  background: color-mix(in srgb, var(--c) 22%, var(--panel)); border: 1.5px solid var(--c); color: #fff; }
.wv.zero { background: var(--panel); border: 1.5px dashed #4a515d; color: var(--faint); font-weight: 600; }
.wdrop.dim .wv { opacity: .55; }
.wend { grid-column: 7; position: relative; z-index: 1; display: flex; align-items: center; gap: 6px; padding-left: 6px; }
.wend .wn { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px 0 8px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--fx) 55%, var(--line-2)); background: #1b2029; font-size: 12.5px; font-weight: 700; white-space: nowrap; }
.wend .wn .ic { color: var(--fx); } .wend .wn span { color: var(--muted); font-weight: 600; }
.wout { grid-column: 8; grid-row: 1 / 4; display: flex; align-items: center; gap: 8px; padding-left: 4px; font-size: 12.5px; font-weight: 700; color: var(--muted); }
.wout .br { width: 12px; align-self: stretch; margin: 8px 0; border: 2px solid #4a5260; border-left: 0; border-radius: 0 8px 8px 0; }

/* focus panel (inside .rp, under the tabs) */
.focus { position: relative; flex: 1; padding: 0 18px; background: var(--panel); display: flex; flex-direction: column; min-height: 0; }
.fh { display: flex; align-items: center; gap: 12px; height: 70px; flex: none; border-bottom: 1px solid var(--line); }
.fh .tile { width: 46px; height: 46px; border-radius: 12px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); flex: none; }
.fh .sp { flex: 1; }
.fh .whobox { min-width: 0; flex: 0 1 auto; }
.fh .src2 { display: block; font-size: 12.5px; color: var(--faint); margin-top: 3px; }
.sent { font-size: 21px; font-weight: 500; color: #c9d0d9; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sent .role { color: var(--c); font-weight: 800; letter-spacing: .04em; }
.sent .tok { position: relative; color: var(--text); font-weight: 700; border-bottom: 2px dotted color-mix(in srgb, var(--c) 80%, transparent); padding-bottom: 1px; }
.fb { flex: 1; display: grid; min-height: 0; padding: 16px 0 14px; }
.col { padding: 0 22px; border-left: 1px solid var(--line); display: flex; flex-direction: column; min-width: 0; }
.col:first-child { padding-left: 0; border-left: 0; }
.col > .cap { margin-bottom: 2px; } .col > .sub { font-size: 12px; color: var(--faint); margin-bottom: 12px; }
.ff { flex: none; height: 46px; display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.ff .adv { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text); font-size: 14px; }
.ff .sum { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ff .sum b { color: #cfd5dd; font-weight: 600; }
.ff .chgl { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; color: #dfe4ea; white-space: nowrap; }
.ff .chgl i { width: 8px; height: 8px; border-radius: 50%; background: #fff; box-shadow: 0 0 6px #fffa; }
.ff .chgl.none { color: var(--faint); } .ff .chgl.none i { display: none; }

/* On stage = the exact Perform strip widgets (same ON tile, fader, chips, colours) */
.onstage { align-items: stretch; }
.onstage .ontile { height: 44px; flex: none; border-radius: 9px; display: flex; align-items: center; gap: 9px; padding: 0 6px 0 11px; border: 0;
  background: var(--c); color: #0d0f12; box-shadow: 0 0 16px color-mix(in srgb, var(--c) 25%, transparent); text-align: left; }
.onstage .ontile i { width: 11px; height: 11px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px #0d0f1233, 0 0 8px #fff; }
.onstage .ontile .r { font-weight: 800; font-size: 14px; letter-spacing: .1em; }
.onstage .ontile .st { margin-left: auto; font-size: 12px; font-weight: 800; padding: 3px 8px; border-radius: 5px; background: #0d0f122e; }
.onstage .osb { flex: 1; min-height: 0; display: grid; grid-template-columns: 64px 1fr; gap: 12px; margin-top: 12px; }
.onstage .osf { display: flex; flex-direction: column; min-height: 0; }
.onstage .mods { align-content: start; }
.onstage .fzrow { flex: 1; display: flex; gap: 6px; justify-content: center; min-height: 0; margin: 0 0 4px; }
.onstage .fzrow .vfader { margin: 0; }
.onstage .act { width: 6px; border-radius: 3px; background: var(--track); position: relative; overflow: hidden; margin: 4px 0; }
.onstage .act em { position: absolute; left: 0; right: 0; bottom: 0; background: linear-gradient(0deg, var(--ok) 0 70%, #e2c23c 70%); }
.onstage .db { text-align: center; font-weight: 700; font-size: 14px; white-space: nowrap; }
.onstage .same { font-size: 11.5px; color: var(--faint); text-align: center; margin-top: 8px; }
.mods { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mod { position: relative; overflow: hidden; height: 46px; border-radius: 8px; border: 1.5px solid var(--line-2); background: transparent;
  display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.12; padding: 0 2px 3px; color: #8f98a5; }
.mod span { font-size: 12.5px; font-weight: 800; } .mod b { font-size: 12.5px; font-weight: 600; }
.mod.on { background: color-mix(in srgb, var(--c) 20%, var(--panel)); border-color: color-mix(in srgb, var(--c) 70%, transparent); color: #fff; }
.mod.on span { color: color-mix(in srgb, var(--c) 55%, #fff); } .mod.on b { font-weight: 800; }
.mod > i { position: absolute; left: 0; bottom: 0; height: 4px; background: var(--c); }
.mod.sus { flex-direction: row; gap: 7px; } .mod.sus em { width: 10px; height: 10px; border-radius: 50%; box-shadow: inset 0 0 0 2px #6b7380; }
.mod.sus.on em { background: var(--c); box-shadow: 0 0 8px var(--c); }
.mod.wide { grid-column: 1 / 3; flex-direction: row; gap: 8px; height: 36px; }
.cdi { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #fff; box-shadow: 0 0 6px #fffc; margin-right: 5px; vertical-align: 1px; }
.sent .cdi { width: 9px; height: 9px; margin: 0 5px 0 1px; vertical-align: 3px; }

/* word sliders (no dials): name + word value, thick track, end words */
.wsl { display: flex; flex-direction: column; gap: 18px; }
.ws .wsh { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.ws .wsh b { font-size: 15px; } .ws .wsh .wv2 { font-size: 14px; font-weight: 700; } .ws .wsh .wv2 small { color: var(--muted); font-weight: 500; font-size: 12.5px; margin-left: 4px; }
.ws .wst { position: relative; height: 28px; }
.ws .wst .t { position: absolute; left: 0; right: 0; top: 10px; height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; }
.ws .wst .t em { position: absolute; top: 0; bottom: 0; background: var(--c); }
.ws .wst .mid { position: absolute; left: 50%; top: 5px; width: 2px; height: 18px; background: #5b6472; margin-left: -1px; }
.ws .wst .th { position: absolute; top: 2px; width: 24px; height: 24px; border-radius: 7px; margin-left: -12px; background: linear-gradient(#fbfcfd, #d5dae1); box-shadow: 0 1px 4px #0009; }
.ws .wse { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--faint); margin-top: 1px; }

/* where it plays */
.play { display: flex; flex-direction: column; gap: 16px; }
.play .row { display: flex; flex-direction: column; gap: 6px; } .play .row > span { font-size: 13.5px; font-weight: 700; }
.play .seg button { height: 34px; padding: 0 11px; font-size: 13.5px; }
.rpick { position: relative; height: 36px; margin-top: 2px; }
.rpick .mk { position: absolute; inset: 0; border-radius: 5px; overflow: hidden; opacity: .5; }
.rpick .mk .kbd, .rpick .mk .keys { height: 100%; }
.rpick .mk .wk span { display: none; }
.rpick > em { position: absolute; top: -3px; bottom: -3px; border-radius: 5px; border: 2.5px solid var(--c); background: color-mix(in srgb, var(--c) 22%, transparent); }
.rpick > i { position: absolute; top: -6px; bottom: -6px; width: 12px; margin-left: -6px; border-radius: 4px; background: #eef1f5; box-shadow: 0 1px 5px #000b; }
.rpick > i.r { margin-left: 0; margin-right: -6px; }
.rhint { font-size: 11.5px; color: var(--faint); }
.rbtns { display: flex; gap: 6px; margin-top: 4px; } .rbtns .btn { flex: 1; justify-content: center; font-size: 12.5px; padding: 0 6px; }

/* Effects tab: three plain-English lines (B-v2's calm "How it sounds"), each with its choices beside it */
.fxl { display: grid; grid-template-columns: 262px minmax(0, 1fr) 250px; column-gap: 24px; align-items: start; padding: 14px 0; border-top: 1px solid var(--line); }
.fxl:first-child { border-top: 0; padding-top: 4px; }
.fxl .ft { display: flex; gap: 10px; }
.fxl .ft .ic { color: var(--fx); margin-top: 2px; }
.fxl .ft b { display: block; font-size: 16px; font-weight: 600; color: #c9d0d9; } .fxl .ft b em { font-style: normal; color: var(--text); font-weight: 800; border-bottom: 2px dotted var(--fx); }
.fxl .ft small { display: block; font-size: 12.5px; color: var(--faint); line-height: 1.35; margin-top: 4px; }
.pchips { display: flex; flex-wrap: nowrap; gap: 6px; }
.whoin .mods { grid-template-columns: repeat(3, 1fr); } .whoin .mod { height: 44px; }
.pc { height: 44px; padding: 0 10px; flex: 1 1 auto; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 14px; display: inline-flex; flex-direction: column; justify-content: center; line-height: 1.1; text-align: left; }
.pc small { font-size: 11px; color: var(--faint); font-weight: 600; margin-top: 2px; }
.pc.on { background: var(--sel-fx, #3a4250); border: 2px solid #f1f4f8; } .pc.on small { color: #c9d1db; }
.fine2 { margin-top: 8px; font-size: 13px; font-weight: 700; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
.fine2 span { font-weight: 500; color: var(--faint); }
.whoin .cap { font-size: 10.5px; display: block; margin-bottom: 6px; }
.sr { display: grid; grid-template-columns: 50px 1fr; align-items: center; gap: 8px; margin-bottom: 5px; }
.sr > span { font-weight: 800; font-size: 13px; color: var(--c); }
.sr .seg { width: 100%; } .sr .seg button { flex: 1; height: 28px; padding: 0 4px; font-size: 12.5px; position: relative; }
.sr .seg button.on { background: color-mix(in srgb, var(--c) 30%, var(--panel)); color: #fff; box-shadow: inset 0 0 0 2px var(--c); }
.sr .seg button .cd { position: absolute; top: 2px; right: 2px; width: 7px; height: 7px; border-radius: 50%; background: #fff; }
.fxsl { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }

/* advanced + instrument menu (unchanged from H) */
.imenu { position: absolute; z-index: 30; width: 330px; background: #1f242c; border: 1px solid #555e6c; border-radius: 12px; box-shadow: 0 20px 56px #000d; padding: 8px; }
.btn.chg.open { border-color: var(--c); box-shadow: 0 0 0 2px var(--c); }

/* keyboard row */
.kbrow { grid-column: 1 / 3; display: grid; grid-template-columns: 150px 1fr 120px 104px 112px; gap: 12px; padding: 9px 12px 10px; }
.kleg { display: flex; flex-direction: column; justify-content: center; gap: 5px; font-size: 12px; font-weight: 700; }
.kleg div { display: flex; align-items: center; gap: 7px; } .kleg i { width: 18px; height: 5px; border-radius: 3px; background: var(--c); }
.kleg span { color: var(--faint); font-weight: 600; margin-left: auto; }
.kleg .dim { opacity: .45; }
.kbrow .rbars { margin-bottom: 9px; }
.kmeter { display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.kmeter .cap { font-size: 10.5px; }
.kmeter div.m { height: 7px; border-radius: 4px; background: linear-gradient(90deg, #2bbf6a 0 62%, #e2c23c 62% 80%, #e4573d 80%) left/var(--l) 100% no-repeat, #262b33; }
.bigbtn { border-radius: var(--radius); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 15px; display: flex; align-items: center; justify-content: center; gap: 8px; }
.bigbtn.fade { background: #182231; }
.bigbtn.panic { background: #d9363a; color: #fff; border: 0; font-size: 21px; letter-spacing: .06em; flex-direction: column; gap: 0; box-shadow: 0 0 20px #d9363a44; }
.bigbtn.panic small { font-size: 11px; letter-spacing: .04em; opacity: .75; font-weight: 700; }

@media (max-width: 1250px) {
  .edit { grid-template-columns: 1fr; grid-template-rows: 48px 1fr 66px; gap: 8px; padding: 8px 10px 10px; }
  .lib { display: none; }
  .shead { padding: 0 10px; gap: 8px; } .shead h1 { font-size: 19px; } .hchip { height: 32px; padding: 0 10px; font-size: 13px; } .shead .fac { display: none; }
  .shead .songsbtn { display: inline-flex !important; } .shead .livehint { display: none; }
  .rp-top { height: 28px; } .rp-top .hint { display: none; }
  .tab { height: 48px; padding: 6px 8px 0; } .tab b { font-size: 13px; } .tab b small { display: none; } .tab .t1 { font-size: 10px; }
  .fh { height: 54px; } .fh .tile { width: 36px; height: 36px; } .fh .tile .ic { width: 22px; height: 22px; }
  .sent { font-size: 16px; } .fh .src2 { display: none; }
  .fb { padding: 8px 0 6px; }
  .col { padding: 0 12px; } .col > .sub { display: none; } .col > .cap { margin-bottom: 6px; }
  .onstage .ontile { height: 36px; } .onstage .db { font-size: 13px; margin-bottom: 4px; } .onstage .same { display: none; } .onstage .osb { margin-top: 8px; }
  .mod { height: 36px; } .mod span, .mod b { font-size: 11px; } .mod.wide { height: 28px; } .mods { gap: 4px; }
  .wsl { gap: 6px; } .ws .wse { display: none; } .ws .wsh b { font-size: 13px; } .ws .wsh .wv2 { font-size: 12px; } .ws .wst { height: 22px; } .ws .wst .t { top: 8px; height: 6px; } .ws .wst .th { width: 20px; height: 20px; top: 1px; }
  .play { gap: 8px; } .rhint { display: none; } .rpick { height: 26px; } .play .seg button { height: 28px; padding: 0 7px; font-size: 12.5px; }
  .ff { height: 36px; font-size: 12px; } .ff .sum { font-size: 11.5px; }
  .kbrow { grid-column: 1; grid-template-columns: 1fr 70px 84px 92px; padding: 5px 10px 7px; gap: 8px; } .kleg { display: none; } .kmeter .cap { display: none; }
}
`;

// ---------------------------------------------------------------- tabs + optional wiring
function tabs(sel) {
  const t = SOUNDS.map((s) => {
    const cls = `tab${s.empty ? ' empty' : ''}${s.id === sel ? ' sel' : ''}`;
    if (s.empty) return `<button class="${cls}" style="--tc:${s.c}"><span class="t1">${s.role}</span><b>+ Add a sound</b></button>`;
    return `<button class="${cls}" style="--tc:${s.c}"><span class="t1"><i></i>${s.role}</span><b>${s.name}${s.sub ? ` <small>· ${s.sub}</small>` : ''}</b>${s.chg ? '<em class="cd" title="Changed since the song was loaded"></em>' : ''}</button>`;
  }).join('');
  return `<div class="tabs7" role="tablist">${t}<span></span>
    <button class="tab fxt${sel === 'effects' ? ' sel' : ''}"><span class="t1">EFFECTS</span><b>Hall <small>· echo: own</small></b></button>
    <button class="tab fxt${sel === 'master' ? ' sel' : ''}"><span class="t1">MASTER</span><b>−6.0 dB <small>· Tape off</small></b></button></div>`;
}

function wiring(sel) {
  const lanes = [['Space', 'room', 'Hall'], ['Echo', 'echo', 'song’s own'], ['Chorus', 'chorus', 'gentle']];
  const selFx = sel === 'effects';
  let cells = '';
  lanes.forEach(([name, ic, val], j) => {
    const row = j + 1;
    cells += `<div class="wlane${selFx ? ' hot' : ''}" style="grid-row:${row}"><span class="ln">${j === 0 ? '' : ''}</span></div>`;
    SOUNDS.forEach((s, i) => {
      if (s.empty) return;
      const col = i + 1;
      const hot = s.id === sel;
      const dim = !hot && sel !== 'effects';
      let v;
      if (s.drone) v = j === 0 ? '<span class="wv" style="--c:var(--drone)">fixed</span>' : '';
      else v = s.sends[j] ? `<span class="wv">${s.sends[j]}%</span>` : '<span class="wv zero">–</span>';
      cells += `<div class="wdrop${hot ? ' hot' : ''}${dim ? ' dim' : ''}${j === 0 ? ' first' : ''}" style="grid-row:${row};grid-column:${col};--c:${s.c}">${v}</div>`;
    });
    cells += `<div class="wend" style="grid-row:${row}"><span class="wn">${icon(ic, 14)}${name} <span>${val}</span></span></div>`;
  });
  cells += `<div class="wout"><span class="br"></span>${icon('speaker', 16)}to Master</div>`;
  return `<div class="wire">
    <div class="wcap"><b>Wiring.</b> Every sound goes straight to Master. The numbers are how much of each sound also goes into each shared effect: the same values as its Space / Echo / Chorus chips.</div>
    <div class="wg">${cells}</div></div>`;
}

function rigTop(wire) {
  return `<div class="rp-top"><span class="cap">Your rig</span><span class="hint">Pick a part to edit it. The dot on a tab means something changed since the song was loaded.</span>
    <span class="sp"></span>
    <button class="linkbtn">${icon('keyboard', 15)}Wheels &amp; pedal</button>
    <span class="wiretog${wire ? ' on' : ''}"><span class="switch${wire ? ' on' : ''}"></span>Show wiring</span></div>`;
}

// ---------------------------------------------------------------- frame
function library() {
  const songs = [['Sunday Pad + Piano', 'D'], ['Building Swell', 'G'], ['Prayer Wash', 'E'], ['Organ Swell', 'A'], ['Grand Piano', 'C'],
    ['Rhodes', 'F'], ['Felt Piano', 'Bb'], ['Lofi Rhodes', 'Eb'], ['Dusty Piano', 'C'], ['Glass Ocean', 'D']];
  return `<aside class="card lib">
    <span class="cap">Setlist</span>
    <div class="sel">Sunday 9am — Oct 5 ${icon('down', 16)}</div>
    <div class="songs">${songs.map(([n, k], i) => `<div class="song-row${i === 0 ? ' on' : ''}"><small>${i + 1}</small>${n}<em>${k}</em></div>`).join('')}</div>
    <div class="actions"><button class="btn sm">+ New</button><button class="btn sm">Factory…</button><button class="btn sm">Library…</button></div>
    <div class="file"><span>Library file</span><span>Export / import ▸</span></div>
  </aside>`;
}

function header() {
  return `<section class="card shead">
    <button class="btn sm songsbtn" style="display:none">☰ Songs</button>
    <span class="live"><i></i>LIVE</span>
    <h1>Sunday Pad + Piano</h1>
    <span class="hchip"><span class="cap">Key</span><b>D</b><span class="muted">· you play D</span>${icon('down', 14)}</span>
    <span class="hchip">${icon('tap', 16)}<b>72</b><span class="muted">BPM</span><span class="tapb">Tap</span></span>
    <span class="hchip">${icon('note', 16)}Notes</span>
    <span class="sp"></span>
    <span class="livehint">The song that’s playing. Changes are heard now and saved with it.</span>
    <button class="btn sm ghost fac" title="Song menu: Duplicate, Rename, Reset to factory… (asks first)">${icon('more', 18)}Song</button>
  </section>`;
}

function kbRow(sel) {
  const on = (id) => (sel === id || !['keys', 'pad', 'bass'].includes(sel) ? '' : ' dim');
  return `<section class="card kbrow">
    <div class="kleg">
      <div class="${on('keys').trim()}" style="--c:var(--slot-0)"><i></i>Keys<span>all</span></div>
      <div class="${on('pad').trim()}" style="--c:var(--slot-1)"><i></i>Pad<span>all</span></div>
      <div class="${on('bass').trim()}" style="--c:var(--slot-3)"><i></i>Bass<span>to B3</span></div>
    </div>
    ${keyboard(36, 96, {
      held: [38, 62, 66, 69],
      ranges: [
        { low: 0, high: 127, color: 'var(--slot-0)', dim: on('keys') !== '' },
        { low: 0, high: 127, color: 'var(--slot-1)', dim: on('pad') !== '' },
        { low: 0, high: 59, color: 'var(--slot-3)', dim: on('bass') !== '' },
      ],
    })}
    <div class="kmeter"><span class="cap">Output</span><div class="m" style="--l:60%"></div><div class="m" style="--l:56%"></div></div>
    <button class="bigbtn fade">Fade out</button>
    <button class="bigbtn panic">PANIC<small>⌘ .</small></button>
  </section>`;
}

function wordSlider(name, v, word, sub, ends, { bipolar = false } = {}) {
  const fill = bipolar
    ? (v >= 0.5 ? `left:50%;width:${(v - 0.5) * 100}%` : `left:${v * 100}%;width:${(0.5 - v) * 100}%`)
    : `left:0;width:${v * 100}%`;
  return `<div class="ws"><div class="wsh"><b>${name}</b><span class="wv2">${word}<small>${sub}</small></span></div>
    <div class="wst"><div class="t"><em style="${fill}"></em></div>${bipolar ? '<i class="mid"></i>' : ''}<div class="th" style="left:${v * 100}%"></div></div>
    <div class="wse"><span>${ends[0]}</span><span>${ends[1]}</span></div></div>`;
}

const sgn = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const cd = (on) => (on ? '<em class="cdi"></em>' : '');

function onStage(s) {
  const amt = (label, v, chg) => `<button class="mod${v > 0 ? ' on' : ''}"><span>${label}</span><b>${cd(chg)}${v ? `${v}%` : 'off'}</b>${v ? `<i style="width:${v}%"></i>` : ''}</button>`;
  const ch = s.sends[2];
  return `<div class="col onstage"><span class="cap" style="margin-bottom:8px">On stage</span>
    <button class="ontile"><i></i><span class="r">${s.role}</span><span class="st">ON</span></button>
    <div class="osb"><div class="osf"><div class="fzrow">${vfader(s.lvl, s.c)}<div class="act"><em style="height:${s.id === 'pad' ? 48 : 62}%"></em></div></div>
    <div class="db">${s.db}</div></div>
    <div class="mods">${amt('Space', s.sends[0], s.id === 'pad')}${amt('Echo', s.sends[1])}
      <button class="mod${s.oct ? ' on' : ''}"><span>Octave</span><b>${cd(s.id === 'keys')}${s.oct ? sgn(s.oct) : 'normal'}</b></button>
      <button class="mod sus on"><em></em><span>Sustain</span></button>
      <button class="mod wide${ch > 0 ? ' on' : ''}"><span>Chorus</span><b>${ch ? `${ch}%` : 'off'}</b></button></div></div>
    <div class="same">Same switches, same colours as your Perform strip</div>
  </div>`;
}

function miniKeys() {
  return keyboard(36, 96, { showRanges: false, labels: false });
}

function slotPanel(s) {
  const isPad = s.id === 'pad';
  const sliders = isPad
    ? wordSlider('Brightness', 0.42, 'Mellow', '1.8 kHz', ['darker', 'brighter']) +
      wordSlider('Warmth', 0.5, 'Neutral', '0 dB', ['thinner', 'fuller'], { bipolar: true }) +
      wordSlider('Fade-in', 0.36, 'Slow', '1.2 s', ['instant', 'slow swell'])
    : wordSlider('Brightness', 1, 'Bright', '100%', ['darker', 'brighter']) +
      wordSlider('Warmth', 0.5, 'Neutral', '0 dB', ['thinner', 'fuller'], { bipolar: true }) +
      wordSlider('Ring-out', 0.3, 'Natural', '0.35 s', ['short', 'long']);
  const src = isPad ? 'Synth Pads · built-in synth' : 'Piano · sampled (Salamander)';
  const sentence = isPad
    ? `<span class="role">PAD</span> plays <span class="tok">Warm Pad</span>, <span class="tok">swells with the wheel</span>, <em class="cdi"></em><span class="tok">well into</span> the <span class="tok">Hall</span>, with <span class="tok">chorus</span>`
    : `<span class="role">KEYS</span> plays <span class="tok">Grand Piano</span> on <span class="tok">every key</span>, <em class="cdi"></em><span class="tok">an octave up</span>, a little into the <span class="tok">Hall</span>, sustain <span class="tok">on</span>`;
  const summary = '<b>Pan</b> Center · <b>Width</b> 100% · <b>Highs</b> 0 dB · <b>Transpose</b> 0 · <b>Voices</b> All · <b>Pitch bend</b> Off';
  const range = s.id === 'bass' ? 'below middle C' : 'every key';
  return `<div class="focus">
    <div class="fh"><div class="tile">${icon(s.ic, 28)}</div>
      <div class="whobox"><div class="sent">${sentence}</div><span class="src2">${src} · click an underlined word to jump to its control</span></div>
      <span class="sp"></span><button class="btn sm chg">Change instrument ${icon('down', 14)}</button></div>
    <div class="fb" style="grid-template-columns: 262px minmax(0, 1fr) 300px">
      ${onStage(s)}
      <div class="col"><span class="cap">The sound itself</span><span class="sub">Shape the ${isPad ? 'pad' : 'piano'}. Words first, numbers beside them.</span><div class="wsl">${sliders}</div></div>
      <div class="col play"><span class="cap">Where it plays</span><span class="sub">Only for this sound.</span>
        <div class="row"><span>Keyboard range <em class="faint" style="font-style:normal;font-weight:600">· ${range}</em></span>
          <div class="rpick"><div class="mk">${miniKeys()}</div><em style="left:0;right:0"></em><i style="left:0"></i><i class="r" style="right:0"></i></div>
          <div class="rbtns"><button class="btn sm">Set lowest…</button><button class="btn sm">Set highest…</button></div>
          <small class="rhint">Tap Set, then play the key on your keyboard.</small></div>
        <div class="row"><span>Response <em class="faint" style="font-style:normal;font-weight:600">· how it answers your touch</em></span><div class="seg" style="--c:${s.c}"><button>Soft</button><button class="on">Normal</button><button>Hard</button><button>Fixed</button></div></div>
      </div>
    </div>
    <div class="ff"><span class="adv">${icon('chevron', 16)}Advanced</span><span class="sum">${summary}</span>
      <span class="chgl"><i></i>1 change since the song was loaded</span></div>
  </div>`;
}

function effectsPanel() {
  const pc = (n, sub, on) => `<button class="pc${on ? ' on' : ''}">${n}${sub ? `<small>${sub}</small>` : ''}</button>`;
  // "who goes in" = the SAME chips as each Perform strip (tap → the same 100/75/50/25/Off steps)
  const m = (role, c, v, chg) => `<button class="mod${v ? ' on' : ''}" style="--c:${c}"><span>${role}</span><b>${cd(chg)}${v ? `${v}%` : 'off'}</b>${v ? `<i style="width:${v}%"></i>` : ''}</button>`;
  const who = (vals) => `<div class="whoin"><span class="cap">How much of each sound goes in</span>
    <div class="mods">${m('Keys', 'var(--slot-0)', vals[0])}${m('Pad', 'var(--slot-1)', vals[1], vals[3])}${m('Bass', 'var(--slot-3)', vals[2])}</div></div>`;
  return `<div class="focus" style="--c:var(--fx)">
    <div class="fh"><div class="tile">${icon('room', 28)}</div>
      <div class="whobox"><div class="sent">The room is a <span class="tok">Hall</span>, the echo is <span class="tok">the song’s own</span>, and the <span class="tok">Pad</span> has a gentle <span class="tok">chorus</span></div>
      <span class="src2">Three effects every sound shares. Each sound’s Space / Echo / Chorus chip decides how much of it goes in.</span></div>
      <span class="sp"></span><button class="btn sm">${icon('more', 16)}Vibe: Custom</button></div>
    <div class="fb" style="display:block;padding-top:12px">
      <div class="fxl"><div class="ft">${icon('room', 22)}<div><b>The room is a <em>Hall</em></b><small>Big concert hall. Pads bloom, piano gets lush; back the level off if it muddies.</small></div></div>
        <div><div class="pchips">${pc('Dry', 'none')}${pc('Room', 'small')}${pc('Stage', 'medium')}${pc('Hall', 'big', true)}${pc('Cathedral', 'huge')}${pc('Ambient Wash', 'pad-only')}</div>
          <span class="fine2">${icon('chevron', 14)}Fine-tune <span>size Large · darkness Medium · pre-delay Short · level +1.2 dB</span></span></div>
        ${who([25, 75, 0, true])}</div>
      <div class="fxl"><div class="ft">${icon('echo', 22)}<div><b>The echo is <em>the song’s own</em></b><small>A fixed 420 ms echo saved with this song, so it doesn’t follow the tempo.</small></div></div>
        <div><div class="pchips">${pc('Off', 'no echo')}${pc('Slapback', '1 repeat')}${pc('Quarter', 'on the beat')}${pc('Dotted 8th', 'worship echo')}${pc('Trails', 'long, dark')}${pc('Song’s own', '420 ms', true)}</div>
          <span class="fine2">${icon('chevron', 14)}Fine-tune <span>time 420 ms · repeats Few · tone Medium · level 0 dB</span></span></div>
        ${who([10, 10, 0])}</div>
      <div class="fxl"><div class="ft">${icon('chorus', 22)}<div><b>The chorus is <em>gentle</em></b><small>A slow shimmer. Mostly for pads and electric piano.</small></div></div>
        <div class="fxsl" style="--c:var(--fx)">${wordSlider('Depth', 0.5, 'Gentle', '50%', ['subtle', 'deep'])}${wordSlider('Speed', 0.25, 'Slow', '0.4 Hz', ['slow', 'fast'])}</div>
        ${who([0, 35, 0])}</div>
    </div>
    <div class="ff"><span class="adv">${icon('chevron', 16)}Tape &amp; finish</span><span class="sum"><b>Tape</b> off · <b>Tone</b> flat · <b>Glue</b> off · these live on the Master tab</span>
      <span class="chgl"><i></i>1 change since the song was loaded</span></div>
  </div>`;
}

/** sel: 'keys' | 'pad' | 'effects'; wire: show the wiring lanes. */
export function editBody(sel, { wire = false } = {}) {
  const s = SOUNDS.find((x) => x.id === sel);
  const c = s ? s.c : 'var(--fx)';
  const panel = s ? slotPanel(s) : effectsPanel();
  return `${topbar('edit')}
  <main class="edit">
    ${library()}
    ${header()}
    <section class="card rp${wire ? ' wired' : ''}" style="--c:${c}">
      ${rigTop(wire)}
      ${tabs(sel)}
      ${wire ? wiring(sel) : ''}
      ${panel}
    </section>
    ${kbRow(sel)}
  </main>`;
}
