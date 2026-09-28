import { icon, vfader, hfader, keyboard } from './helpers.mjs';
import { topbar } from './perform.mjs';

// Rig-map geometry (map content box is W px wide at 1440; x positions are emitted as % so it scales).
const W = 1114, H = 158;
const px = (x) => `${((x / W) * 100).toFixed(3)}%`;
const py = (y) => `${((y / H) * 100).toFixed(3)}%`;
const SND_X = [110, 244, 378, 512, 646], SND_W = 128, NODE_H = 68;
const LANES = [96, 122, 148];
const FX_X = 806, FX_W = 150, TAPE_X = 972, TAPE_W = 62, MASTER_X = 1046, MASTER_W = 68;

const SOUNDS = [
  { id: 'keys', role: 'KEYS', c: 'var(--slot-0)', ic: 'piano', name: 'Grand Piano', lvl: 0.72, db: '−1.9 dB', sends: [0.25, 0.1, 0], playing: true },
  { id: 'pad', role: 'PAD', c: 'var(--slot-1)', ic: 'pad', name: 'Warm Pad', lvl: 0.6, db: '−5.2 dB', sends: [0.5, 0.1, 0.35], playing: true },
  { id: 'extra', role: 'EXTRA', c: 'var(--slot-2)', empty: true },
  { id: 'bass', role: 'BASS', c: 'var(--slot-3)', ic: 'bass', name: 'Sub Bass', lvl: 0.66, db: '−3.1 dB', sends: [0, 0, 0], oct: -1, playing: true },
  { id: 'drone', role: 'DRONE', c: 'var(--drone)', ic: 'drone', name: 'D major', lvl: 0.68, db: 'Synth · +1.6 dB', drone: true, playing: true },
];
const FX = [
  { id: 'room', ic: 'room', name: 'Space', val: 'Hall' },
  { id: 'echo', ic: 'echo', name: 'Echo', val: 'Custom' },
  { id: 'chorus', ic: 'chorus', name: 'Chorus', val: '' },
];

export const EDIT_CSS = `
.edit { flex: 1; min-height: 0; display: grid; gap: 12px; padding: 12px 14px 14px; position: relative;
  grid-template-columns: 252px minmax(0, 1fr); grid-template-rows: 58px auto 1fr 108px; }
/* library */
.lib { grid-row: 1 / 4; display: flex; flex-direction: column; padding: 12px; gap: 10px; min-height: 0; }
.lib select, .lib .sel { height: 38px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); display: flex; align-items: center; justify-content: space-between; padding: 0 12px; font-weight: 600; }
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

/* rig map */
.map { padding: 10px 16px 12px; }
.map-t { display: flex; align-items: baseline; gap: 12px; height: 20px; margin-bottom: 8px; }
.map-t .hint { font-size: 12.5px; color: var(--faint); }
.map-t .legend { margin-left: auto; display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--faint); }
.map-t .vibe { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 12px; border: 1px solid var(--line-2); color: var(--muted); font-weight: 600; }
.map-t .vibe b { color: var(--text); }
.map-t .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--muted); margin-right: 5px; vertical-align: -1px; }
.map-a { position: relative; height: ${H}px; --nh: ${NODE_H}px; }
.node.snd, .node.kb, .node.out { height: var(--nh); }
.node.fxn { height: 24px; transform: translateY(-50%); }
.map-a svg.wires { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.node { position: absolute; border-radius: 9px; background: var(--panel-2); border: 1px solid var(--line-2); padding: 7px 8px; overflow: hidden; }
.node .nt { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800; letter-spacing: .09em; color: var(--c); }
.node .nt i { width: 7px; height: 7px; border-radius: 50%; background: var(--led-off); flex: none; }
.node.playing .nt i { background: var(--c); box-shadow: 0 0 7px var(--c); }
.node .nm { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
.node .nm .ic { color: var(--c); } .node .nm b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node .nv { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.node .nv .lvl { flex: 1; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; min-width: 16px; }
.node .nv .lvl em { display: block; height: 100%; background: var(--c); }
.node.snd { border-top: 3px solid var(--c); }
.node.sel { background: color-mix(in srgb, var(--c) 16%, var(--panel-2)); border-color: var(--c); box-shadow: 0 0 0 1.5px var(--c), 0 6px 18px #0008; }
.node.empty { border-style: dashed; border-top: 3px dashed var(--c); background: transparent; }
.node.empty .nm b { color: var(--faint); font-weight: 600; } .node.empty .nm .ic { color: var(--faint); }
.node.kb { --c: var(--muted); }
.node.fxn { --c: var(--fx); display: flex; align-items: center; gap: 7px; padding: 0 9px; border-radius: 12px; }
.node.fxn .ic { color: var(--fx); } .node.fxn b { font-size: 13px; } .node.fxn span { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node.fxn i { margin-left: auto; width: 7px; height: 7px; border-radius: 50%; background: var(--fx); box-shadow: 0 0 6px var(--fx); flex: none; }
.node.out { --c: var(--muted); text-align: center; padding: 6px 4px; }
.node.out .ic { margin: 2px auto 3px; color: var(--muted); } .node.out b { font-size: 12.5px; display: block; } .node.out span { font-size: 11.5px; color: var(--muted); }
.node.off { opacity: .55; }
.dot { position: absolute; border-radius: 50%; transform: translate(-50%, -50%); background: var(--c); }
.dot.zero { background: transparent; border: 1.5px solid var(--line-2); width: 7px !important; height: 7px !important; }
.dot.dim { opacity: .5; }
.dot.hot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 30%, transparent); }
.lane-l { position: absolute; left: 0; width: 98px; text-align: right; font-size: 11.5px; font-weight: 700; color: var(--faint); transform: translateY(-50%); }
.grp-l { position: absolute; font-size: 10.5px; font-weight: 800; letter-spacing: .1em; color: var(--faint); }
.grp-l b { color: var(--muted); font-weight: 700; letter-spacing: 0; font-size: 12px; margin-left: 4px; border-bottom: 1px dashed var(--faint); }

/* focus panel */
.focus { --c: var(--slot-0); position: relative; padding: 0 16px; border-top: 3px solid var(--c); display: flex; flex-direction: column; min-height: 0; }
.focus .conn { position: absolute; top: -28px; width: 3px; height: 28px; background: var(--c); margin-left: -1.5px; border-radius: 2px; }
.focus .conn::after { content: ''; position: absolute; left: -5px; bottom: -6px; width: 13px; height: 13px; border-radius: 50%; background: var(--c); }
.fh { display: flex; align-items: center; gap: 12px; height: 66px; flex: none; border-bottom: 1px solid var(--line); }
.fh .tile { width: 46px; height: 46px; border-radius: 12px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); }
.fh .who .cap { color: var(--c); font-size: 11px; } .fh .who b { display: block; font-size: 24px; line-height: 1.1; }
.fh .src { color: var(--faint); font-size: 13px; margin-left: 4px; align-self: flex-end; padding-bottom: 12px; }
.fh .sp { flex: 1; }
.fb { flex: 1; display: grid; min-height: 0; padding: 14px 0 12px; column-gap: 0; }
.col { padding: 0 20px; border-left: 1px solid var(--line); display: flex; flex-direction: column; min-width: 0; }
.col:first-child { padding-left: 0; border-left: 0; }
.col > .cap { margin-bottom: 2px; } .col > .sub { font-size: 12px; color: var(--faint); margin-bottom: 10px; }
.lvlcol { align-items: center; } .lvlcol .vf-wrap { flex: 1; display: flex; gap: 8px; min-height: 0; width: 100%; justify-content: center; }
.lvlcol .act { width: 6px; border-radius: 3px; background: var(--track); position: relative; overflow: hidden; margin: 4px 0; }
.lvlcol .act em { position: absolute; left: 0; right: 0; bottom: 0; background: linear-gradient(0deg, var(--ok) 0 70%, #e2c23c 70%); }
.lvlcol .db { font-weight: 700; font-size: 17px; margin: 6px 0; }
.lvlcol .mute { width: 100%; height: 34px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 800; letter-spacing: .08em; font-size: 12.5px; }
.knobs { display: flex; gap: 6px; }
.sk { width: 124px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.sk b { font-size: 15px; margin-top: 4px; } .sk .v { font-size: 13px; color: var(--text); font-weight: 600; margin-top: 1px; }
.sk .v small { color: var(--muted); font-weight: 500; } .sk .r { font-size: 11px; color: var(--faint); margin-top: 3px; }
.sends { display: flex; flex-direction: column; gap: 12px; }
.send { display: grid; grid-template-columns: 62px 1fr 42px auto; align-items: center; gap: 10px; }
.send > span { font-weight: 700; font-size: 14px; } .send > b { font-size: 14px; text-align: right; }
.send .to { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px 0 7px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--fx) 45%, var(--line-2)); font-size: 12.5px; font-weight: 650; color: var(--fx); white-space: nowrap; }
.send .to .ic { color: var(--fx); }
.pipe { position: relative; height: 26px; }
.pipe .t { position: absolute; left: 0; right: 10px; top: 10px; height: 6px; border-radius: 3px; background: var(--track); }
.pipe .t em { display: block; height: 100%; border-radius: 3px; background: var(--c); }
.pipe::after { content: ''; position: absolute; right: 0; top: 7px; border: 6px solid transparent; border-left: 9px solid var(--line-2); border-right: 0; }
.pipe .th { position: absolute; top: 2px; width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(#fbfcfd, #d5dae1); box-shadow: 0 1px 4px #0009; margin-left: -11px; }
.sends .note { font-size: 12px; color: var(--faint); line-height: 1.4; }
.play { display: flex; flex-direction: column; gap: 12px; }
.play .row { display: flex; flex-direction: column; gap: 5px; } .play .row > span { font-size: 13px; font-weight: 700; }
.play .seg { --c: var(--slot-0); } .play .seg button { height: 32px; padding: 0 10px; font-size: 13.5px; }
.rangebox { display: flex; align-items: center; gap: 8px; }
.rng { flex: 1; height: 26px; position: relative; }
.rng em { position: absolute; left: 0; right: 0; top: 10px; height: 6px; border-radius: 3px; background: var(--c); }
.rng i { position: absolute; top: 3px; width: 10px; height: 20px; border-radius: 4px; background: #eef1f5; box-shadow: 0 1px 4px #0009; }
.rangebox .mini { flex: 1; height: 26px; border-radius: 5px; background: repeating-linear-gradient(90deg, #aab2bc 0 7px, #0b0d10 7px 8px); position: relative; overflow: hidden; }
.rangebox .mini em { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--c) 55%, transparent); border-left: 2px solid var(--c); border-right: 2px solid var(--c); }
.swrow { display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; font-weight: 700; }
.ff { flex: none; height: 44px; display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.ff .adv { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text); font-size: 14px; }
.ff .adv .ic { transition: none; }
.ff .sum { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ff .sum b { color: #cfd5dd; font-weight: 600; }
.ff .ok { margin-left: auto; font-size: 12px; padding: 3px 9px; border-radius: 10px; background: #1f2a22; color: #8fe0b1; white-space: nowrap; font-weight: 700; }
.ff .ok.chg { background: #2e2716; color: var(--accent); }


/* range picker: its own mini keyboard, so dragging a split never touches the playable keyboard (critic: live) */
.rpick { position: relative; height: 34px; margin-top: 2px; }
.rpick .mk { position: absolute; inset: 0; border-radius: 5px; overflow: hidden; opacity: .5; }
.rhint { font-size: 11.5px; color: var(--faint); }
.rpick .mk .kbd, .rpick .mk .keys { height: 100%; }
.rpick .mk .wk span { display: none; }
.rpick > em { position: absolute; top: -3px; bottom: -3px; border-radius: 5px; border: 2.5px solid var(--c); background: color-mix(in srgb, var(--c) 22%, transparent); }
.rpick > i { position: absolute; top: -6px; bottom: -6px; width: 12px; margin-left: -6px; border-radius: 4px; background: #eef1f5; box-shadow: 0 1px 5px #000b; }
.rpick > i[style*="right"] { margin-left: 0; margin-right: -6px; }
.rbtns { display: flex; gap: 6px; margin-top: 4px; } .rbtns .btn { flex: 1; justify-content: center; font-size: 12px; padding: 0 6px; }
.btn.chg.open { border-color: var(--c); box-shadow: 0 0 0 2px var(--c); }
.bigbtn { border-radius: var(--radius); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 15px; display: flex; align-items: center; justify-content: center; gap: 8px; }
.bigbtn.fade { background: #182231; }
.bigbtn.panic { background: #d9363a; color: #fff; border: 0; font-size: 21px; letter-spacing: .06em; flex-direction: column; gap: 0; box-shadow: 0 0 20px #d9363a44; }
.bigbtn.panic small { font-size: 11px; letter-spacing: .04em; opacity: .75; font-weight: 700; }
.kbrow .rbars { margin-bottom: 9px; }
/* instrument menu (holds the destructive "Remove this sound…" at the very bottom) */
.imenu { position: absolute; z-index: 30; width: 330px; background: #1f242c; border: 1px solid #555e6c; border-radius: 12px; box-shadow: 0 20px 56px #000d; padding: 8px; }
.imenu .ig { font-size: 11px; font-weight: 800; letter-spacing: .1em; color: var(--faint); padding: 8px 10px 4px; display: flex; align-items: center; gap: 7px; }
.imenu .ii { display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 10px; border-radius: 7px; font-size: 14px; font-weight: 600; color: #dfe4ea; }
.imenu .ii small { margin-left: auto; color: var(--faint); font-size: 12px; font-weight: 500; }
.imenu .ii.on { background: color-mix(in srgb, var(--slot-0) 18%, var(--panel-2)); color: var(--text); }
.imenu .ii.on::before { content: '✓'; color: var(--slot-0); font-weight: 800; margin-left: -2px; }
.imenu .ii.more { color: var(--faint); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; line-height: 34px; }
.imenu hr { border: 0; border-top: 1px solid var(--line); margin: 8px 2px; }
.imenu .ii.danger { color: #ff9a9c; } .imenu .ii.danger small { color: #b77; }

/* presets (Space panel) */
.ptiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.ptile { text-align: left; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--line-2); background: var(--panel-2); min-height: 66px; }
.ptile b { display: block; font-size: 15px; } .ptile small { display: block; font-size: 11.5px; color: var(--muted); line-height: 1.3; margin-top: 2px; }
.ptile.on { border-color: var(--fx); background: color-mix(in srgb, var(--fx) 16%, var(--panel-2)); box-shadow: 0 0 0 1.5px var(--fx); }
.ptile.on b::after { content: ' ✓'; color: var(--fx); }
.vibes { display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; overflow: hidden; }
.vibes button { height: 28px; padding: 0 10px; border-radius: 14px; border: 1px solid var(--line-2); background: var(--panel-2); font-size: 12.5px; font-weight: 650; white-space: nowrap; }

/* advanced (2nd and last disclosure level) */
.advp { position: absolute; left: 0; right: 0; bottom: 44px; top: 66px; background: #181b21; border-top: 1px solid var(--line-2); padding: 14px 16px 10px; display: grid; grid-template-columns: 1fr 1.2fr 1.75fr; gap: 0; }
.advp .col:first-child .arow { grid-template-columns: 52px 1fr 52px; }
.advp .seg button { padding: 0 7px; } .arow .seg { justify-self: start; }
.arow.w { grid-template-columns: 86px 1fr; }
.advp .col { padding: 0 18px; } .advp .col:first-child { padding-left: 0; }
.arow { display: grid; grid-template-columns: 96px 1fr 64px; align-items: center; gap: 10px; min-height: 34px; font-size: 13.5px; }
.arow > span { font-weight: 650; color: #d5dae1; } .arow > b { text-align: right; font-size: 13px; }
.arow .hfader { height: 22px; } .arow .hf-thumb { width: 18px; height: 18px; top: 2px; } .arow .hf-track { top: 8px; }
.arow .seg button { height: 28px; padding: 0 8px; font-size: 12.5px; }
.arow.mapped > span::after { content: '  · knob'; color: var(--faint); font-weight: 500; font-size: 11.5px; }
.eng { display: grid; grid-template-columns: 1fr 1fr; column-gap: 22px; }
.eng .arow { grid-template-columns: 78px 1fr 56px; }

/* keyboard */
.kbrow { grid-column: 1 / 3; display: grid; grid-template-columns: 150px 1fr 120px 104px 112px; gap: 12px; padding: 9px 12px 10px; }
.kleg { display: flex; flex-direction: column; justify-content: center; gap: 5px; font-size: 12px; font-weight: 700; }
.kleg div { display: flex; align-items: center; gap: 7px; } .kleg i { width: 18px; height: 5px; border-radius: 3px; background: var(--c); }
.kleg span { color: var(--faint); font-weight: 600; margin-left: auto; }
.kleg .dim { opacity: .45; }
.kmeter { display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.kmeter .cap { font-size: 10.5px; }
.kmeter div.m { height: 7px; border-radius: 4px; background: linear-gradient(90deg, #2bbf6a 0 62%, #e2c23c 62% 80%, #e4573d 80%) left/var(--l) 100% no-repeat, #262b33; }


/* ---------------- H additions ---------------- */
.live { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 12px; background: #16301f; color: #8fe0b1; font-size: 12px; font-weight: 800; letter-spacing: .06em; }
.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 7px var(--ok); }
.shead .livehint { font-size: 12.5px; color: var(--faint); line-height: 1.3; max-width: 250px; text-align: right; }
/* sentence header: the words are the controls (B) */
.sent { font-size: 21px; font-weight: 500; color: #c9d0d9; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sent .role { color: var(--c); font-weight: 800; letter-spacing: .04em; }
.sent .tok { color: var(--text); font-weight: 700; border-bottom: 2px dotted color-mix(in srgb, var(--c) 80%, transparent); padding-bottom: 1px; }
.fh .src2 { display: block; font-size: 12.5px; color: var(--faint); margin-top: 2px; }
.fh .whobox { min-width: 0; flex: 0 1 auto; }
/* "On stage" mini-strip: the exact Perform strip widgets */
.onstage { align-items: stretch; }
.onstage .ontile { height: 42px; flex: none; border-radius: 9px; display: flex; align-items: center; gap: 8px; padding: 0 7px 0 10px;
  border: 1.5px solid var(--c); background: color-mix(in srgb, var(--c) 17%, var(--panel-2)); }
.onstage .ontile i { width: 10px; height: 10px; border-radius: 50%; background: var(--c); box-shadow: 0 0 9px var(--c); }
.onstage .ontile .r { font-weight: 800; font-size: 13px; letter-spacing: .1em; color: var(--c); }
.onstage .ontile .st { margin-left: auto; font-size: 12px; font-weight: 800; padding: 2px 7px; border-radius: 5px; background: var(--c); color: #0d0f12; }
.onstage .osb { flex: 1; min-height: 0; display: grid; grid-template-columns: 64px 1fr; gap: 10px; margin-top: 10px; }
.onstage .osf { display: flex; flex-direction: column; min-height: 0; }
.onstage .mods { align-content: start; }
.onstage .fzrow { flex: 1; display: flex; gap: 6px; justify-content: center; min-height: 0; margin: 0 0 4px; }
.onstage .fzrow .vfader { margin: 0; }
.onstage .act { width: 6px; border-radius: 3px; background: var(--track); position: relative; overflow: hidden; margin: 4px 0; }
.onstage .act em { position: absolute; left: 0; right: 0; bottom: 0; background: linear-gradient(0deg, var(--ok) 0 70%, #e2c23c 70%); }
.onstage .db { text-align: center; font-weight: 700; font-size: 14px; white-space: nowrap; }
.mods { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.mod { position: relative; overflow: hidden; height: 42px; border-radius: 8px; border: 1.5px solid var(--line-2); background: transparent;
  display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.12; padding: 0 2px 3px; color: #9aa3af; }
.mod span { font-size: 12.5px; font-weight: 800; } .mod b { font-size: 12.5px; font-weight: 600; }
.mod.on { background: var(--c); border-color: var(--c); color: #0d0f12; } .mod.on b { font-weight: 800; }
.mod > i { position: absolute; left: 0; bottom: 0; height: 4px; background: #0d0f1266; }
.mod.sus { flex-direction: row; gap: 7px; } .mod.sus em { width: 10px; height: 10px; border-radius: 50%; background: var(--led-off); }
.mod.sus.lit { border-color: color-mix(in srgb, var(--c) 60%, var(--line-2)); color: var(--text); } .mod.sus.lit em { background: var(--c); box-shadow: 0 0 8px var(--c); }
.mod.wide { grid-column: 1 / 3; flex-direction: row; gap: 8px; height: 34px; }
.onstage .same { font-size: 11px; color: var(--faint); text-align: center; margin-top: 6px; }
/* word sliders (no dials): name + word value, thick track, end words */
.wsl { display: flex; flex-direction: column; gap: 14px; }
.ws .wsh { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.ws .wsh b { font-size: 15px; } .ws .wsh .wv { font-size: 14px; font-weight: 700; } .ws .wsh .wv small { color: var(--muted); font-weight: 500; font-size: 12.5px; margin-left: 4px; }
.ws .wst { position: relative; height: 28px; }
.ws .wst .t { position: absolute; left: 0; right: 0; top: 10px; height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; }
.ws .wst .t em { position: absolute; top: 0; bottom: 0; background: var(--c); }
.ws .wst .mid { position: absolute; left: 50%; top: 5px; width: 2px; height: 18px; background: #5b6472; margin-left: -1px; }
.ws .wst .th { position: absolute; top: 2px; width: 24px; height: 24px; border-radius: 7px; margin-left: -12px; background: linear-gradient(#fbfcfd, #d5dae1); box-shadow: 0 1px 4px #0009; }
.ws .wse { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--faint); margin-top: 1px; }
/* who's sending in: step rows in slot colours (the same steps as the Perform chip panel) */
.sendrows { display: flex; flex-direction: column; gap: 9px; }
.sr { display: grid; grid-template-columns: 54px 1fr; align-items: center; gap: 10px; }
.sr > span { font-weight: 800; font-size: 13.5px; color: var(--c); }
.sr .seg button { height: 32px; padding: 0 9px; font-size: 13px; } .sr .seg button.on { background: var(--c); }
.sr .seg button.near { outline: 1.5px dashed var(--c); outline-offset: -4px; }
.sr.off > span { color: var(--faint); }
@media (max-width: 1250px) {
  .edit { grid-template-columns: 1fr; grid-template-rows: 48px auto 1fr 66px; gap: 8px; padding: 8px 10px 10px; }
  .lib { display: none; }
  .shead { padding: 0 10px; gap: 8px; } .shead h1 { font-size: 19px; } .hchip { height: 32px; padding: 0 10px; font-size: 13px; } .shead .fac { display: none; }
  .shead .songsbtn { display: inline-flex !important; }
  .map { padding: 7px 12px 8px; } .map-t { margin-bottom: 4px; } .map-t .legend > span:first-child { display: none; } .map-t .hint { font-size: 11.5px; }
  .map-a { height: 118px; --nh: 50px; }
  .node { padding: 5px 6px; } .node .nv { display: none; } .node .nm b { font-size: 12.5px; } .node .nt { font-size: 10px; }
  .node.fxn { height: 22px; } .node.fxn span { display: none; } .node.out b { font-size: 11px; } .node.out span { display: none; } .node.out .ic { margin: 0 auto 2px; }
  .grp-l { font-size: 9.5px; } .lane-l { font-size: 10.5px; }
  .focus .conn { top: -20px; height: 20px; }
  .fh { height: 50px; } .fh .tile { width: 36px; height: 36px; } .fh .tile .ic { width: 22px; height: 22px; } .fh .who b { font-size: 19px; } .fh .src { display: none; }
  .fb { padding: 8px 0 6px; }
  .col { padding: 0 12px; } .col > .sub { display: none; } .col > .cap { margin-bottom: 6px; }
  .lvlcol .db { font-size: 14px; margin: 3px 0; } .lvlcol .mute { height: 28px; }
  .sk { width: 84px; } .sk .knob-svg { width: 56px; height: 56px; } .sk .r { display: none; } .sk b { font-size: 13px; } .sk .v { font-size: 11.5px; }
  .sends { gap: 4px; } .send { grid-template-columns: 50px 1fr 34px; gap: 6px; } .send .to { display: none; } .send > span, .send > b { font-size: 12.5px; }
  .play { gap: 6px; } .play small { display: none; } .rpick { height: 26px; } .play .seg button { height: 28px; padding: 0 7px; font-size: 12.5px; }
  .ff { height: 34px; font-size: 12px; } .ff .sum { font-size: 11.5px; }
  .sent { font-size: 16px; } .fh .src2 { display: none; } .shead .livehint { display: none; }
  .onstage .ontile { height: 34px; } .onstage .db { font-size: 13px; margin-bottom: 4px; } .onstage .same { display: none; }
  .mod { height: 34px; } .mod span, .mod b { font-size: 11px; } .mod.wide { height: 28px; } .mods { gap: 4px; }
  .wsl { gap: 4px; } .ws .wse { display: none; } .ws .wsh b { font-size: 13px; } .ws .wsh .wv { font-size: 12px; } .ws .wst { height: 22px; } .ws .wst .t { top: 8px; height: 6px; } .ws .wst .th { width: 20px; height: 20px; top: 1px; }
  .kbrow { grid-column: 1; grid-template-columns: 1fr 70px 84px 92px; padding: 5px 10px 7px; gap: 8px; } .kleg { display: none; } .kmeter .cap { display: none; }
}
`;

function wires(sel) {
  const selIdx = SOUNDS.findIndex((s) => s.id === sel);
  let d = '';
  // keyboard → sounds
  d += `<path d="M94 31H104" stroke="var(--line-2)" stroke-width="2" vector-effect="non-scaling-stroke"/>
        <path d="M102 26l6 5-6 5" fill="none" stroke="var(--line-2)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  // dry bus → tape
  d += `<path d="M774 31H964" stroke="#4a5260" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
        <path d="M962 25l8 6-8 6" fill="none" stroke="#4a5260" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
        <path d="M1034 31H1040" stroke="#4a5260" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
        <path d="M1038 25l7 6-7 6" fill="none" stroke="#4a5260" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
  // lanes
  LANES.forEach((y) => { d += `<path d="M104 ${y}H${FX_X - 4}" stroke="#343b46" stroke-width="2" vector-effect="non-scaling-stroke"/>`; });
  // returns: fx → tape
  LANES.forEach((y) => { d += `<path d="M${FX_X + FX_W} ${y}C${FX_X + FX_W + 40} ${y} 1003 ${y - 6} 1003 ${NODE_H + 2}" fill="none" stroke="#4a5260" stroke-width="2" vector-effect="non-scaling-stroke"/>`; });
  // drops from each sound with sends
  SOUNDS.forEach((s, i) => {
    if (s.empty || s.drone) return;
    const cx = SND_X[i] + SND_W / 2;
    const hot = i === selIdx;
    d += `<path d="M${cx} ${NODE_H}V${hot ? H : LANES[2]}" stroke="${s.c}" stroke-width="${hot ? 3 : 1.5}" opacity="${hot ? 1 : selIdx >= 0 ? 0.35 : 0.6}" vector-effect="non-scaling-stroke"/>`;
  });
  // selected FX → highlight its lane
  const fxIdx = FX.findIndex((f) => f.id === sel);
  if (fxIdx >= 0) {
    const y = LANES[fxIdx];
    d += `<path d="M104 ${y}H${FX_X}" stroke="var(--fx)" stroke-width="2.5" opacity=".8" vector-effect="non-scaling-stroke"/>
          <path d="M${FX_X + FX_W / 2} ${y + 12}V${H}" stroke="var(--fx)" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
  }
  return `<svg class="wires" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${d}</svg>`;
}

function dots(sel) {
  const selIdx = SOUNDS.findIndex((s) => s.id === sel);
  const fxIdx = FX.findIndex((f) => f.id === sel);
  let o = '';
  SOUNDS.forEach((s, i) => {
    if (s.empty || s.drone) return;
    const cx = SND_X[i] + SND_W / 2;
    s.sends.forEach((v, j) => {
      const r = v > 0 ? 7 + 14 * v : 0;
      const hot = i === selIdx || j === fxIdx;
      const dim = !hot && (selIdx >= 0 || fxIdx >= 0);
      o += `<div class="dot${v === 0 ? ' zero' : ''}${dim ? ' dim' : ''}${hot && v > 0 ? ' hot' : ''}" style="--c:${s.c};left:${px(cx)};top:${py(LANES[j])};width:${r}px;height:${r}px"></div>`;
    });
  });
  return o;
}

function nodes(sel) {
  let o = `<div class="node kb" style="left:0;top:0;width:${px(94)}">
      <div class="nt">${icon('keyboard', 14)}PLAY</div><div class="nm"><b style="font-size:13.5px">Keyboard</b></div><div class="nv">Key D · wheels</div></div>`;
  SOUNDS.forEach((s, i) => {
    const cls = `node snd${s.empty ? ' empty' : ''}${s.id === sel ? ' sel' : ''}${s.playing ? ' playing' : ''}`;
    const st = `--c:${s.c};left:${px(SND_X[i])};top:0;width:${px(SND_W)}`;
    if (s.empty) {
      o += `<div class="${cls}" style="${st}"><div class="nt"><i></i>${s.role}</div><div class="nm">${icon('plus', 16)}<b>Add sound</b></div></div>`;
    } else {
      o += `<div class="${cls}" style="${st}"><div class="nt"><i></i>${s.role}</div><div class="nm">${icon(s.ic, 17)}<b>${s.name}</b></div>
        <div class="nv">${s.drone ? s.db : `<span class="lvl"><em style="width:${s.lvl * 100}%"></em></span>${s.db}`}</div></div>`;
    }
  });
  FX.forEach((f, j) => {
    o += `<div class="node fxn${f.id === sel ? ' sel' : ''}" style="left:${px(FX_X)};top:${py(LANES[j])};width:${px(FX_W)}">${icon(f.ic, 15)}<b>${f.name}</b><span>${f.val}</span><i></i></div>`;
  });
  o += `<div class="node out off" style="left:${px(TAPE_X)};top:0;width:${px(TAPE_W)}">${icon('tape', 18)}<b>Tape</b><span>off</span></div>
    <div class="node out" style="left:${px(MASTER_X)};top:0;width:${px(MASTER_W)}">${icon('speaker', 18)}<b>Master</b><span>−6.0 dB</span></div>`;
  o += ['Space', 'Echo', 'Chorus'].map((n, j) => `<div class="lane-l" style="top:${py(LANES[j])}">→ ${n}</div>`).join('');
  o += `<div class="grp-l" style="left:${px(FX_X)};top:${py(50)}">SHARED EFFECTS</div>`;
  o += `<div class="grp-l" style="left:${px(806)};top:${py(10)}">DRY MIX</div>`;
  return o;
}

function rigMap(sel) {
  return `<section class="card map">
    <div class="map-t"><span class="cap">Your rig</span><span class="hint">Click any block to edit it. Lights show what’s sounding.</span>
      <span class="legend"><span><i></i>dot size = how much of a sound goes into that effect</span><span class="vibe">Vibe <b>Custom</b> ${icon('down', 13)}</span></span></div>
    <div class="map-a">${wires(sel)}${dots(sel)}${nodes(sel)}</div>
  </section>`;
}

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


function miniKeys() {
  return keyboard(36, 96, { showRanges: false, labels: false });
}

function instrumentMenu() {
  const g = (ic, name, items) => `<div class="ig">${icon(ic, 14)}${name}</div>` + items.map(([n, sub, on]) => `<div class="ii${on ? ' on' : ''}">${n}<small>${sub}</small></div>`).join('');
  return `<div class="imenu" style="left:706px;top:417px">
    ${g('piano', 'PIANO', [['Grand Piano', 'sampled', true], ['Felt Piano', 'sampled']])}
    ${g('piano', 'ELECTRIC PIANO', [['Rhodes', 'sampled'], ['Lofi Rhodes', 'sampled']])}
    ${g('pad', 'SYNTH PADS', [['Warm Pad', 'synth']])}
    <div class="ii more">Organ, Synth Keys, Brass &amp; Leads, Mallets, Guitar, Bass, My Samples ▾</div>
    <hr><div class="ii danger">${icon('trash', 15)}Remove this sound…<small>asks first · Undo</small></div>
  </div>`;
}

function wordSlider(name, v, word, sub, ends, { bipolar = false } = {}) {
  const fill = bipolar
    ? (v >= 0.5 ? `left:50%;width:${(v - 0.5) * 100}%` : `left:${v * 100}%;width:${(0.5 - v) * 100}%`)
    : `left:0;width:${v * 100}%`;
  return `<div class="ws"><div class="wsh"><b>${name}</b><span class="wv">${word}<small>${sub}</small></span></div>
    <div class="wst"><div class="t"><em style="${fill}"></em></div>${bipolar ? '<i class="mid"></i>' : ''}<div class="th" style="left:${v * 100}%"></div></div>
    <div class="wse"><span>${ends[0]}</span><span>${ends[1]}</span></div></div>`;
}

function pipe(label, v, dest, c = 'var(--c)') {
  return `<div class="send" style="--c:${c}"><span>${label}</span>
    <div class="pipe"><div class="t"><em style="width:${v * 100}%"></em></div><div class="th" style="left:calc((100% - 10px) * ${v})"></div></div>
    <b>${Math.round(v * 100)}%</b>${dest ? `<span class="to">${icon('arrow', 13)}${dest}</span>` : ''}</div>`;
}

const sgn = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

function onStage(s) {
  const pct = (x) => Math.round(x * 100);
  const amt = (label, v) => `<button class="mod${v > 0 ? ' on' : ''}"><span>${label}</span><b>${v ? `${pct(v)}%` : 'off'}</b>${v ? `<i style="width:${pct(v)}%"></i>` : ''}</button>`;
  const ch = s.sends[2];
  return `<div class="col onstage"><span class="cap" style="margin-bottom:8px">On stage</span>
    <button class="ontile"><i></i><span class="r">${s.role}</span><span class="st">ON</span></button>
    <div class="osb"><div class="osf"><div class="fzrow">${vfader(s.lvl, s.c)}<div class="act"><em style="height:${s.id === 'pad' ? 48 : 62}%"></em></div></div>
    <div class="db">${s.db}</div></div>
    <div class="mods">${amt('Space', s.sends[0])}${amt('Echo', s.sends[1])}
      <button class="mod${s.oct ? ' on' : ''}"><span>Octave</span><b>${s.oct ? sgn(s.oct) : 'normal'}</b></button>
      <button class="mod sus lit"><em></em><span>Sustain</span></button>
      <button class="mod wide${ch > 0 ? ' on' : ''}"><span>Chorus</span><b>${ch ? `${pct(ch)}%` : 'off'}</b></button></div></div>
    <div class="same">Same switches as your Perform strip</div>
  </div>`;
}

function slotPanel(s, { advanced = false, menu = false } = {}) {
  const isPad = s.id === 'pad';
  const sliders = isPad
    ? wordSlider('Brightness', 0.42, 'Mellow', '1.8 kHz', ['darker', 'brighter']) +
      wordSlider('Warmth', 0.5, 'Neutral', '0 dB', ['thinner', 'fuller'], { bipolar: true }) +
      wordSlider('Fade-in', 0.36, 'Slow', '1.2 s', ['instant', 'slow swell'])
    : wordSlider('Brightness', 1, 'Bright', '100%', ['darker', 'brighter']) +
      wordSlider('Warmth', 0.5, 'Neutral', '0 dB', ['thinner', 'fuller'], { bipolar: true }) +
      wordSlider('Ring-out', 0.3, 'Natural', '0.35 s', ['short', 'long']);
  const adv = advanced ? advancedPanel(s) : '';
  const src = isPad ? 'Synth Pads · built-in synth' : 'Piano · sampled (Salamander)';
  const sentence = isPad
    ? `<span class="role">PAD</span> plays <span class="tok">Warm Pad</span>, <span class="tok">swells with the wheel</span>, half into the <span class="tok">Hall</span>, with <span class="tok">chorus</span>`
    : `<span class="role">KEYS</span> plays <span class="tok">Grand Piano</span> on <span class="tok">every key</span>, a little into the <span class="tok">Hall</span>, sustain <span class="tok">on</span>`;
  const summary = isPad
    ? '<b>Pan</b> Center · <b>Width</b> 100% · <b>Transpose</b> 0 · <b>Voices</b> All · <b>Response</b> Normal · <b>Pitch bend</b> Off · <b>Warm Pad</b> 8 more settings'
    : '<b>Pan</b> Center · <b>Width</b> 100% · <b>Highs</b> 0 dB · <b>Transpose</b> 0 · <b>Voices</b> All · <b>Response</b> Normal · <b>Pitch bend</b> Off';
  const range = s.id === 'bass' ? 'below middle C' : 'every key';
  return `<section class="card focus" style="--c:${s.c}">
    <div class="conn" style="left:calc(16px + (100% - 32px) * ${(SND_X[SOUNDS.indexOf(s)] + SND_W / 2) / W})"></div>
    <div class="fh"><div class="tile">${icon(s.ic, 28)}</div>
      <div class="whobox"><div class="sent">${sentence}</div><span class="src2">${src} · the underlined words jump to their control</span></div>
      <span class="sp"></span><button class="btn sm chg${menu ? ' open' : ''}">Change instrument ${icon('down', 14)}</button></div>
    <div class="fb" style="grid-template-columns: 250px minmax(0, 1fr) 290px">
      ${onStage(s)}
      <div class="col"><span class="cap">The sound itself</span><span class="sub">Shape the ${isPad ? 'pad' : 'piano'}. Words first, numbers beside them.</span><div class="wsl">${sliders}</div></div>
      <div class="col play"><span class="cap">Where it plays</span>
        <div class="row"><span>Keyboard range <em class="faint" style="font-style:normal;font-weight:600">· ${range}</em></span>
          <div class="rpick"><div class="mk">${miniKeys()}</div><em style="left:0;right:0"></em><i style="left:0"></i><i style="right:0"></i></div>
          <div class="rbtns"><button class="btn sm">Set lowest…</button><button class="btn sm">Set highest…</button></div>
          <small class="rhint">Tap Set, then play the key on your keyboard.</small></div>
        <div class="row"><span>Response <em class="faint" style="font-style:normal;font-weight:600">· this sound only</em></span><div class="seg" style="--c:${s.c}"><button>Soft</button><button class="on">Normal</button><button>Hard</button><button>Fixed</button></div></div>
      </div>
    </div>
    ${adv}
    <div class="ff"><span class="adv">${icon(advanced ? 'down' : 'chevron', 16)}Advanced</span><span class="sum">${summary}</span>
      <span class="ok">all at default</span></div>
  </section>`;
}

function advancedPanel(s) {
  const r = (label, v, val, cls = '') => `<div class="arow ${cls}"><span>${label}</span>${hfader(v, s.c)}<b>${val}</b></div>`;
  return `<div class="advp">
    <div class="col"><span class="cap" style="margin-bottom:8px">Mix</span>
      ${r('Pan', 0.5, 'Center')}${r('Width', 0.667, '100%')}${r('Highs', 0.5, '0 dB')}
      </div>
    <div class="col"><span class="cap" style="margin-bottom:8px">Playing</span>
      <div class="arow w"><span>Transpose</span><div class="seg"><button>−</button><button style="min-width:56px;cursor:default">0 st</button><button>+</button></div></div>
      <div class="arow w"><span>Voices</span><div class="seg" style="--c:${s.c}"><button class="on">Poly</button><button>Mono low</button><button>Mono high</button></div></div>
      <div class="arow w"><span>Touch</span><div class="seg" style="--c:${s.c}"><button>Soft</button><button class="on">Normal</button><button>Hard</button><button>Fixed</button></div></div>
      <div class="arow w"><span>Pitch bend</span><span class="switch" style="justify-self:start"></span></div></div>
    <div class="col"><span class="cap" style="margin-bottom:8px">Warm Pad engine <span class="faint" style="letter-spacing:0;text-transform:none;font-weight:500">· Cutoff and Attack live on the Brightness and Fade-in knobs</span></span>
      <div class="eng">
        ${r('Decay', 0.3, '0.5 s')}${r('Resonance', 0, '0')}
        ${r('Sustain', 0.8, '80%')}${r('LFO rate', 0.35, '0.08 Hz')}
        ${r('Release', 0.62, '3.0 s')}${r('LFO depth', 0.25, '300 ¢')}
        ${r('Sub level', 0.5, '50%')}${r('Detune', 0.42, '17 ¢')}
      </div></div>
  </div>`;
}

function roomPanel() {
  const tiles = [
    ['Dry', 'No reverb. For a wet PA.'], ['Room', 'Small, quick. Keys sit close.'], ['Stage', 'Medium hall. The Sunday default.'],
    ['Hall', 'Big hall. Pads bloom, piano gets lush.', true], ['Cathedral', 'Huge, dark, long tail.'], ['Ambient Wash', 'Maximum size. Pad-only songs.'],
  ];
  const steps = [0, 25, 50, 75, 100];
  const sr = (role, c, v, near) => `<div class="sr" style="--c:${c}"><span>${role}</span><div class="seg">${steps.map((p) => `<button class="${p === v ? 'on' : ''}${p === near ? ' near' : ''}">${p ? `${p}%` : 'Off'}</button>`).join('')}</div></div>`;
  const cx = (FX_X + FX_W / 2) / W;
  return `<section class="card focus" style="--c:var(--fx)">
    <div class="conn" style="left:calc(16px + (100% - 32px) * ${cx})"></div>
    <div class="fh"><div class="tile">${icon('room', 28)}</div>
      <div class="whobox"><div class="sent"><span class="role">SPACE</span> is a <span class="tok">Hall</span>. <span class="tok">Keys</span> and <span class="tok">Pad</span> go into it; Bass stays dry.</div>
      <span class="src2">The one reverb every sound shares. Each sound’s Space chip sets how much of it goes in.</span></div>
      <span class="sp"></span>
      <span class="muted" style="font-size:13px">Level</span><div style="width:140px">${hfader(0.575, 'var(--fx)')}</div><b style="font-size:14px;width:56px;text-align:right">+1.2 dB</b></div>
    <div class="fb" style="grid-template-columns: 1.25fr 1fr 1.05fr">
      <div class="col"><span class="cap">Choose a space</span><span class="sub">Sets size, darkness, pre-delay and level together</span>
        <div class="ptiles">${tiles.map(([n, b, on]) => `<button class="ptile${on ? ' on' : ''}"><b>${n}</b><small>${b}</small></button>`).join('')}</div></div>
      <div class="col"><span class="cap">Fine-tune</span><span class="sub">Moving one makes it “Custom ≈ Hall”</span>
        <div class="wsl" style="--c:var(--fx)">
          ${wordSlider('Size', 0.65, 'Large', '65%', ['small', 'huge'])}
          ${wordSlider('Darkness', 0.45, 'Medium', '45%', ['bright', 'dark'])}
          ${wordSlider('Pre-delay', 0.175, 'Short', '35 ms', ['none', 'long'])}</div></div>
      <div class="col"><span class="cap">Who’s sending in</span><span class="sub">The same steps as each sound’s Space chip</span>
        <div class="sendrows">${sr('Keys', 'var(--slot-0)', 25)}${sr('Pad', 'var(--slot-1)', 50)}
          <div class="sr off"><span>Extra</span><span class="faint" style="font-size:13px">empty slot</span></div>
          ${sr('Bass', 'var(--slot-3)', 0)}
          <div class="note faint" style="font-size:12px">The drone has its own fixed send.</div></div></div>
    </div>
    <div class="ff"><span class="adv">Vibe</span><span class="faint">sets Space, Echo, Chorus and Tape together:</span>
      <div class="vibes"><button>Sunday</button><button>Full Set</button><button>Prayer</button><button>Jam</button><button>Lofi Tape</button><button>Ambient</button></div>
      <span class="ok chg">changed from factory</span></div>
  </section>`;
}

export function editBody(sel, { advanced = false, menu = false } = {}) {
  const s = SOUNDS.find((x) => x.id === sel);
  const panel = s ? slotPanel(s, { advanced, menu }) : roomPanel();
  return `${topbar('edit')}
  <main class="edit">
    ${library()}
    ${header()}
    ${rigMap(sel)}
    ${panel}
    ${kbRow(sel)}
    ${menu ? instrumentMenu() : ''}
  </main>`;
}
