// H-sheet Edit: B-v2's song-sheet Edit inside H's frame (library · song header · sheet · keyboard row).
// One plain-English line per sound; the underlined words are the controls; the open line shows 3–4 word sliders;
// Advanced is the second (and last) level inside each line. No round knobs anywhere.
import { icon, hfader, keyboard } from './helpers.mjs';
import { topbar } from './perform.mjs';

export const EDIT_CSS = `
.edit { flex: 1; min-height: 0; display: grid; gap: 12px; padding: 12px 14px 14px; position: relative;
  grid-template-columns: 252px minmax(0, 1fr); grid-template-rows: 58px 1fr 108px; }
/* library (unchanged from H) */
.lib { grid-row: 1 / 3; display: flex; flex-direction: column; padding: 12px; gap: 10px; min-height: 0; }
.lib .sel { height: 38px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); display: flex; align-items: center; justify-content: space-between; padding: 0 12px; font-weight: 600; }
.lib .rh { font-size: 12px; color: var(--faint); margin-top: -4px; }
.songs { flex: 1; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
.song-row { display: flex; align-items: center; gap: 9px; height: 38px; padding: 0 10px; border-radius: var(--radius-sm); font-weight: 600; font-size: 14.5px; color: #d9dee5; }
.song-row small { color: var(--faint); width: 16px; text-align: right; font-size: 12px; }
.song-row em { margin-left: auto; font-style: normal; color: var(--faint); font-size: 12.5px; font-weight: 700; }
.song-row.on { background: var(--panel-3); color: var(--text); box-shadow: inset 3px 0 0 var(--accent); }
.song-row.on em { color: var(--accent); }
.lib .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; } .lib .actions .btn { justify-content: center; padding: 0 6px; font-size: 13px; }
.lib .file { font-size: 13px; color: var(--muted); display: flex; justify-content: space-between; border-top: 1px solid var(--line); padding-top: 10px; }

/* song header (unchanged from H) */
.shead { display: flex; align-items: center; gap: 10px; padding: 0 12px 0 16px; min-width: 0; }
.shead h1 { margin: 0 8px 0 0; font-size: 25px; white-space: nowrap; }
.hchip { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 19px; border: 1px solid var(--line-2); background: var(--panel-2); font-size: 14px; font-weight: 600; white-space: nowrap; }
.hchip .cap { font-size: 10.5px; } .hchip b { font-size: 15px; } .hchip .ic { color: var(--muted); }
.hchip .tapb { margin-left: 2px; padding: 3px 8px; border-radius: 10px; background: var(--panel-3); font-size: 12px; font-weight: 700; }
.shead .sp { flex: 1; }
.live { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 12px; background: #16301f; color: #8fe0b1; font-size: 12px; font-weight: 800; letter-spacing: .06em; flex: none; }
.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 7px var(--ok); }
.shead .livehint { font-size: 12.5px; color: var(--faint); line-height: 1.3; max-width: 250px; text-align: right; }

/* ------------------------------------------------------------------ the sheet */
.sheet { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 9px 12px 10px; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #4a5260 transparent; }
.shint { display: flex; align-items: baseline; gap: 12px; height: 20px; flex: none; padding: 0 4px; }
.shint .h { font-size: 13px; color: var(--muted); }
.shint .h u { text-decoration: none; border-bottom: 2px dotted var(--muted); color: var(--text); font-weight: 700; }
.shint .r { margin-left: auto; font-size: 12.5px; color: var(--faint); }

.ln { --c: var(--slot-0); flex: none; border-radius: 11px; border: 1px solid var(--line); background: #181b21; }
.lh { display: grid; grid-template-columns: 124px minmax(0, 1fr) 176px 34px; align-items: center; column-gap: 14px; min-height: 48px; padding: 4px 8px 4px 7px; }
.ln.s1 { --c: var(--slot-1); } .ln.s2 { --c: var(--slot-2); } .ln.s3 { --c: var(--slot-3); }
.ln.dr { --c: var(--drone); } .ln.hd { --c: #aab3bf; } .ln.fx { --c: var(--fx); }
/* ON tile: the same object as the head of the Perform strip (tap = mute) */
.ot { height: 38px; border-radius: 9px; display: flex; align-items: center; gap: 7px; padding: 0 6px 0 9px; text-align: left;
  border: 1.5px solid var(--c); background: color-mix(in srgb, var(--c) 17%, var(--panel-2)); }
.ot i { width: 10px; height: 10px; border-radius: 50%; background: var(--c); box-shadow: 0 0 9px var(--c); flex: none; }
.ot .r { font-weight: 800; font-size: 13px; letter-spacing: .1em; color: var(--c); }
.ot .st { margin-left: auto; font-size: 11.5px; font-weight: 800; letter-spacing: .06em; padding: 2px 6px; border-radius: 5px; background: var(--c); color: #0d0f12; }
.ot.static { border-style: solid; border-color: color-mix(in srgb, var(--c) 45%, var(--line-2)); background: var(--panel-2); gap: 8px; }
.ot.static .ic { color: var(--c); }
.ot.empty { border-style: dashed; background: transparent; } .ot.empty .ic { color: var(--c); }
/* the sentence: underlined words are the controls */
.say { font-size: 17.5px; line-height: 1.36; color: #b7bfca; min-width: 0; }
.w { display: inline; border: 0; background: none; padding: 0 0 1px; margin: 0; font: inherit; font-weight: 700; color: var(--text);
  border-bottom: 2px dotted color-mix(in srgb, var(--c) 85%, transparent); cursor: pointer; }
.w.fxw { border-bottom-color: var(--fx); }
.w.warn { color: var(--warn); border-bottom-color: var(--warn); }
.w.open { background: color-mix(in srgb, var(--c) 22%, transparent); border-radius: 4px 4px 0 0; box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 22%, transparent); }
.say .sep { color: var(--faint); margin: 0 5px; font-weight: 700; }
.lv { display: grid; grid-template-columns: 1fr 58px; align-items: center; gap: 8px; }
.lv b { font-size: 13.5px; text-align: right; white-space: nowrap; }
.lv .hfader .hf-thumb { width: 20px; height: 20px; top: 2px; }
.chev { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); display: grid; place-items: center; color: var(--muted); }
.ln.empty { border-style: dashed; background: transparent; }
.ln.empty .lh { min-height: 44px; }

/* open line */
.ln.open { border: 1.5px solid var(--c); background: color-mix(in srgb, var(--c) 5%, #181b21); box-shadow: 0 8px 26px #0007; }
.ln.open .chev { color: var(--text); border-color: var(--c); }
.lb { display: grid; grid-template-columns: minmax(0, 1fr) 290px; column-gap: 0; margin: 0 12px; padding: 10px 0 10px; border-top: 1px solid var(--line); }
.lb .part { min-width: 0; padding: 0 22px; border-left: 1px solid var(--line); display: flex; flex-direction: column; }
.lb .part:first-child { padding-left: 4px; border-left: 0; }
.lb .ph { display: flex; align-items: baseline; gap: 10px; margin-bottom: 9px; }
.lb .ph .sub { font-size: 12px; color: var(--faint); }
.wsl { display: grid; grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr)); column-gap: 26px; }
.ws .wsh { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; white-space: nowrap; }
.ws .wsh b { font-size: 15px; } .ws .wsh .wv { font-size: 14px; font-weight: 700; } .ws .wsh .wv small { color: var(--muted); font-weight: 500; font-size: 12.5px; margin-left: 4px; }
.ws .wst { position: relative; height: 30px; }
.ws .wst .t { position: absolute; left: 0; right: 0; top: 11px; height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; }
.ws .wst .t em { position: absolute; top: 0; bottom: 0; background: var(--c); }
.ws .wst .mid { position: absolute; left: 50%; top: 6px; width: 2px; height: 18px; background: #5b6472; margin-left: -1px; }
.ws .wst .th { position: absolute; top: 3px; width: 24px; height: 24px; border-radius: 7px; margin-left: -12px; background: linear-gradient(#fbfcfd, #d5dae1); box-shadow: 0 1px 4px #0009; }
.ws .wse { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--faint); }
.rpick { position: relative; height: 32px; margin: 3px 6px 0; }
.rpick .mk { position: absolute; inset: 0; border-radius: 5px; overflow: hidden; opacity: .5; }
.rpick .mk .kbd, .rpick .mk .keys { height: 100%; } .rpick .mk .wk span { display: none; }
.rpick > em { position: absolute; top: -3px; bottom: -3px; border-radius: 5px; border: 2.5px solid var(--c); background: color-mix(in srgb, var(--c) 22%, transparent); }
.rpick > i { position: absolute; top: -6px; bottom: -6px; width: 12px; margin-left: -6px; border-radius: 4px; background: #eef1f5; box-shadow: 0 1px 5px #000b; }
.rbtns { display: flex; gap: 6px; margin-top: 10px; } .rbtns .btn { flex: 1; justify-content: center; font-size: 12.5px; padding: 0 6px; }
.rhint { font-size: 11.5px; color: var(--faint); margin-top: 5px; }
/* Advanced: the second and last level, inside the line */
.la { display: flex; align-items: center; gap: 10px; height: 38px; margin: 0 12px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); min-width: 0; }
.la .adv { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text); font-size: 14px; white-space: nowrap; border: 0; background: none; padding: 0; }
.la .sum { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.la .sum b { color: #cfd5dd; font-weight: 600; }
.la .ok { margin-left: auto; font-size: 12px; padding: 3px 9px; border-radius: 10px; background: #1f2a22; color: #8fe0b1; white-space: nowrap; font-weight: 700; }
.la .ok.chg { background: #2e2716; color: var(--accent); }
.advp { margin: 0 12px; padding: 12px 0 12px; border-top: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1.25fr 1.1fr; }
.advp .col { padding: 0 20px; border-left: 1px solid var(--line); min-width: 0; }
.advp .col:first-child { padding-left: 4px; border-left: 0; }
.advp .cap { display: block; margin-bottom: 6px; }
.arow { display: grid; grid-template-columns: 84px 1fr 60px; align-items: center; gap: 10px; min-height: 34px; font-size: 13.5px; }
.arow > span { font-weight: 650; color: #d5dae1; } .arow > b { text-align: right; font-size: 13px; }
.arow .hfader { height: 22px; } .arow .hf-thumb { width: 18px; height: 18px; top: 2px; } .arow .hf-track { top: 8px; }
.arow.w2 { grid-template-columns: 84px 1fr; }
.arow .seg { justify-self: start; } .arow .seg button { height: 28px; padding: 0 9px; font-size: 12.5px; }
.eng { font-size: 13px; color: var(--muted); line-height: 1.45; }
.eng b { color: var(--text); }

/* word popover: the same stacked steps as the Perform chip's panel */
.amt { --c: var(--slot-0); position: absolute; z-index: 20; width: 214px; border-radius: 11px; background: #1f242c;
  border: 2px solid var(--c); box-shadow: 0 18px 50px #000d; display: flex; flex-direction: column; padding: 10px 10px 9px; }
.amt::before { content: ''; position: absolute; top: -9px; left: var(--ax, 40px); width: 14px; height: 14px; background: #1f242c;
  border-left: 2px solid var(--c); border-top: 2px solid var(--c); transform: rotate(45deg); }
.amt .ah { display: flex; align-items: flex-start; gap: 6px; }
.amt .ah b { font-size: 15px; line-height: 1.15; } .amt .ah b span { color: var(--c); font-size: 11px; letter-spacing: .1em; display: block; }
.amt .ah .x { margin-left: auto; width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--line-2); background: var(--panel-2); display: grid; place-items: center; flex: none; }
.amt .to { font-size: 12px; color: var(--muted); margin: 2px 0 8px; } .amt .to em { font-style: normal; color: var(--fx); font-weight: 700; }
.amt .ab { display: grid; grid-template-columns: 1fr 26px; gap: 8px; height: 214px; }
.steps { display: flex; flex-direction: column; gap: 5px; }
.steps button { flex: 1; min-height: 34px; border-radius: 7px; border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 800; font-size: 15px;
  display: flex; align-items: center; justify-content: space-between; padding: 0 10px; }
.steps button small { font-size: 12.5px; font-weight: 600; color: var(--muted); }
.steps button.on { background: var(--c); color: #0d0f12; border-color: var(--c); } .steps button.on small { color: #0d0f12; font-weight: 700; }
.fine { position: relative; }
.fine .t { position: absolute; left: 10px; width: 6px; top: 4px; bottom: 4px; border-radius: 3px; background: var(--track); overflow: hidden; }
.fine .t em { position: absolute; left: 0; right: 0; bottom: 0; background: var(--c); }
.fine .th { position: absolute; left: 0; width: 26px; height: 16px; border-radius: 4px; background: linear-gradient(#fbfcfd, #d5dae1); box-shadow: 0 1px 4px #0009; }
.amt .af { font-size: 11.5px; color: var(--faint); margin-top: 8px; line-height: 1.35; border-top: 1px solid var(--line); padding-top: 7px; }
.amt .af b { color: var(--muted); }
.amt .af .mini { display: inline-flex; vertical-align: -3px; height: 18px; padding: 0 6px; align-items: center; border-radius: 4px; background: var(--c); color: #0d0f12; font-size: 10.5px; font-weight: 800; }

/* effects line body: the same one-tap chips as the Perform header */
.fxrows { display: flex; flex-direction: column; gap: 8px; }
.fxrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fxrow .lab { width: 64px; flex: none; display: flex; align-items: center; gap: 6px; color: var(--fx); }
.fxrow .lab span { font-size: 11px; font-weight: 800; letter-spacing: .1em; color: var(--muted); }
.fxc { height: 36px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 14px; white-space: nowrap; color: #d7dce3; }
.fxc.on { background: #3a4250; border: 2px solid #f1f4f8; color: #fff; }
.fxc.near { border: 1.5px dashed #8e99a8; }
.fxc.own { display: inline-flex; flex-direction: column; justify-content: center; line-height: 1.05; }
.fxc.own small { font-size: 10.5px; font-weight: 600; opacity: .85; }
.fxc.vb { height: 30px; border-radius: 15px; font-size: 13px; font-weight: 650; }
.fxnote { font-size: 12px; color: var(--faint); margin-top: 2px; padding-left: 70px; }
.who { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; color: #b7bfca; margin-top: 2px; }
.who span { display: inline-flex; align-items: center; gap: 6px; } .who i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
.who .w { font-size: 14px; }

/* keyboard row (unchanged from H) */
.kbrow { grid-column: 1 / 3; display: grid; grid-template-columns: 150px 1fr 120px 104px 112px; gap: 12px; padding: 9px 12px 10px; }
.kbrow .rbars { margin-bottom: 9px; }
.kleg { display: flex; flex-direction: column; justify-content: center; gap: 5px; font-size: 12px; font-weight: 700; }
.kleg div { display: flex; align-items: center; gap: 7px; } .kleg i { width: 18px; height: 5px; border-radius: 3px; background: var(--c); }
.kleg span { color: var(--faint); font-weight: 600; margin-left: auto; }
.kleg .dim { opacity: .45; }
.kmeter { display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.kmeter .cap { font-size: 10.5px; }
.kmeter div.m { height: 7px; border-radius: 4px; background: linear-gradient(90deg, #2bbf6a 0 62%, #e2c23c 62% 80%, #e4573d 80%) left/var(--l) 100% no-repeat, #262b33; }
.bigbtn { border-radius: var(--radius); border: 1px solid var(--line-2); background: var(--panel-2); font-weight: 700; font-size: 15px; display: flex; align-items: center; justify-content: center; gap: 8px; }
.bigbtn.fade { background: #182231; }
.bigbtn.panic { background: #d9363a; color: #fff; border: 0; font-size: 21px; letter-spacing: .06em; flex-direction: column; gap: 0; box-shadow: 0 0 20px #d9363a44; }
.bigbtn.panic small { font-size: 11px; letter-spacing: .04em; opacity: .75; font-weight: 700; }

/* instrument menu (from H: "Remove this sound…" sits at the very bottom) */
.imenu { position: absolute; z-index: 30; width: 330px; background: #1f242c; border: 1px solid #555e6c; border-radius: 12px; box-shadow: 0 20px 56px #000d; padding: 8px; }
.imenu .ig { font-size: 11px; font-weight: 800; letter-spacing: .1em; color: var(--faint); padding: 8px 10px 4px; display: flex; align-items: center; gap: 7px; }
.imenu .ii { display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 10px; border-radius: 7px; font-size: 14px; font-weight: 600; color: #dfe4ea; }
.imenu .ii small { margin-left: auto; color: var(--faint); font-size: 12px; font-weight: 500; }
.imenu .ii.on { background: color-mix(in srgb, var(--slot-0) 18%, var(--panel-2)); color: var(--text); }
.imenu .ii.more { color: var(--faint); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; line-height: 34px; }
.imenu hr { border: 0; border-top: 1px solid var(--line); margin: 8px 2px; }
.imenu .ii.danger { color: #ff9a9c; } .imenu .ii.danger small { color: #b77; }

@media (max-width: 1250px) {
  .edit { grid-template-columns: 1fr; grid-template-rows: 48px 1fr 66px; gap: 8px; padding: 8px 10px 10px; }
  .lib { display: none; }
  .shead { padding: 0 10px; gap: 8px; } .shead h1 { font-size: 19px; } .hchip { height: 32px; padding: 0 10px; font-size: 13px; } .shead .fac { display: none; }
  .shead .songsbtn { display: inline-flex !important; } .shead .livehint { display: none; }
  .sheet { padding: 7px 8px 7px; gap: 5px; }
  .shint { height: 16px; } .shint .h { font-size: 12px; } .shint .r { display: none; }
  .lh { grid-template-columns: 104px minmax(0, 1fr) 150px 30px; column-gap: 10px; min-height: 41px; padding: 3px 6px 3px 5px; }
  .ot { height: 32px; padding: 0 5px 0 8px; gap: 6px; } .ot .r { font-size: 11.5px; } .ot .st { font-size: 10.5px; padding: 1px 5px; } .ot i { width: 9px; height: 9px; }
  .say { font-size: 15px; line-height: 1.34; }
  .lv { grid-template-columns: 1fr 50px; gap: 6px; } .lv b { font-size: 12px; }
  .chev { width: 30px; height: 30px; }
  .ln.empty .lh { min-height: 38px; }
  .lb { grid-template-columns: minmax(0, 1fr) 236px; margin: 0 8px; padding: 8px 0 8px; }
  .lb .part { padding: 0 14px; } .lb .ph { margin-bottom: 4px; } .lb .ph .sub { display: none; }
  .wsl { column-gap: 16px; }
  .ws .wsh b { font-size: 13.5px; } .ws .wsh .wv { font-size: 12.5px; } .ws .wsh .wv small { display: none; }
  .ws .wst { height: 26px; } .ws .wst .t { top: 9px; height: 7px; } .ws .wst .th { width: 22px; height: 22px; top: 2px; } .ws .wst .mid { top: 4px; }
  .ws .wse { font-size: 10.5px; }
  .rpick { height: 26px; } .rbtns { margin-top: 8px; } .rbtns .btn { min-height: 28px; font-size: 12px; } .rhint { display: none; }
  .la { height: 34px; margin: 0 8px; font-size: 12px; } .la .adv { font-size: 13px; }
  .kbrow { grid-column: 1; grid-template-columns: 1fr 70px 84px 92px; padding: 5px 10px 7px; gap: 8px; } .kleg { display: none; } .kmeter .cap { display: none; }
  .fxc { height: 32px; padding: 0 8px; font-size: 13px; } .fxrow .lab { width: 54px; } .fxrow .lab span { font-size: 10px; } .fxnote { padding-left: 60px; }
  .advp { margin: 0 8px; grid-template-columns: 1fr 1fr; } .advp .col:last-child { grid-column: 1 / 3; border-left: 0; padding: 8px 4px 0; }
}
`;

// ----------------------------------------------------------------- data (matches H's Perform mockup exactly)
const W = (t, cls = '') => `<button class="w${cls ? ` ${cls}` : ''}">${t}</button>`;
const FXW = (t, cls = '') => W(t, `fxw${cls ? ` ${cls}` : ''}`);

const LINES = [
  { id: 'keys', cls: '', role: 'KEYS', lvl: 0.72, db: '−1.9 dB',
    say: (o) => `plays ${W('Grand Piano')} on ${W('every key')}, ${W('a little', o.word === 'space' ? 'open' : '')} into the ${FXW('Hall')}, ${W('a touch')} of echo, sustain ${W('on')}` },
  { id: 'pad', cls: 's1', role: 'PAD', lvl: 0.6, db: '−5.2 dB',
    say: () => `plays ${W('Warm Pad')}, ${W('swells with the wheel')}, ${W('half')} into the ${FXW('Hall')}, ${W('a touch')} of echo, ${W('some chorus')}` },
  { id: 'extra', cls: 's2', role: 'EXTRA', empty: true,
    say: () => `is empty. ${W('Choose a sound')} to layer on top, or ${W('split the keyboard')}.` },
  { id: 'bass', cls: 's3', role: 'BASS', lvl: 0.66, db: '−3.1 dB',
    say: () => `plays ${W('Sub Bass')} ${W('below middle C')}, ${W('an octave down')}, ${W('one note at a time')}, ${W('dry')}, sustain ${W('off', 'warn')}` },
  { id: 'drone', cls: 'dr', role: 'DRONE', lvl: 0.68, db: '+1.6 dB',
    say: () => `hums a ${W('synth')} ${W('D major')} chord, ${W('soft')} and ${W('gently moving')}, ${W('carries on')} into the next song` },
  { id: 'hands', cls: 'hd', role: 'HANDS', static: 'keyboard',
    say: () => `the ${W('mod wheel')} and ${W('pedal')} bring in the ${W('Pad')}, bend ${W('lifts the drone')}, Swell takes ${W('8 s')}` },
  { id: 'fx', cls: 'fx', role: 'EFFECTS', static: 'room',
    say: () => `Space: ${FXW('Hall')}<span class="sep">·</span>Echo: ${FXW('song’s own 420 ms')}<span class="sep">·</span>Chorus: ${FXW('gentle')}<span class="sep">·</span>Tape: ${FXW('off')}<span class="sep">·</span>Vibe: ${FXW('your own mix')}` },
];

function tile(l) {
  if (l.empty) return `<button class="ot empty" title="Add a sound">${icon('plus', 16)}<span class="r">${l.role}</span></button>`;
  if (l.static) return `<span class="ot static">${icon(l.static, 17)}<span class="r">${l.role}</span></span>`;
  return `<button class="ot" title="Tap to turn ${l.role} off (same as the Perform tile)"><i></i><span class="r">${l.role}</span><span class="st">ON</span></button>`;
}

function wordSlider(name, v, word, sub, ends, { bipolar = false } = {}) {
  const fill = bipolar
    ? (v >= 0.5 ? `left:50%;width:${(v - 0.5) * 100}%` : `left:${v * 100}%;width:${(0.5 - v) * 100}%`)
    : `left:0;width:${v * 100}%`;
  return `<div class="ws"><div class="wsh"><b>${name}</b><span class="wv">${word}<small>${sub}</small></span></div>
    <div class="wst"><div class="t"><em style="${fill}"></em></div>${bipolar ? '<i class="mid"></i>' : ''}<div class="th" style="left:${v * 100}%"></div></div>
    <div class="wse"><span>${ends[0]}</span><span>${ends[1]}</span></div></div>`;
}

function keysBody() {
  return `<div class="lb">
    <div class="part"><div class="ph"><span class="cap">Shape the piano</span><span class="sub">Words first, numbers beside them. Double-click a slider to reset it.</span></div>
      <div class="wsl">
        ${wordSlider('Brightness', 1, 'Bright', '100%', ['darker', 'brighter'])}
        ${wordSlider('Warmth', 0.5, 'Neutral', '0 dB', ['thinner', 'fuller'], { bipolar: true })}
        ${wordSlider('Ring-out', 0.3, 'Natural', '0.35 s', ['short', 'long'])}
      </div></div>
    <div class="part"><div class="ph"><span class="cap">Where it plays</span><span class="sub">every key</span></div>
      <div class="rpick"><div class="mk">${keyboard(36, 96, { showRanges: false, labels: false })}</div><em style="left:0;right:0"></em><i style="left:0"></i><i style="left:100%"></i></div>
      <div class="rbtns"><button class="btn sm">Set lowest…</button><button class="btn sm">Set highest…</button></div>
      <div class="rhint">Tap Set, then play the key on your keyboard.</div></div>
  </div>`;
}

function keysAdvanced(open) {
  if (!open) {
    return `<div class="la"><button class="adv">${icon('chevron', 16)}Advanced</button>
      <span class="sum"><b>Octave</b> normal · <b>Chorus</b> off · <b>Pan</b> Center · <b>Width</b> 100% · <b>Highs</b> 0 dB · <b>Transpose</b> 0 · <b>Voices</b> Chords · <b>Response</b> Normal · <b>Pitch bend</b> Off</span>
      <span class="ok">all at default</span></div>`;
  }
  const r = (label, v, val) => `<div class="arow"><span>${label}</span>${hfader(v, 'var(--c)')}<b>${val}</b></div>`;
  return `<div class="la"><button class="adv">${icon('down', 16)}Advanced</button><span class="sum">for Keys only. A setting you change here gets its own words in the sentence.</span><span class="ok">all at default</span></div>
    <div class="advp">
      <div class="col"><span class="cap">Mix</span>${r('Chorus', 0, 'off')}${r('Pan', 0.5, 'Center')}${r('Width', 0.667, '100%')}${r('Highs', 0.5, '0 dB')}</div>
      <div class="col"><span class="cap">Playing</span>
        <div class="arow w2"><span>Octave</span><div class="seg" style="--c:var(--slot-0)"><button>−2</button><button>−1</button><button class="on">Normal</button><button>+1</button><button>+2</button></div></div>
        <div class="arow w2"><span>Transpose</span><div class="seg"><button>−</button><button style="min-width:56px;cursor:default">0 st</button><button>+</button></div></div>
        <div class="arow w2"><span>Voices</span><div class="seg" style="--c:var(--slot-0)"><button class="on">Chords</button><button>Lowest note</button><button>Highest note</button></div></div>
        <div class="arow w2"><span>Response</span><div class="seg" style="--c:var(--slot-0)"><button>Soft</button><button class="on">Normal</button><button>Hard</button><button>Fixed</button></div></div>
        <div class="arow w2"><span>Pitch bend</span><span class="switch" style="justify-self:start"></span></div></div>
      <div class="col"><span class="cap">Grand Piano engine</span>
        <p class="eng" style="margin:0">This sampled piano has two settings, and both are already above: <b>Tone</b> is Brightness and <b>Release</b> is Ring-out.<br><br>
        Synths and organs list their extra settings here (a pad has about eight).</p></div>
    </div>`;
}

function fxBody() {
  return `<div class="lb" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)">
    <div class="part"><div class="ph"><span class="cap">Pick one</span><span class="sub">The same one-tap chips as the top of Perform</span></div>
      <div class="fxrows">
        <div class="fxrow"><div class="lab">${icon('room', 18)}<span>SPACE</span></div>
          <button class="fxc">Dry</button><button class="fxc">Room</button><button class="fxc">Stage</button><button class="fxc on">Hall</button><button class="fxc">Cathedral</button><button class="fxc">Ambient Wash</button></div>
        <div class="fxnote">Big hall. Pads bloom, piano gets lush; back the level off if it muddies.</div>
        <div class="fxrow"><div class="lab">${icon('echo', 18)}<span>ECHO</span></div>
          <button class="fxc">Off</button><button class="fxc">Slap</button><button class="fxc near" title="closest preset">¼</button><button class="fxc">Dotted ⅛</button><button class="fxc">Trails</button><button class="fxc own on">Song’s own<small>420 ms</small></button></div>
        <div class="fxrow"><div class="lab">${icon('sliders', 18)}<span>VIBE</span></div>
          <button class="fxc vb">Sunday</button><button class="fxc vb">Full Set</button><button class="fxc vb">Prayer</button><button class="fxc vb">Jam</button><button class="fxc vb">Lofi Tape</button><button class="fxc vb">Ambient</button></div>
      </div></div>
    <div class="part"><div class="ph"><span class="cap">Fine-tune</span><span class="sub">Moving one makes it “Custom ≈ Hall”</span></div>
      <div class="wsl" style="--n:2;row-gap:6px">
        ${wordSlider('Space size', 0.65, 'Large', '65%', ['small', 'huge'])}
        ${wordSlider('Space level', 0.575, 'A bit up', '+1.2 dB', ['quiet', 'loud'])}
        ${wordSlider('Echo repeats', 0.35, 'A few', '35%', ['one', 'many'])}
        ${wordSlider('Chorus', 0.3, 'Gentle', '30%', ['still', 'wobbly'])}
      </div>
      <div class="who" style="margin-top:8px">Who goes in:
        <span style="--c:var(--slot-0)"><i></i>Keys ${W('a little')}</span><span style="--c:var(--slot-1)"><i></i>Pad ${W('half')}</span><span style="--c:var(--slot-3)"><i></i>Bass ${W('dry')}</span></div>
    </div>
  </div>
  <div class="la"><button class="adv">${icon('chevron', 16)}Advanced</button>
    <span class="sum"><b>Space</b> darkness, pre-delay · <b>Echo</b> time, tone, ping-pong, sync · <b>Chorus</b> rate, level · <b>Tape</b> 6 settings · <b>Finish</b> EQ, glue, master</span>
    <span class="ok chg">changed from factory</span></div>`;
}

function line(l, { open = false, body = '', word = '' } = {}) {
  const lv = l.lvl != null
    ? `<div class="lv">${hfader(l.lvl, 'var(--c)')}<b>${l.db}</b></div>`
    : l.id === 'fx' ? `<div class="lv"><span class="muted" style="font-size:12.5px;text-align:right;grid-column:1/3">every sound shares these</span></div>` : '<span></span>';
  return `<div class="ln ${l.cls}${l.empty ? ' empty' : ''}${open ? ' open' : ''}" data-line="${l.id}">
    <div class="lh">${tile(l)}<div class="say">${l.say({ word })}</div>${lv}
      <button class="chev" title="${open ? 'Close' : 'Open'} this line">${icon(open ? 'down' : 'chevron', 17)}</button></div>
    ${open ? body : ''}
  </div>`;
}

function wordPopover() {
  // Anchored under "a little" in the KEYS line. Same stacked steps as the Perform Space chip, with the words shown.
  const steps = [[100, 'all the way'], [75, 'mostly'], [50, 'half'], [25, 'a little'], [0, 'dry']];
  return `<div class="amt" role="group" aria-label="KEYS Space amount" style="left:var(--px);top:var(--py);--ax:44px">
    <div class="ah"><b><span>KEYS</span>Space</b><button class="x" title="Close">${icon('close', 15)}</button></div>
    <div class="to">how much goes into the <em>Hall</em></div>
    <div class="ab"><div class="steps">${steps.map(([p, w]) => `<button class="${p === 25 ? 'on' : ''}">${p ? `${p}%` : 'Off'}<small>${w}</small></button>`).join('')}</div>
      <div class="fine" title="Drag for in-between values"><div class="t"><em style="height:25%"></em></div><div class="th" style="bottom:calc(25% - 8px)"></div></div></div>
    <div class="af">Same steps as the <span class="mini">Space 25%</span> chip<br>on your Perform strip. Tap one: done.</div>
  </div>`;
}

function library() {
  const songs = [['Sunday Pad + Piano', 'D'], ['Building Swell', 'G'], ['Prayer Wash', 'E'], ['Organ Swell', 'A'], ['Grand Piano', 'C'],
    ['Rhodes', 'F'], ['Felt Piano', 'Bb'], ['Lofi Rhodes', 'Eb'], ['Dusty Piano', 'C'], ['Glass Ocean', 'D']];
  return `<aside class="card lib">
    <span class="cap">Setlist</span>
    <div class="sel">Sunday 9am — Oct 5 ${icon('down', 16)}</div>
    <span class="rh">Tap a song to switch to it. It starts playing.</span>
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
  const dim = (id) => (['keys', 'pad', 'bass'].includes(sel) && sel !== id);
  return `<section class="card kbrow">
    <div class="kleg">
      <div class="${dim('keys') ? 'dim' : ''}" style="--c:var(--slot-0)"><i></i>Keys<span>all</span></div>
      <div class="${dim('pad') ? 'dim' : ''}" style="--c:var(--slot-1)"><i></i>Pad<span>all</span></div>
      <div class="${dim('bass') ? 'dim' : ''}" style="--c:var(--slot-3)"><i></i>Bass<span>to B3</span></div>
    </div>
    ${keyboard(36, 96, {
      held: [38, 62, 66, 69],
      ranges: [
        { low: 0, high: 127, color: 'var(--slot-0)', dim: dim('keys') },
        { low: 0, high: 127, color: 'var(--slot-1)', dim: dim('pad') },
        { low: 0, high: 59, color: 'var(--slot-3)', dim: dim('bass') },
      ],
    })}
    <div class="kmeter"><span class="cap">Output</span><div class="m" style="--l:60%"></div><div class="m" style="--l:56%"></div></div>
    <button class="bigbtn fade">Fade out</button>
    <button class="bigbtn panic">PANIC<small>⌘ .</small></button>
  </section>`;
}

/**
 * sel: which line is open ('keys' | 'fx' | ''); advanced: open Keys' Advanced; word: 'space' shows the word popover.
 */
export function editBody(sel = 'keys', { advanced = false, word = '' } = {}) {
  const lines = LINES.map((l) => {
    if (l.id !== sel) return line(l);
    const body = l.id === 'keys' ? keysBody() + keysAdvanced(advanced) : l.id === 'fx' ? fxBody() : '';
    return line(l, { open: true, body, word });
  }).join('');
  return `${topbar('edit')}
  <main class="edit">
    ${library()}
    ${header()}
    <section class="card sheet" aria-label="Song sheet">
      <div class="shint"><span class="h">One line per sound. Tap an <u>underlined word</u> to change it: they’re the same switches as your Perform strip.</span>
        <span class="r">Tap a line’s ›  to open it</span></div>
      ${lines}
      ${word === 'space' ? wordPopover() : ''}
    </section>
    ${kbRow(sel)}
  </main>`;
}
