import { icon } from './helpers.mjs';

export const QUICK_CSS = `
.qs { position: absolute; z-index: 30; top: 12px; right: 14px; bottom: 118px; width: 404px; display: flex; flex-direction: column;
  background: #1a1e25; border: 1px solid #4a5260; border-radius: 14px; box-shadow: -24px 0 60px #000b, 0 0 0 1px #000; overflow: hidden; }
.qs-h { display: flex; align-items: center; gap: 10px; padding: 12px 16px 10px; border-bottom: 1px solid var(--line); }
.qs-h h2 { margin: 0; font-size: 19px; } .qs-h p { margin: 1px 0 0; font-size: 12.5px; color: var(--muted); }
.qs-h .x { margin-left: auto; width: 36px; height: 36px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); display: grid; place-items: center; }
.qs-b { flex: 1; padding: 4px 16px 10px; display: flex; flex-direction: column; overflow: hidden; }
.qs-sec { padding: 11px 0 11px; border-bottom: 1px solid var(--line); }
.qs-sec:last-child { border-bottom: 0; }
.qs-st { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 9px; }
.qs-st .scope { font-size: 11.5px; color: var(--faint); font-weight: 600; }
.qs-row { display: flex; align-items: center; gap: 10px; min-height: 40px; }
.qs-row + .qs-row { margin-top: 8px; }
.qs-row.stack { flex-direction: column; align-items: stretch; gap: 6px; }
.qs-row.stack .lbl { display: flex; align-items: baseline; gap: 8px; } .qs-row.stack .lbl small { display: inline; }
.seg.full { display: flex; } .seg.full button { flex: 1; }
.pedalrow { display: flex; gap: 8px; } .pedalrow .tog { height: 34px; font-size: 13px; }
.qs-row .lbl { flex: 1; min-width: 0; } .qs-row .lbl b { display: block; font-size: 14.5px; } .qs-row .lbl small { display: block; font-size: 12px; color: var(--muted); line-height: 1.3; }
.qs-fx { display: grid; grid-template-columns: 58px 1fr; gap: 8px 10px; align-items: start; }
.qs-fx > span { font-size: 13px; font-weight: 700; padding-top: 7px; display: flex; align-items: center; gap: 5px; color: var(--text); }
.qs-fx > span .ic { color: var(--fx); }
.pchips { display: flex; flex-wrap: wrap; gap: 5px; }
.pchips button { height: 31px; padding: 0 10px; border-radius: 16px; border: 1px solid var(--line-2); background: var(--panel-2); font-size: 13px; font-weight: 650; }
.pchips button.on { background: var(--fx); color: #0e141a; border-color: var(--fx); }
.pchips button.near { border: 1px dashed var(--fx); color: var(--text); }
.pchips .custom { font-size: 11.5px; color: var(--muted); align-self: center; margin-left: 2px; }
.qs .seg button { height: 34px; padding: 0 11px; font-size: 13.5px; }
.pedal-led { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line-2); background: #11151a; font-size: 12.5px; font-weight: 800; letter-spacing: .06em; }
.pedal-led i { width: 11px; height: 11px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); }
.qs-f { padding: 10px 16px; border-top: 1px solid var(--line); display: flex; align-items: center; gap: 8px; background: #161a20; font-size: 12.5px; color: var(--muted); }
.qs-f .btn { margin-left: auto; }
.okline { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; }
@media (max-width: 1250px) {
  .qs { bottom: 96px; top: 10px; right: 12px; width: 396px; }
  .qs-h { padding: 8px 14px 7px; } .qs-h p { display: none; } .qs-h h2 { font-size: 17px; } .qs-h .x { width: 32px; height: 32px; }
  .qs-b { padding: 0 14px 4px; } .qs-sec { padding: 7px 0; } .qs-st { margin-bottom: 5px; }
  .pchips { gap: 4px; } .pchips button { height: 27px; padding: 0 8px; font-size: 12.5px; }
  .qs-fx { gap: 5px 8px; } .qs-fx > span { padding-top: 5px; }
  .qs-row { min-height: 32px; } .qs-row + .qs-row { margin-top: 5px; } .qs-row.stack { gap: 4px; }
  .qs-row .lbl small { display: none !important; } .qs-row .lbl b { font-size: 13.5px; }
  .qs .seg button { height: 30px; } .pedal-led, .pedalrow .tog { height: 30px; }
  .qs-row .switch { transform: scale(.85); }
  .qs-f { padding: 7px 14px; } .qs-f .lk { display: none; }
}
`;

export function quickDrawer() {
  return `<aside class="qs" aria-label="Quick settings">
    <div class="qs-h">${icon('sliders', 22)}<div><h2>Quick settings</h2><p>Changes apply now. Keep playing.</p></div>
      <button class="x" title="Close (Q)">${icon('close', 18)}</button></div>
    <div class="qs-b">
      <div class="qs-sec">
        <div class="qs-st"><span class="cap">This song</span><span class="scope">saved with “Sunday Pad + Piano”</span></div>
        <div class="qs-fx">
          <span>${icon('room', 16)}Space</span>
          <div class="pchips"><button>Dry</button><button>Room</button><button>Stage</button><button class="on">Hall</button><button>Cathedral</button><button>Ambient Wash</button></div>
          <span>${icon('echo', 16)}Echo</span>
          <div class="pchips"><button>No Echo</button><button>Slapback</button><button class="near">≈ Quarter Note</button><button>Dotted Eighth</button><button>Ambient Trails</button></div>
        </div>
      </div>
      <div class="qs-sec">
        <div class="qs-st"><span class="cap">Every song</span><span class="scope">this Mac</span></div>
        <div class="qs-row stack"><div class="lbl"><b>Touch</b><small>how hard you play for full volume</small></div>
          <div class="seg full"><button>Light</button><button class="on">Normal</button><button>Heavy</button><button>Fixed</button></div></div>
        <div class="qs-row stack"><div class="lbl"><b>Sustain pedal</b><small>press it: the light should come on</small></div>
          <div class="pedalrow"><span class="pedal-led"><i></i>PEDAL DOWN</span><span class="tog"><i></i>Reversed</span></div></div>
        <div class="qs-row"><div class="lbl"><b>Mono output</b><small>one speaker or a mono PA feed</small></div><span class="switch"></span></div>
        <div class="qs-row"><div class="lbl"><b>Keyboard picks songs</b><small>patch buttons 1, 2, 3… choose songs</small></div><span class="switch"></span></div>
      </div>
      <div class="qs-sec">
        <div class="qs-st"><span class="cap">If something’s wrong</span></div>
        <div class="qs-row"><div class="lbl"><div class="okline"><i class="led ok"></i>Sound OK · 12 ms</div></div>
          <button class="btn sm">${icon('restart', 16)}Restart audio</button></div>
      </div>
    </div>
    <div class="qs-f"><span class="lk" style="display:flex;align-items:center;gap:8px">${icon('lock', 15)}Read-only while Perform is locked</span><button class="btn sm">${icon('gear', 16)}All settings</button></div>
  </aside>`;
}
