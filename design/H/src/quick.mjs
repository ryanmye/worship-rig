import { icon } from './helpers.mjs';

// Quick settings = a sheet that drops from the Quick button over the song header + setlist rows ONLY.
// It never covers a strip, the drone block, the keyboard, or Revert / Fade out / PANIC / Lock, at any size.
export const QUICK_CSS = `
.qs { position: absolute; z-index: 30; top: 12px; left: 14px; right: 14px; height: 178px; display: flex; flex-direction: column;
  background: #1b1f26; border: 1px solid #555e6c; border-radius: 14px; box-shadow: 0 22px 60px #000c, 0 0 0 1px #000; }
.qs::before { content: ''; position: absolute; top: -8px; left: var(--qx, 356px); width: 14px; height: 14px; background: #1b1f26;
  border-left: 1px solid #555e6c; border-top: 1px solid #555e6c; transform: rotate(45deg); }
.qs-h { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--line); flex: none; }
.qs-h h2 { margin: 0; font-size: 17px; } .qs-h .sub { font-size: 13px; color: var(--muted); }
.qs-h .lk b { color: var(--muted); font-weight: 700; }
.qs-h .lk { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--faint); }
.qs-h .x { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); display: grid; place-items: center; }
.qs-b { flex: 1; display: grid; grid-template-columns: 1.15fr 1.15fr .8fr; min-height: 0; }
.qs-sec { padding: 10px 18px 12px; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.qs-sec:first-child { border-left: 0; }
.qs-st { display: flex; align-items: baseline; gap: 10px; }
.qs-st .scope { font-size: 12px; color: var(--faint); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qs-row { display: grid; grid-template-columns: 112px 1fr; align-items: center; gap: 10px; min-height: 42px; }
.qs-row > .lbl b { display: block; font-size: 14.5px; } .qs-row > .lbl small { display: block; font-size: 11.5px; color: var(--muted); line-height: 1.25; }
.tempo { display: flex; align-items: center; gap: 10px; }
.tempo .bpm { font-size: 26px; font-weight: 800; line-height: 1; min-width: 44px; } .tempo .bpm small { font-size: 12px; color: var(--muted); font-weight: 700; margin-left: 3px; }
.tapbig { height: 42px; min-width: 92px; border-radius: 9px; border: 1.5px solid var(--text); background: #2a3039; font-weight: 800; font-size: 15px; letter-spacing: .06em;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.tempo .hint { font-size: 12px; color: var(--muted); line-height: 1.3; }
.tempo .hint b { color: var(--fx); }
.stepper { display: inline-flex; align-items: center; border: 1px solid var(--line-2); border-radius: 8px; overflow: hidden; background: var(--panel-2); }
.stepper button { width: 40px; height: 38px; border: 0; background: transparent; font-size: 20px; font-weight: 700; }
.stepper b { min-width: 62px; text-align: center; font-size: 16px; border-left: 1px solid var(--line-2); border-right: 1px solid var(--line-2); line-height: 38px; }
.seg.full { display: flex; } .seg.full button { flex: 1; }
.qs .seg button { height: 38px; padding: 0 11px; font-size: 14px; }
.pedalrow { display: flex; gap: 8px; align-items: center; } .pedalrow .tog { height: 38px; font-size: 13.5px; }
.pedal-led { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line-2); background: #11151a; font-size: 13px; font-weight: 800; letter-spacing: .06em; }
.pedal-led i { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); }
.okline { display: flex; align-items: center; gap: 9px; font-size: 15px; font-weight: 700; min-height: 42px; }
.okline small { color: var(--muted); font-weight: 600; font-size: 13px; }
.holdlink { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); font-weight: 600; background: none; border: 0; padding: 0; }
.holdlink .ring { width: 22px; height: 22px; border-radius: 50%; border: 2px dashed #5b6472; display: grid; place-items: center; }
.qs .allbtn { margin-top: auto; align-self: flex-start; }
.okline.bad { color: var(--warn); }
.restartbig { height: 44px; border-radius: 9px; border: 0; background: var(--warn); color: #1d1400; font-weight: 800; font-size: 15px; display: inline-flex; align-items: center; gap: 8px; padding: 0 16px; align-self: flex-start; }
@media (max-width: 1250px) {
  .qs { top: 10px; left: 12px; right: 12px; height: 154px; }
  .qs-h { height: 36px; padding: 0 8px 0 12px; } .qs-h h2 { font-size: 15.5px; } .qs-h .sub { display: none; } .qs-h .x { width: 30px; height: 30px; }
  .qs-b { grid-template-columns: 1.1fr 1.15fr .9fr; }
  .qs-sec { padding: 7px 12px 8px; gap: 5px; }
  .qs-st .scope { display: none; } .qs-st { white-space: nowrap; }
  .qs-row { min-height: 34px !important; } .qs-sec { gap: 4px !important; }
  .qs-row { grid-template-columns: 64px 1fr; min-height: 38px; gap: 8px; } .qs-row > .lbl small { display: none; } .qs-row > .lbl b { font-size: 13.5px; }
  .tempo .bpm { font-size: 22px; } .tapbig { height: 38px; min-width: 70px; font-size: 14px; } .tempo .hint { display: none; }
  .stepper button { width: 32px; height: 32px; } .stepper b { line-height: 32px; min-width: 48px; font-size: 14px; }
  .tapbig { height: 34px !important; }
  .qs-row > .lbl b.sw { font-size: 0; } .qs-row > .lbl b.sw::after { content: 'Swell'; font-size: 13.5px; }
  .qs .seg button { height: 34px; padding: 0 7px; font-size: 13px; }
  .pedal-led, .pedalrow .tog { height: 34px; font-size: 12px; padding: 0 9px; }
  .okline { font-size: 13.5px; min-height: 30px; } .restartbig { height: 38px; font-size: 14px; }
  .qs-sec .qs-foot { display: none; } .qs-row > .lbl b.pl { font-size: 0; } .qs-row > .lbl b.pl::after { content: 'Pedal'; font-size: 13.5px; }
}
`;

/** problem=true renders the "sound stalled" state: Restart becomes a normal (single-click) primary button. */
export function quickSheet({ problem = false, qx = 356 } = {}) {
  const status = problem
    ? `<div class="okline bad"><i class="led warn"></i>Sound stalled <small>· no audio for 3 s</small></div>
       <button class="restartbig">${icon('restart', 18)}Restart audio</button>`
    : `<div class="okline"><i class="led ok"></i>Sound OK <small>· 12 ms</small></div>
       <button class="holdlink" title="Press and hold for 1 second">
         <span class="ring">${icon('restart', 12)}</span>Hold to restart audio</button>`;
  return `<aside class="qs" aria-label="Quick settings" style="--qx:${qx}px">
    <div class="qs-h">${icon('sliders', 20)}<h2>Quick settings</h2><span class="sub">Changes apply now. Keep playing.</span>
      <span class="lk">${icon('lock', 14)}When locked: <b>This song</b> stays live, <b>This Mac</b> is frozen</span>
      <button class="btn sm">${icon('gear', 15)}All settings</button>
      <button class="x" title="Close (Q)">${icon('close', 17)}</button></div>
    <div class="qs-b">
      <div class="qs-sec">
        <div class="qs-st"><span class="cap">This song</span><span class="scope">saved with “Sunday Pad + Piano” · Revert undoes</span></div>
        <div class="qs-row"><div class="lbl"><b>Tempo</b><small>echo follows it</small></div>
          <div class="tempo"><span class="bpm">72<small>BPM</small></span><button class="tapbig">${icon('tap', 16)}TAP</button>
            <span class="hint">Tap along 4×.<br>Echo is synced (<b>¼</b>), so it follows.</span></div></div>
        <div class="qs-row"><div class="lbl"><b class="sw">Swell time</b><small>length of ◢ Swell</small></div>
          <div><span class="stepper"><button>−</button><b>8 s</b><button>+</button></span></div></div>
      </div>
      <div class="qs-sec">
        <div class="qs-st"><span class="cap">This Mac</span><span class="scope">every song · soundcheck settings</span></div>
        <div class="qs-row"><div class="lbl"><b>Touch</b><small>how hard to play</small></div>
          <div class="seg full"><button>Light</button><button class="on">Normal</button><button>Heavy</button><button>Fixed</button></div></div>
        <div class="qs-row"><div class="lbl"><b class="pl">Sustain pedal</b><small>press it: light on?</small></div>
          <div class="pedalrow"><span class="pedal-led"><i></i>PEDAL DOWN</span><span class="tog"><i></i>Reversed</span></div></div>
      </div>
      <div class="qs-sec">
        <div class="qs-st"><span class="cap">If something’s wrong</span></div>
        ${status}
      </div>
    </div>
  </aside>`;
}
