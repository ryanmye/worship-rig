// Angle C, "Hardware panel": generates the static mockups (inline CSS, no JS, no external fonts).
// Run: node design/C/src/build.mjs  → design/C/{perform,quick-settings,edit,edit-fx}.html
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ CSS (tokens copied from app/styles.css)
const CSS = String.raw`
:root{
  --bg:#0b0d10;--panel:#15181d;--panel-2:#1c2027;--panel-3:#252a33;--line:#2d333d;--line-2:#3a414d;
  --text:#f1f4f8;--muted:#a3acb8;--faint:#8a93a0;--accent:#ffc94d;--accent-ink:#1a1400;
  --slot-0:#ff8a3d;--slot-1:#3ddc84;--slot-2:#4aa8ff;--slot-3:#b784ff;
  --danger:#ff4d4f;--ok:#3ddc84;--warn:#ffb020;--track:#3b424d;--thumb:#eef1f5;
  --panic-bg:#5a0d10;--panic-text:#ffc9ca;--rec-idle:#c4474a;--led-off:#565e6a;
  --chassis-hi:#1b1f25;--chassis-lo:#131619;--lcd:#080b0e;--lcd-line:#1e252d;
  --font:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  /* panel geometry: every section has a fixed column, identical in Perform and Edit */
  --pad:16px;--ctl:104px;--slot:152px;--drone:334px;
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:15px/1.3 var(--font);-webkit-font-smoothing:antialiased;
  display:flex;flex-direction:column;overflow:hidden;min-width:1024px;min-height:700px;position:relative}
button{font:inherit;color:inherit;cursor:pointer}
.c0{--c:var(--slot-0)}.c1{--c:var(--slot-1)}.c2{--c:var(--slot-2)}.c3{--c:var(--slot-3)}.ca{--c:var(--accent)}
.cn{--c:#dfe5ec}

/* ---------------------------------------------------------------- top bar (unchanged from the app) */
.topbar{height:56px;flex:none;display:flex;align-items:center;gap:14px;padding:0 var(--pad);border-bottom:1px solid var(--line);background:#0e1013}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:17px;white-space:nowrap}
.brand svg{flex:none}
.viewseg{display:flex;border:1px solid var(--line-2);border-radius:8px;overflow:hidden}
.viewseg span{padding:10px 16px;font-weight:700;background:var(--panel-2)}
.viewseg span.on{background:var(--accent);color:var(--accent-ink)}
.gear{width:44px;height:42px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel-2);display:grid;place-items:center}
.status{flex:1;display:flex;justify-content:center;gap:18px;font-size:13px;font-weight:700;white-space:nowrap}
.status span{display:flex;align-items:center;gap:6px;color:var(--muted)}
.status b{color:var(--text)}
.rec{display:flex;align-items:center;gap:8px;height:42px;padding:0 14px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel-2);font-weight:800}
.rec i{width:12px;height:12px;border-radius:50%;background:var(--rec-idle)}
.time{font:700 16px var(--mono);color:var(--muted)}
.meter{width:110px;display:grid;gap:3px}
.meter i{height:5px;border-radius:3px;background:linear-gradient(90deg,var(--ok) 0 55%,#e6c229 70%,var(--danger) 90%) 0/100% 100%;position:relative;overflow:hidden}
.meter i::after{content:'';position:absolute;inset:0 0 0 var(--m,50%);background:#262b33}
.master{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:800;letter-spacing:.1em;color:var(--muted);white-space:nowrap}
.hfader{width:92px;height:6px;border-radius:3px;background:var(--track);position:relative}
.hfader::before{content:'';position:absolute;inset:0 30% 0 0;border-radius:3px;background:#dfe5ec}
.hfader::after{content:'';position:absolute;left:62%;top:-10px;width:22px;height:26px;border-radius:5px;background:var(--thumb);box-shadow:0 1px 3px #000}
.master b{color:var(--text);font-size:14px;letter-spacing:0}

/* ---------------------------------------------------------------- shared hardware atoms */
.led{width:9px;height:9px;border-radius:50%;flex:none;background:var(--led-off);box-shadow:inset 0 1px 2px rgba(0,0,0,.7)}
.led.on{background:var(--c,var(--accent));box-shadow:0 0 7px var(--c,var(--accent)),inset 0 0 1px rgba(255,255,255,.8)}
.led.half{background:color-mix(in srgb,var(--c,var(--accent)) 38%,var(--led-off));box-shadow:none}
.led.red{--c:#ff4d4f}
.silk{font-size:11px;font-weight:800;letter-spacing:.14em;color:var(--faint);text-transform:uppercase;white-space:nowrap}
.lcd{background:var(--lcd);border:1px solid var(--lcd-line);border-radius:7px;box-shadow:inset 0 2px 8px rgba(0,0,0,.75)}
.hb{display:flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 10px;border-radius:6px;
  border:1px solid #3a414d;background:linear-gradient(#2a3039,#20252c);box-shadow:0 2px 0 #07080a,inset 0 1px 0 rgba(255,255,255,.07);
  font-size:12px;font-weight:800;letter-spacing:.08em;color:#dfe5ec;white-space:nowrap}
.hb.dim{color:var(--faint)}
.hb.lit{border-color:color-mix(in srgb,var(--c,var(--accent)) 60%,#3a414d);color:var(--text)}
.hb.fill{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);box-shadow:0 2px 0 #07080a,0 0 14px rgba(255,201,77,.25)}
.hb.big{min-height:44px;font-size:14px}

/* rotary knob: conic ring (value arc) + cap with pointer. --s/--e = arc start/end, --p = pointer angle */
.knob{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.dial{position:relative;width:var(--ks,44px);height:var(--ks,44px);flex:none}
.dial .ring{position:absolute;inset:0;border-radius:50%;
  background:conic-gradient(from 225deg,var(--track) 0 var(--s),var(--c) var(--s) var(--e),var(--track) var(--e) 270deg,transparent 270deg);
  -webkit-mask:radial-gradient(circle closest-side,transparent 74%,#000 76% 97%,transparent 100%);mask:radial-gradient(circle closest-side,transparent 74%,#000 76% 97%,transparent 100%)}
.dial .cap{position:absolute;inset:17%;border-radius:50%;background:radial-gradient(circle at 50% 28%,#444c58,#23272e 62%,#1a1d22);
  box-shadow:0 3px 5px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.12)}
.dial .cap::after{content:'';position:absolute;left:50%;top:9%;width:3px;height:34%;margin-left:-1.5px;border-radius:2px;background:#f1f4f8;
  transform-origin:50% 120.6%;transform:rotate(var(--p))}
.knob .kl{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--muted);white-space:nowrap}
.knob .kv{font:600 12px var(--font);color:var(--text);white-space:nowrap}
.knob.off .kv{color:var(--faint)}

/* vertical fader (same look as the app's Perform fader) */
.vf{position:relative;width:48px;flex:1;min-height:60px}
.vf .tr{position:absolute;left:50%;top:6px;bottom:6px;width:8px;margin-left:-4px;border-radius:4px;background:var(--track);box-shadow:inset 0 0 0 1px #4a515c}
.vf .fl{position:absolute;left:50%;bottom:6px;width:8px;margin-left:-4px;border-radius:4px;background:var(--c);height:calc(var(--v) * (100% - 12px))}
.vf .th{position:absolute;left:50%;margin-left:-20px;width:40px;height:26px;border-radius:5px;background:linear-gradient(#fbfcfd,#d9dee5);
  box-shadow:0 2px 5px rgba(0,0,0,.7);bottom:calc(var(--v) * (100% - 26px))}
.vf .th::after{content:'';position:absolute;left:8px;right:8px;top:12px;height:2px;background:#9aa3ae}
.vf .ticks{position:absolute;left:calc(50% + 9px);top:6px;bottom:6px;width:6px;
  background:repeating-linear-gradient(#3b424d 0 1px,transparent 1px 20%)}

/* ---------------------------------------------------------------- program row */
.prog{flex:none;display:flex;gap:12px;padding:12px var(--pad) 0}
.prog-lcd{flex:1;min-width:0;display:grid;grid-template-columns:1fr auto auto;grid-template-rows:auto 1fr;column-gap:26px;padding:10px 18px 12px}
.prog-meta{grid-column:1/-1;display:flex;gap:14px;align-items:center;font-size:11.5px;font-weight:800;letter-spacing:.12em;color:#7e8995}
.prog-meta .sp{flex:1}
.prog-meta .rv{font-size:11px;letter-spacing:.08em;color:#6c7682;border:1px solid #262d36;border-radius:5px;padding:2px 7px}
.prog-name{font-size:46px;font-weight:800;letter-spacing:-.01em;line-height:1.05;align-self:end;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f5f7fa}
.prog-key,.prog-chord{align-self:end;display:flex;flex-direction:column;align-items:flex-start}
.prog-key small,.prog-chord small{font-size:11px;font-weight:800;letter-spacing:.14em;color:#7e8995}
.prog-key b{font-size:46px;line-height:1;color:var(--accent);font-weight:800}
.prog-key em{font-style:normal;font-size:12px;color:var(--faint);font-weight:600}
.prog-chord b{font-size:34px;line-height:1.1;color:#9aa6b3;font-weight:700}
.xpose{flex:none;width:196px;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;background:linear-gradient(var(--chassis-hi),var(--chassis-lo));border:1px solid var(--line)}
.xpose .row{display:flex;align-items:center;gap:8px}
.xpose .hb{width:52px;min-height:48px;font-size:24px;letter-spacing:0}
.xpose .val{flex:1;text-align:center;font-size:30px;font-weight:800}
.notes{flex:none;width:372px;padding:10px 14px;border-radius:10px;background:linear-gradient(var(--chassis-hi),var(--chassis-lo));border:1px solid var(--line);overflow:hidden}
.notes p{margin:5px 0 0;font-size:14.5px;line-height:1.38;color:#d6dce4;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.notes-btn{display:none}

/* ---------------------------------------------------------------- program buttons (setlist strip) */
.progbtns{flex:none;display:flex;gap:8px;padding:10px var(--pad) 0;align-items:stretch}
.progbtns .nav{width:92px}
.chips{flex:1;display:flex;gap:6px;overflow:hidden;min-width:0;padding:4px;border-radius:10px;background:var(--chassis-lo);border:1px solid var(--line)}
.chip{display:flex;align-items:center;gap:8px;padding:0 12px;min-height:40px;border-radius:7px;background:linear-gradient(#262b33,#1e2229);border:1px solid #333a45;
  font-weight:700;font-size:15px;white-space:nowrap;flex:none}
.chip small{font-size:11px;color:var(--faint);font-weight:800}
.chip em{font-style:normal;font-size:12px;color:var(--faint);font-weight:700}
.chip.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.chip.on small,.chip.on em{color:#4a3a00}
.nextbtn{width:236px;flex:none;display:flex;flex-direction:column;justify-content:center;padding:0 14px;border-radius:10px;background:linear-gradient(#262b33,#1e2229);border:1px solid #3a414d}
.nextbtn small{font-size:11px;font-weight:800;letter-spacing:.12em;color:var(--faint)}
.nextbtn b{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---------------------------------------------------------------- the panel (chassis) */
.panelwrap{flex:1;min-height:0;display:flex;flex-direction:column;padding:10px var(--pad) 0;position:relative}
.panel{flex:1;min-height:0;display:grid;grid-template-columns:var(--ctl) repeat(4,var(--slot)) var(--drone) 1fr;grid-template-rows:minmax(0,1fr);
  border-radius:12px;border:1px solid #2a3038;background:linear-gradient(180deg,#1c2026 0,#16191e 45%,#121418 100%);
  box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 10px 30px rgba(0,0,0,.35);overflow:hidden;position:relative}
.sec{position:relative;display:flex;flex-direction:column;min-width:0;padding:0 10px 12px;border-left:1px solid #0d0f12;box-shadow:inset 1px 0 0 #242931}
.sec:first-child{border-left:0;box-shadow:none}
.sec::before{content:'';position:absolute;left:10px;right:10px;top:0;height:3px;border-radius:0 0 3px 3px;background:var(--c,#3a414d)}
.sec-h{display:flex;align-items:center;gap:7px;height:36px;flex:none;font-size:12px;font-weight:800;letter-spacing:.16em;color:var(--c,var(--muted));white-space:nowrap}
.sec-h .n{color:var(--faint);letter-spacing:0}
.sec-h .sp{flex:1}
.sec.empty{--c:#4b525d}
.sec.empty .sec-h{color:color-mix(in srgb,var(--cc) 55%,#4b525d)}
.sec.empty::before{background:color-mix(in srgb,var(--cc) 35%,#2a2f37)}

/* slot section */
.inst{flex:none;height:54px;display:flex;flex-direction:column;justify-content:center;padding:0 10px;margin-bottom:10px}
.inst b{font-size:16.5px;line-height:1.15;color:#f5f7fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.inst small{font-size:11px;font-weight:700;letter-spacing:.06em;color:color-mix(in srgb,var(--c) 70%,#8a93a0)}
.inst.none b{color:#5d6571;font-weight:600}
.knobs{flex:none;display:flex;justify-content:space-around;margin-bottom:6px}
.faderzone{flex:1;min-height:0;display:flex;justify-content:center;gap:6px;position:relative}
.faderzone .db{position:absolute;bottom:-2px;right:0;font-size:12px}
.lvl{flex:none;display:flex;justify-content:space-between;align-items:baseline;margin:6px 2px 8px}
.lvl b{font-size:18px;font-weight:800}
.lvl .play{display:flex;align-items:center;gap:5px;font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--faint)}
.btnrow{flex:none;display:grid;grid-template-columns:1fr 1fr;gap:6px}
.btnrow + .btnrow{margin-top:6px}
.oct{display:grid;grid-template-columns:30px 1fr 30px;align-items:center;gap:4px;grid-column:1/-1}
.oct .hb{padding:0;min-height:30px;font-size:15px;letter-spacing:0}
.ladder{display:flex;flex-direction:column;align-items:center;gap:3px}
.ladder .dots{display:flex;gap:5px}
.ladder .dots .led{width:7px;height:7px}
.ladder small{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--faint)}
.sec.empty .knob .ring{opacity:.35}
.sec.empty .vf,.sec.empty .btnrow,.sec.empty .lvl{opacity:.32}

/* control (wheel) section */
.wheel{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;gap:6px}
.wbar{flex:1;width:34px;border-radius:9px;background:#0b0d10;border:1px solid #2c323b;position:relative;overflow:hidden;box-shadow:inset 0 2px 6px #000}
.wbar i{position:absolute;left:3px;right:3px;bottom:3px;height:calc(var(--v)*(100% - 6px));border-radius:6px;background:linear-gradient(#c9d3de,#8d9aa8)}
.wval{font-size:20px;font-weight:800}
.wto{font-size:11px;color:var(--muted);text-align:center;line-height:1.2}
.ctl-leds{flex:none;display:grid;gap:7px;margin-top:10px}
.ctl-leds span{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:800;letter-spacing:.1em;color:var(--muted);white-space:nowrap}

/* drone section */
.drone-body{flex:1;min-height:0;display:grid;grid-template-columns:1fr 56px;gap:10px}
.drone-l{display:flex;flex-direction:column;gap:10px;min-width:0}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
.modes .hb{padding:0 4px}
.keygrid{display:grid;grid-template-columns:repeat(6,1fr);gap:5px}
.keygrid span{height:42px;display:grid;place-items:center;border-radius:6px;border:1px solid #333a45;background:linear-gradient(#262b33,#1e2229);font-weight:800;font-size:15px;box-shadow:0 2px 0 #07080a}
.keygrid span.on{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);box-shadow:0 2px 0 #07080a,0 0 12px rgba(255,201,77,.3)}
.mm{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.drone-knobs{display:flex;justify-content:space-around;margin-top:2px}
.drone-tog{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:auto}
.drone-tog .hb{font-size:10.5px;padding:0 6px;letter-spacing:.05em}
.drone-r{display:flex;flex-direction:column;align-items:center}
.drone-r .kl{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--muted);margin-bottom:4px}
.drone-r b{font-size:14px;margin-top:6px}
.exp{font-size:9px;font-weight:900;letter-spacing:.06em;color:var(--accent-ink);background:var(--accent);border-radius:3px;padding:1px 3px}

/* effects section */
.fx-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}
.vibe{flex:none;display:grid;grid-template-columns:34px 1fr 34px;gap:6px;align-items:stretch}
.vibe .lcd{display:flex;align-items:center;justify-content:space-between;padding:0 12px;height:40px}
.vibe .lcd small{font-size:10.5px;font-weight:800;letter-spacing:.14em;color:#7e8995}
.vibe .lcd b{font-size:16px}
.vibe .hb{padding:0;font-size:14px}
.fxmods{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.also{flex:none;display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:7px;background:#101317;border:1px solid #20262e;font-size:12.5px;font-weight:700;color:#c3cad3;white-space:nowrap;overflow:hidden}
.also span{display:flex;align-items:center;gap:6px}
.also .silk{font-size:10px}
.fxmod{display:flex;flex-direction:column;min-width:0}
.fxmod .sel{flex:1;display:flex;flex-direction:column;justify-content:space-around}
.fxmod .foot{margin-top:10px !important}
.fxmod .t{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.sel{list-style:none;margin:0;padding:6px 0;display:grid;gap:1px;border-radius:7px}
.sel li{display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:13.5px;font-weight:600;color:#aeb7c2;white-space:nowrap;border-radius:5px}
.sel li.on{color:var(--text);font-weight:800;background:#1b2026}
.fxmod .foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:8px}
.fed{display:flex;flex-direction:column;gap:4px}
.fed .bars{display:flex;gap:5px;align-items:flex-end;height:30px}
.fed .bars i{width:11px;border-radius:2px;background:var(--c);height:calc(3px + var(--v)*27px)}
.fed .bars i.z{background:#2b3038;height:3px}
.fed small{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--faint)}

/* ---------------------------------------------------------------- bottom: keyboard + stage buttons */
.bottom{flex:none;height:118px;display:flex;gap:10px;padding:10px var(--pad) 12px}
.kbd{flex:1;min-width:0;display:flex;flex-direction:column;padding:6px 10px 8px;border-radius:10px;background:linear-gradient(var(--chassis-hi),var(--chassis-lo));border:1px solid var(--line)}
.ranges{position:relative;height:20px;flex:none}
.ranges .rb{position:absolute;height:4px;border-radius:2px;background:var(--c);opacity:.9}
.ranges .rb small{position:absolute;top:-1px;font-size:9px;font-weight:900;letter-spacing:.1em;color:var(--c);transform:translateY(-100%)}
.keys{flex:1;position:relative;display:flex;gap:1px}
.keys .w{flex:1;background:linear-gradient(#b9c1cb,#a7b0bb);border-radius:0 0 4px 4px;position:relative}
.keys .w.h{background:linear-gradient(#ffd97a,#f3bf45)}
.keys .w small{position:absolute;bottom:3px;left:0;right:0;text-align:center;font-size:9px;font-weight:800;color:#39414b}
.keys .b{position:absolute;top:0;height:60%;background:linear-gradient(#1b1e23,#0b0c0e);border-radius:0 0 3px 3px;box-shadow:0 2px 2px rgba(0,0,0,.5)}
.keys .b.h{background:linear-gradient(#f3bf45,#b98a1a)}
.stage{flex:none;display:grid;grid-template-columns:repeat(4,auto);gap:8px}
.stage .hb{min-width:104px;height:100%;font-size:15px;flex-direction:column;gap:6px;letter-spacing:.06em}
.stage .panic{background:linear-gradient(#6a1014,#4a0a0d);border-color:#e0484c;color:var(--panic-text);font-size:19px;letter-spacing:.08em;min-width:118px}
.stage .fade{background:linear-gradient(#233246,#1a2533);border-color:#2f4560}

/* ---------------------------------------------------------------- drawer (Edit: section menu; Perform: System) */
.drawer{position:relative;flex:none;border:2px solid var(--c);border-radius:0 0 12px 12px;border-top-width:0;
  background:linear-gradient(#1f242b,#191d22);padding:12px 16px 14px;display:flex;gap:0;margin-top:-1px}
.drawer-h{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.drawer-h b{font-size:13px;font-weight:800;letter-spacing:.14em;color:var(--c);text-transform:uppercase}
.drawer-h span{font-size:13px;color:var(--muted)}
.group{padding:0 18px;border-left:1px solid #2b313a;display:flex;flex-direction:column;min-width:0}
.group:first-child{padding-left:0;border-left:0}
.group > .silk{margin-bottom:10px;display:flex;align-items:center;gap:8px}
.group .row{display:flex;gap:16px;align-items:flex-start}
.seg{display:flex;border:1px solid #3a414d;border-radius:7px;overflow:hidden;background:#1a1e24}
.seg span{padding:7px 11px;font-size:13px;font-weight:700;color:#c3cad3;border-left:1px solid #313741;white-space:nowrap}
.seg span:first-child{border-left:0}
.seg span.on{background:var(--c,var(--accent));color:#10130f}
.stepper{display:flex;align-items:center;gap:6px}
.stepper .hb{width:34px;padding:0;font-size:16px}
.stepper b{min-width:44px;text-align:center;font-size:16px}
.fieldlbl{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--muted);margin-bottom:5px;white-space:nowrap}
.hint{font-size:12px;color:var(--faint);line-height:1.35}
.picker{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 12px;height:44px;min-width:210px;border-radius:7px}
.picker b{font-size:16px}
.picker small{font-size:11px;color:var(--faint);font-weight:700;letter-spacing:.06em}
.picker i{font-style:normal;color:var(--muted)}
.close{margin-left:auto;display:flex;gap:8px;align-items:center}
`;

// ------------------------------------------------------------------ helpers
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** Rotary knob. v in 0..1 (or -1..1 when bipolar). */
function knob(label, value, v, { c = '', size = 44, bip = false, off = false } = {}) {
  let s, e, p;
  if (bip) { const m = 135, pos = 135 + clamp(v, -1, 1) * 135; s = Math.min(m, pos); e = Math.max(m, pos); p = pos - 135; }
  else { s = 0; e = clamp(v, 0, 1) * 270; p = e - 135; }
  if (e - s < 1.5) e = s + 1.5;
  return `<div class="knob ${c}${off ? ' off' : ''}" style="--ks:${size}px"><div class="dial" style="--s:${s}deg;--e:${e}deg;--p:${p}deg"><div class="ring"></div><div class="cap"></div></div>` +
    `<span class="kl">${label}</span><span class="kv">${value}</span></div>`;
}
const vf = (v, ticks = true) => `<div class="vf" style="--v:${v}"><div class="tr"></div>${ticks ? '<div class="ticks"></div>' : ''}<div class="fl"></div><div class="th"></div></div>`;
const led = (on, extra = '') => `<span class="led${on === true ? ' on' : on === 'half' ? ' half' : ''} ${extra}"></span>`;
const hb = (label, { on = false, ledOn = null, cls = '' } = {}) =>
  `<span class="hb ${on ? 'lit' : ''} ${cls}">${ledOn === null ? '' : led(ledOn)}${label}</span>`;

const LOGO = `<svg width="22" height="18" viewBox="0 0 22 18"><g fill="#4aa8ff"><rect x="1" y="9" width="3" height="9" rx="1"/><rect x="6" y="4" width="3" height="14" rx="1" fill="#ff8a3d"/><rect x="11" y="0" width="3" height="18" rx="1" fill="#3ddc84"/><rect x="16" y="6" width="3" height="12" rx="1" fill="#b784ff"/></g></svg>`;
const GEAR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dfe5ec" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`;

function topbar(view) {
  return `<header class="topbar">
  <div class="brand">${LOGO}Worship Rig</div>
  <div class="viewseg"><span class="${view === 'perform' ? 'on' : ''}">Perform</span><span class="${view === 'edit' ? 'on' : ''}">Edit</span></div>
  <div class="gear" title="All settings">${GEAR}</div>
  <div class="status">
    <span class="c1">${led(true)}MIDI <b>Keystation 61</b></span>
    <span class="c1">${led(true)}Sound <b>12 ms</b></span>
    <span class="c1">${led(true)}<b style="color:var(--ok)">READY</b></span>
  </div>
  <div class="rec"><i></i>REC</div><span class="time">00:00</span>
  <div class="meter"><i style="--m:58%"></i><i style="--m:61%"></i></div>
  <div class="master">MASTER <span class="hfader"></span><b>−6.0 dB</b></div>
</header>`;
}

// ------------------------------------------------------------------ song data
const SONG = { name: 'Sunday Pad + Piano', key: 'D' };
const SLOTS = [
  { role: 'KEYS', inst: 'Grand Piano', group: 'PIANO', gain: .74, db: '−1.9 dB', room: [.30, '30%'], echo: [.10, '10%'], chorus: 0, oct: 0, sus: true, play: true, range: [36, 96] },
  { role: 'PAD', inst: 'Warm Pad', group: 'SYNTH PAD', gain: .70, db: '−3.1 dB', room: [.55, '55%'], echo: [.20, '20%'], chorus: .45, oct: 0, sus: true, play: true, range: [36, 96], wheel: true },
  null,
  { role: 'BASS', inst: 'Sub Bass', group: 'BASS', gain: .66, db: '−4.4 dB', room: [0, '0%'], echo: [0, '0%'], chorus: 0, oct: -1, sus: false, play: true, range: [36, 59] },
];
const ROLES = ['KEYS', 'PAD', 'EXTRA', 'BASS'];
const HELD = new Set([50, 57, 62, 66, 69]); // D3 A3 D4 F#4 A4 (left hand D3 → bass + piano)

function slotSection(i, { edit = false, selected = false } = {}) {
  const s = SLOTS[i];
  if (!s) {
    return `<section class="sec c${i} empty" style="--cc:var(--slot-${i})">
    <div class="sec-h">${led(false)}<span class="n">${i + 1}</span>${ROLES[i]}</div>
    <div class="inst lcd none"><b>${edit ? '+ Choose…' : 'Empty'}</b><small>&nbsp;</small></div>
    <div class="knobs">${knob('SPACE', '—', 0, { size: 40, off: true })}${knob('ECHO', '—', 0, { size: 40, off: true })}</div>
    <div class="faderzone">${vf(0)}</div>
    <div class="lvl"><b style="color:var(--faint)">—</b><span class="play">${led(false)}PLAY</span></div>
    <div class="btnrow"><div class="oct"><span class="hb">−</span><div class="ladder"><div class="dots">${[0, 0, 1, 0, 0].map((x) => led(false)).join('')}</div><small>OCT</small></div><span class="hb">+</span></div></div>
    <div class="btnrow">${hb('SUS', { ledOn: false })}${hb('MUTE', { ledOn: false })}</div>
  </section>`;
  }
  const octDots = [-2, -1, 0, 1, 2].map((o) => led(o === s.oct ? true : false, o === 0 && s.oct !== 0 ? '' : '')).join('');
  return `<section class="sec c${i}${selected ? ' selected' : ''}">
    <div class="sec-h">${led(true)}<span class="n">${i + 1}</span>${s.role}<span class="sp"></span>${edit ? `<span class="menu-tab">${selected ? 'EDITING' : 'MORE ▾'}</span>` : ''}</div>
    <div class="inst lcd"><b>${s.inst}${edit ? ' <i class="caret">▾</i>' : ''}</b><small>${s.group}</small></div>
    <div class="knobs">${knob('SPACE', s.room[1], s.room[0], { size: 40 })}${knob('ECHO', s.echo[1], s.echo[0], { size: 40 })}</div>
    <div class="faderzone">${vf(s.gain)}</div>
    <div class="lvl"><b>${s.db}</b><span class="play">${led(s.play)}PLAY</span></div>
    <div class="btnrow"><div class="oct"><span class="hb">−</span><div class="ladder"><div class="dots">${octDots}</div><small>OCT ${s.oct > 0 ? '+' + s.oct : s.oct < 0 ? '−' + -s.oct : '0'}</small></div><span class="hb">+</span></div></div>
    <div class="btnrow">${hb('SUS', { ledOn: s.sus, on: s.sus })}${hb('MUTE', { ledOn: false })}</div>
  </section>`;
}

function controlSection() {
  return `<section class="sec cn">
    <div class="sec-h">CONTROL</div>
    <div class="wheel"><span class="silk" style="font-size:10px">MOD</span><div class="wbar" style="--v:.62"><i></i></div><span class="wval">62%</span><span class="wto">→ Pad level</span></div>
    <div class="ctl-leds">
      <span class="hb" style="min-height:40px;flex-direction:column;gap:2px;font-size:11px;padding:4px">◢<br>SWELL</span>
      <span>${led(true, 'ca')}PEDAL</span>
      <span>${led(false)}EXPR 100%</span>
      <span>${led(true, 'c1')}BEND→DRN</span>
    </div>
  </section>`;
}

function droneSection({ edit = false } = {}) {
  const keys = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  return `<section class="sec ca">
    <div class="sec-h">${led(true)}DRONE<span class="sp"></span><span style="color:var(--muted);letter-spacing:.04em;font-size:12.5px">D major · −6.0 dB</span>${edit ? '<span class="menu-tab">MORE ▾</span>' : ''}</div>
    <div class="drone-body">
      <div class="drone-l">
        <div class="modes">${hb('OFF', { ledOn: false })}${hb('SYNTH', { ledOn: true, on: true })}${hb('MY PADS', { ledOn: false })}</div>
        <div class="keygrid">${keys.map((k) => `<span class="${k === 'D' ? 'on' : ''}">${k}</span>`).join('')}</div>
        <div class="mm">${hb('MAJOR', { ledOn: true, on: true })}${hb('MINOR', { ledOn: false })}</div>
        <div class="drone-knobs">${knob('BRIGHT<span class="long">NESS</span>', '55%', .55, { size: 46 })}${knob('MOVE<span class="long">MENT</span>', '30%', .30, { size: 46 })}</div>
        <div class="drone-tog">${hb('FOLLOW<span class="long">&nbsp;CHORDS</span>', { ledOn: false })}${hb('KEEP<span class="long">&nbsp;ON NEXT</span>', { ledOn: true, on: true })}</div>
      </div>
      <div class="drone-r"><span class="kl">LEVEL</span>${vf(.62)}<b>−6.0</b></div>
    </div>
  </section>`;
}

function effectsSection({ edit = false } = {}) {
  const space = [['Dry', 0], ['Room', 0], ['Stage', 1], ['Hall', 0], ['Cathedral', 0], ['Ambient Wash', 0]];
  const echo = [['No Echo', 0], ['Slapback', 0], ['Quarter Note', 1], ['Dotted Eighth', 0], ['Ambient Trails', 0]];
  const sel = (arr) => `<ul class="sel lcd">${arr.map(([n, on]) => `<li class="${on ? 'on' : ''}">${led(on === 1 ? true : on === 'half' ? 'half' : false)}${n}</li>`).join('')}</ul>`;
  const fed = (vals) => `<div class="fed"><div class="bars">${vals.map((v, i) => v ? `<i class="c${i}" style="--v:${v}"></i>` : '<i class="z"></i>').join('')}</div><small>FED BY</small></div>`;
  return `<section class="sec cn">
    <div class="sec-h">EFFECTS<span class="sp"></span>${edit ? '<span class="menu-tab">MORE ▾</span>' : ''}</div>
    <div class="fx-body">
      <div class="vibe">${hb('◀')}<div class="lcd"><small>VIBE</small><b>Sunday</b></div>${hb('▶')}</div>
      <div class="fxmods">
        <div class="fxmod"><div class="t"><span class="silk" style="color:#cfd6de">SPACE</span></div>${sel(space)}
          <div class="foot">${fed([.30, .55, 0, 0])}${knob('LEVEL', '0.0 dB', .63, { size: 42, c: 'cn' })}</div></div>
        <div class="fxmod"><div class="t"><span class="silk" style="color:#cfd6de">ECHO</span></div>${sel(echo)}
          <div class="foot">${fed([.10, .20, 0, 0])}${knob('LEVEL', '−1.9 dB', .55, { size: 42, c: 'cn' })}</div></div>
      </div>
      <div class="also"><span class="silk">ALSO</span><span>${led(true)}Chorus</span><span>${led(false)}Lofi tape</span><span>${led(false)}Tone EQ</span><span>${led(false)}Glue</span></div>
    </div>
  </section>`;
}

// ------------------------------------------------------------------ keyboard (C2..C7 = MIDI 36..96)
const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);
function whiteIndex(n) { let w = 0; for (let k = 36; k < n; k++) if (!isBlack(k)) w++; return w; }
const WHITE_COUNT = 36;
/** left edge % and right edge % of a note on the keyboard */
function noteSpan(n) {
  const wi = whiteIndex(n); const W = 100 / WHITE_COUNT;
  if (!isBlack(n)) return [wi * W, (wi + 1) * W];
  return [wi * W - W * 0.3, wi * W + W * 0.3];
}
function keyboard({ held = HELD, ranges = SLOTS, sel = -1, labels = false } = {}) {
  let whites = '', blacks = '';
  for (let n = 36; n <= 96; n++) {
    const h = held.has(n) ? ' h' : '';
    if (!isBlack(n)) whites += `<div class="w${h}">${n % 12 === 0 ? `<small>C${n / 12 - 1}</small>` : ''}</div>`;
    else { const [l, r] = noteSpan(n); blacks += `<div class="b${h}" style="left:${l}%;width:${r - l}%"></div>`; }
  }
  const bars = ranges.map((s, i) => {
    if (!s) return '';
    const [lo, hi] = s.range; const l = noteSpan(lo)[0], r = noteSpan(hi)[1];
    const top = 2 + i * 5;
    const dim = sel >= 0 && sel !== i ? 'opacity:.35;' : '';
    const handles = sel === i ? `<span class="hd" style="left:0"></span><span class="hd" style="right:0"></span>` : '';
    return `<div class="rb c${i}" style="left:${l}%;width:${r - l}%;top:${top}px;${dim}">${handles}</div>`;
  }).join('');
  const lab = labels ? `<div class="rlabels">${ranges.map((s, i) => s ? `<span class="c${i}">${led(true)}${ROLES[i]} ${s.range[0] === 36 && s.range[1] === 96 ? 'whole keyboard' : 'C2–B3'}</span>` : '').join('')}</div>` : '';
  return `<div class="kbd">${lab}<div class="ranges">${bars}</div><div class="keys">${whites}${blacks}</div></div>`;
}

// ------------------------------------------------------------------ rows
function progRow({ edit = false } = {}) {
  if (edit) {
    return `<section class="prog edit">
    <div class="lcd prog-lcd">
      <div class="prog-meta"><span>SONG 1 OF 7 · SUNDAY 9AM</span><span class="sp"></span><span class="rv">RESET TO FACTORY</span></div>
      <div class="prog-name editable">Sunday Pad + Piano<span class="cursor"></span></div>
    </div>
    <div class="xpose2">
      <div class="fx2"><div class="fieldlbl">PLAY IN</div><span class="picker lcd sm"><b>D</b><i>▾</i></span></div>
      <div class="fx2"><div class="fieldlbl">HEAR IN</div><span class="picker lcd sm"><b>D</b><i>▾</i></span></div>
      <div class="fx2"><div class="fieldlbl">OCTAVE</div><div class="seg ca"><span>−1</span><span class="on">0</span><span>+1</span></div></div>
      <div class="fx2"><div class="fieldlbl">&nbsp;</div>${hb('MINOR', { ledOn: false })}</div>
      <div class="fx2"><div class="fieldlbl">TEMPO</div><div class="stepper"><span class="picker lcd sm" style="min-width:92px"><b>72</b><i>bpm</i></span><span class="hb" style="width:auto;padding:0 12px;min-height:36px">TAP</span></div></div>
    </div>
    <div class="notes editing"><div class="silk">NOTES <span style="letter-spacing:.04em;text-transform:none;font-weight:600">· shown in Perform</span></div>
      <p>The everyday worship sound: grand piano on top of a warm pad, soft key drone underneath. Mod wheel brings the pad in and out, so start with piano alone and swell the pad for the chorus.</p></div>
  </section>`;
  }
  return `<section class="prog">
    <div class="lcd prog-lcd">
      <div class="prog-meta"><span>SUNDAY 9AM · SONG 1 OF 7</span><span class="sp"></span><span class="rv">↺ REVERT SONG</span></div>
      <div class="prog-name">${SONG.name}</div>
      <div class="prog-key"><small>KEY</small><b>${SONG.key}</b></div>
      <div class="prog-chord"><small>CHORD</small><b>D</b></div>
    </div>
    <div class="xpose"><span class="silk">TRANSPOSE</span><div class="row">${hb('−')}<span class="val">0</span>${hb('+')}</div></div>
    <div class="notes"><span class="silk">NOTES</span>
      <p>The everyday worship sound: grand piano on top of a warm pad, soft key drone underneath. Mod wheel brings the pad in and out, so start with piano alone and swell the pad for the chorus. Push the bend wheel up to lift the drone.</p></div>
    <span class="hb notes-btn">NOTES ${led(true)}</span>
  </section>`;
}

const SETLIST = [['Sunday Pad + Piano', 'D'], ['Build My Life', 'E'], ['Goodness of God', 'A'], ['Way Maker', 'B'], ['What a Beautiful Name', 'D'], ['Graves Into Gardens', 'B'], ['King of Kings', 'D']];
function progButtons({ edit = false } = {}) {
  if (edit) {
    return `<nav class="progbtns e">
    <span class="picker lcd" style="min-width:200px;height:auto"><span><small>SETLIST</small><br><b style="font-size:15px">Sunday 9am — Oct 5</b></span><i>▾</i></span>
    <div class="chips edit-chips">${SETLIST.map(([n, k], i) => `<span class="chip${i === 0 ? ' on' : ''}"><em class="grip">⠿</em><small>${i + 1}</small>${n}<em>${k}</em>${i === 0 ? '<em class="act">⧉</em><em class="act">✕</em>' : ''}</span>`).join('')}</div>
    <span class="hb big" style="min-width:118px">+ ADD SONG</span>
    <span class="hb big dim" style="min-width:100px">LIBRARY ▾</span>
  </nav>`;
  }
  return `<nav class="progbtns">
    <span class="hb big nav dim">◀ PREV</span>
    <div class="chips">${SETLIST.map(([n, k], i) => `<span class="chip${i === 0 ? ' on' : ''}"><small>${i + 1}</small>${n}<em>${k}</em></span>`).join('')}</div>
    <div class="nextbtn"><small>NEXT ▶</small><b>Build My Life · E</b></div>
  </nav>`;
}

function stageButtons({ sys = false } = {}) {
  return `<div class="stage">
    <span class="hb ${sys ? 'lit fill' : ''}" style="${sys ? '' : ''}">${led(sys)}SYSTEM</span>
    <span class="hb fade">FADE OUT</span>
    <span class="hb panic">PANIC</span>
    <span class="hb">${led(false)}LOCK</span>
  </div>`;
}

function page(title, body, extraCss = '', cls = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CSS}${extraCss}</style></head>
<body class="${cls}">
${body}
</body></html>
`;
}

// ------------------------------------------------------------------ PERFORM
const PERFORM_CSS = String.raw`
@media (max-width:1300px),(max-height:780px){
  :root{--pad:12px;--ctl:76px;--slot:116px;--drone:238px}
  .topbar{height:50px;gap:10px}.topbar .brand{font-size:0;gap:0}.status{gap:12px;font-size:12px}.meter{width:70px}.hfader{width:60px}
  .master{font-size:0;gap:6px}.master b{font-size:13px}.rec{padding:0 10px;height:38px}.time{font-size:14px}
  .prog{padding-top:8px;gap:8px}.prog-lcd{padding:6px 12px 8px;column-gap:16px}.prog-name{font-size:34px}.prog-key b{font-size:36px}.prog-chord b{font-size:26px}
  .notes{display:none}.notes-btn{display:flex;align-self:stretch;width:92px;flex-direction:column}
  .xpose{width:164px;padding:6px 10px;gap:4px}.xpose .hb{min-height:40px;width:46px}.xpose .val{font-size:24px}
  .progbtns{padding-top:8px}.progbtns .nav{width:72px;font-size:12px}.chip{min-height:34px;font-size:13.5px;padding:0 9px}.nextbtn{width:190px}.nextbtn b{font-size:14px}
  .panelwrap{padding-top:8px}
  .sec{padding:0 7px 8px}.sec-h{height:30px;font-size:11px;gap:5px;letter-spacing:.12em}
  .inst{height:42px;margin-bottom:6px;padding:0 8px}.inst b{font-size:14px}.inst small{font-size:10px}
  .knob .kl{font-size:9.5px}.knob .kv{font-size:11px}.knobs .dial{--ks:34px !important;width:34px;height:34px}
  .lvl{margin:4px 0 6px}.lvl b{font-size:14px}.lvl .play{font-size:9px}
  .hb{min-height:30px;font-size:11px;padding:0 6px}.oct{grid-template-columns:26px 1fr 26px}.oct .hb{min-height:26px}
  .btnrow + .btnrow{margin-top:5px}
  .wbar{width:26px}.wval{font-size:15px}.wto{font-size:10px}.ctl-leds span{font-size:9px;gap:4px}.ctl-leds{gap:5px}
  .drone-body{grid-template-columns:1fr 44px;gap:6px}.drone-l{gap:5px}.keygrid{gap:3px}.keygrid span{height:28px;font-size:12.5px}
  .modes .hb,.mm .hb{font-size:10.5px}.drone-knobs .dial{width:32px;height:32px}.drone-tog .hb{font-size:10px;padding:0 3px}.long{display:none}
  .btnrow{gap:4px}.btnrow .hb{padding:0 2px;gap:4px;letter-spacing:.02em;font-size:10.5px}.btnrow .led{width:7px;height:7px}
  .also{display:none}.keygrid span{height:30px}.drone-l{gap:6px}
  .ctl-leds span{font-size:8.5px;letter-spacing:.04em}.ctl-leds .hb{font-size:9.5px !important}
  .fxmod .t{margin-bottom:3px}
  .oct{grid-template-columns:24px 1fr 24px;gap:2px}.ladder .dots{gap:3px}.ladder .dots .led{width:6px;height:6px}.ladder small{font-size:9px}
  .modes .led{display:none}.modes .hb{padding:0 2px;font-size:10px;letter-spacing:.03em}
  .inst{padding:0 6px}.inst b{font-size:13.5px}
  .drone-r .kl{font-size:9.5px}.vf{width:40px}.vf .th{width:34px;margin-left:-17px;height:22px}.vf .th::after{top:10px}
  .sec-h span[style]{display:none}
  .vibe .lcd{height:32px;padding:0 8px}.vibe .lcd b{font-size:13.5px}.vibe{grid-template-columns:28px 1fr 28px}
  .fxmods{gap:6px}.sel{padding:3px 0}.sel li{font-size:11px;padding:2.5px 5px;gap:4px;letter-spacing:-.01em}.sel .led{width:7px;height:7px}
  .fxmod .foot .dial{width:34px;height:34px}.fed .bars i{width:6px}.fed small{font-size:8.5px}.fed .bars{height:16px}.fed .bars i{height:calc(3px + var(--v)*13px)}
  .bottom{height:84px;padding:8px var(--pad) 10px;gap:8px}.ranges{height:14px}.keys .w small{font-size:8px}
  .stage{gap:6px}.stage .hb{min-width:76px;font-size:12px}.stage .panic{min-width:88px;font-size:16px}
}
`;

function performBody({ sys = false } = {}) {
  return `${topbar('perform')}
${progRow()}
${progButtons()}
<div class="panelwrap">
  <main class="panel">
    ${controlSection()}
    ${[0, 1, 2, 3].map((i) => slotSection(i)).join('\n')}
    ${droneSection()}
    ${effectsSection()}
  </main>
</div>
<footer class="bottom">${keyboard({ labels: false })}${stageButtons({ sys })}</footer>`;
}

// ------------------------------------------------------------------ QUICK SETTINGS (System drawer over Perform)
const QUICK_CSS = String.raw`
.scrim{position:absolute;inset:0;background:rgba(5,6,8,.55)}
.sysdrawer{position:absolute;left:var(--pad);right:var(--pad);bottom:128px;z-index:5;border:2px solid var(--accent);border-radius:14px;
  background:linear-gradient(#20252c,#191c21);box-shadow:0 -10px 50px rgba(0,0,0,.7);padding:14px 18px 16px}
.sysdrawer{--sysx:402px}
.sysdrawer::after{content:'';position:absolute;bottom:-11px;right:calc(var(--sysx) - 10px);width:18px;height:18px;background:#191c21;border-right:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(45deg)}
.sysdrawer .drawer-h{--c:var(--accent);margin-bottom:14px}
.sysgrid{display:grid;grid-template-columns:1.05fr 1.35fr 1.3fr 1.2fr 0.9fr}
.sysgrid .group{gap:10px}
.biglamp{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:9px}
.biglamp .led{width:18px;height:18px}
.biglamp b{font-size:18px}
.biglamp small{display:block;font-size:11px;color:var(--faint);font-weight:700;letter-spacing:.08em}
.sysgrid .hb{min-height:40px;font-size:12px;letter-spacing:.05em;justify-content:flex-start;padding:0 12px}
.sysgrid .sel li{font-size:15px;padding:7px 12px}
.readout{display:flex;align-items:baseline;gap:8px}
.readout b{font-size:22px}
.scope{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);font-weight:600}
.scope .tag{font-size:10.5px;font-weight:900;letter-spacing:.1em;color:var(--accent-ink);background:var(--accent);border-radius:4px;padding:2px 6px}
.stage .hb.fill{color:var(--accent-ink)}
.stage{position:relative;z-index:6}
@media (max-width:1300px),(max-height:780px){
  .sysdrawer{--sysx:288px;bottom:94px;padding:10px 14px 12px}
  .sysgrid{grid-template-columns:.9fr 1.3fr 1.3fr 1.4fr}.sysgrid .group:last-child{display:none}
  .sysgrid .group{padding:0 12px}.sysgrid .group:first-child{padding-left:0}
  .sysgrid .hb{font-size:10.5px;padding:0 8px;letter-spacing:.04em;min-height:36px}
  .sysgrid .sel li{font-size:13.5px;padding:5px 10px}.biglamp b{font-size:16px}
  .readout b{font-size:18px}.readout .hint{display:none}.sysdrawer .drawer-h{margin-bottom:10px}
  .sysdrawer .scope{font-size:11.5px}
}
.stage .hb.fill .led{--c:#1a1400;background:#1a1400;box-shadow:none}
`;
function quickBody() {
  const body = performBody({ sys: true });
  const drawer = `<div class="scrim"></div>
<section class="sysdrawer">
  <div class="drawer-h"><b>System</b><span class="scope"><span class="tag">ALL SONGS</span>These are rig settings, not part of the song. Perform Lock freezes them.</span>
    <span class="close"><span class="hb dim">ALL SETTINGS…</span><span class="hb">CLOSE ✕</span></span></div>
  <div class="sysgrid">
    <div class="group"><div class="silk">TOUCH</div>
      <ul class="sel lcd">${[['Light', 0], ['Normal', 1], ['Heavy', 0], ['Fixed', 0]].map(([n, on]) => `<li class="${on ? 'on' : ''}">${led(!!on)}${n}</li>`).join('')}</ul>
      <div class="hint">How hard you play for full volume.</div></div>
    <div class="group"><div class="silk">SUSTAIN PEDAL</div>
      <div class="biglamp lcd ca">${led(true)}<span><small>RIGHT NOW</small><b>Pedal down</b></span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${hb('REVERSED', { ledOn: false })}${hb('TEST PEDAL')}</div>
      <div class="hint">Notes hold with your foot off? Turn on Reversed.</div></div>
    <div class="group"><div class="silk">SOUND OUT</div>
      <div class="readout">${led(true, 'c1')}<b>12 ms</b><span class="hint">Lowest delay · Built-in output</span></div>
      <div style="display:grid;grid-template-columns:1fr 1.3fr;gap:8px">${hb('MONO', { ledOn: false })}<span class="hb" style="justify-content:center">↻ RESTART AUDIO</span></div>
      <div class="hint">Mono for one speaker or a mono PA feed. Restart if the sound stops.</div></div>
    <div class="group"><div class="silk">KEYBOARD</div>
      <div class="readout">${led(true, 'c1')}<b style="font-size:17px">Keystation 61</b></div>
      ${hb('KEYBOARD PICKS SONGS', { ledOn: false })}
      ${hb('COMPUTER KEYS PLAY NOTES', { ledOn: true, on: true })}
      </div>
    <div class="group"><div class="silk">IF IT GOES WRONG</div>
      <div class="hint" style="font-size:13px;line-height:1.45;color:#c3cad3">Stuck notes → <b style="color:var(--text)">PANIC</b> (Esc).<br>No sound → <b style="color:var(--text)">Restart audio</b>.<br>Wrong key → <b style="color:var(--text)">Transpose</b> above.</div></div>
  </div>
</section>`;
  return body.replace('<footer class="bottom">', drawer + '\n<footer class="bottom">');
}

// ------------------------------------------------------------------ EDIT
const EDIT_CSS = String.raw`
.panel{border-radius:12px 12px 0 0;border-bottom:0}
.panel > .sec:first-child .sec-h{letter-spacing:.05em;font-size:11px}
.panel .also{display:none}
.panel .drone-knobs .dial{width:40px;height:40px}
.panel .drone-l{gap:7px}
.menu-tab{font-size:9.5px;font-weight:900;letter-spacing:.1em;color:var(--muted);border:1px solid #3a414d;border-radius:4px;padding:3px 5px;background:#1d2127}
.sec.selected{background:linear-gradient(#262c34,#1f242b);box-shadow:inset 2px 0 0 var(--c),inset -2px 0 0 var(--c),inset 0 2px 0 var(--c)}
.sec.selected .menu-tab{background:var(--c);border-color:var(--c);color:#1a0d00}
.sec.selected::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:3px;background:#1f242b;box-shadow:inset 2px 0 0 var(--c),inset -2px 0 0 var(--c);z-index:3}
.caret{font-style:normal;color:var(--muted);font-size:13px}
.inst{border-style:dashed;border-color:#343c47}
.sec.selected .inst{border-color:color-mix(in srgb,var(--c) 70%,#000);border-style:solid}
.drawer{--c:var(--slot-0);margin-top:0;border-top:2px solid var(--c);border-radius:0 0 12px 12px;padding:14px 18px 16px;flex-direction:column}
.drawer::before{content:'';position:absolute;top:-2px;left:calc(var(--ctl) - 2px + 2px);width:calc(var(--slot) - 0px);height:2px;background:#1f242b;z-index:2}
.drawer .groups{display:flex}
.drawer .group.sound{flex:none;width:350px}.drawer .group.shape{flex:none;width:332px}.drawer .group.play{flex:1}.drawer .group.range{flex:none;width:250px}
.drawer .drawer-h{margin-bottom:6px}.drawer .group > .silk{margin-bottom:6px}.drawer{padding:10px 18px 12px}
.prog.edit{padding-top:10px}.prog.edit .prog-lcd{padding:7px 16px 8px}.prog.edit .prog-name{font-size:32px}.cursor{height:30px}
.prog.edit .xpose2{padding:6px 12px 8px}.prog.edit .notes{padding:6px 12px}.prog.edit .notes p{-webkit-line-clamp:3;font-size:13px;margin-top:2px}
.edit-chips .chip{min-height:36px}.progbtns.e{padding-top:8px}.progbtns.e .hb.big{min-height:40px}
.panelwrap{padding-top:8px}
.panel .inst b{font-size:15px}.panel .sel li{padding:2px 10px}.panel .vibe .lcd{height:34px}.panel .fx-body{gap:7px}
.bottom.edit{height:94px;padding-top:8px;padding-bottom:10px}.bottom.edit .ranges{height:16px}.kbd .rlabels{height:13px}
.drawer .group.range{width:270px}.drawer .group.range .stepper b{min-width:34px}.drawer .group.range .stepper .hb{width:30px}.drawer .group.range .rangebox{padding:5px 12px}.drawer .seg span{padding:7px 9px}
.prog.edit .prog-lcd{grid-template-columns:1fr;padding:10px 18px}
.prog.edit .xpose2,.prog.edit .notes{padding-top:8px;padding-bottom:10px}
.panel .sec-h{height:30px}.panel .knobs .dial{width:36px;height:36px}
.panel .knob .kv{font-size:11.5px}
.inst b{position:relative;padding-right:14px}.inst b .caret{position:absolute;right:0;top:0}
.sec.empty .inst b{padding-right:0}
.prog.edit .prog-lcd{grid-template-rows:auto 1fr}
.prog-name.editable{border-bottom:2px dashed #3a4350;padding-bottom:2px;font-size:38px;align-self:end;justify-self:start;padding-right:10px}
.cursor{display:inline-block;width:3px;height:36px;background:var(--accent);margin-left:4px;vertical-align:-4px}
.xpose2{flex:none;display:flex;gap:12px;align-items:flex-end;padding:10px 14px 12px;border-radius:10px;background:linear-gradient(var(--chassis-hi),var(--chassis-lo));border:1px solid var(--line)}
.picker.sm{min-width:62px;height:36px;padding:0 10px}
.picker.sm b{font-size:16px}
.xpose2 .seg span{padding:8px 11px}
.xpose2 .hb{min-height:36px}
.notes.editing{width:330px;border-style:dashed;border-color:#3a4350}
.notes.editing p{-webkit-line-clamp:3;font-size:13.5px}
.chip .grip{color:#6c7682;font-size:14px}
.chip.on .grip{color:#6b5510}
.chip .act{border-left:1px solid rgba(0,0,0,.2);padding-left:7px;color:#4a3a00;font-size:13px}
.progbtns .picker{padding:6px 12px}
.bottom.edit{height:104px}
.kbd .rlabels{display:flex;gap:16px;height:16px;align-items:center}
.kbd .rlabels span{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:800;letter-spacing:.1em;color:var(--c)}
.kbd .rlabels .led{width:7px;height:7px}
.ranges{height:18px}
.rb .hd{position:absolute;top:-5px;width:6px;height:14px;border-radius:3px;background:#fff;box-shadow:0 0 0 2px var(--c)}
.rangebox{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px}
.rangebox .bar{flex:1;height:8px;border-radius:4px;background:var(--c)}
.rangebox b{font-size:15px}
.editfoot{flex:none;display:flex;flex-direction:column;justify-content:center;gap:8px;width:210px}
.editfoot .hint{font-size:11.5px}
/* edit: shorter panel so the drawer fits; same columns */
.panel .vf{min-height:40px}
.panel .inst{height:48px;margin-bottom:6px}
.panel .knobs{margin-bottom:2px}
.panel .keygrid span{height:32px}
.panel .lvl{margin:4px 2px 6px}
.panel .hb{min-height:30px}
.panel .oct .hb{min-height:28px}
.panel .sel li{padding:2.5px 10px;font-size:13px}
`;

function slotDrawer() {
  return `<section class="drawer c0">
  <div class="drawer-h"><b>1 · Keys — Grand Piano</b><span>The rest of this sound. Level, Space, Echo, Octave, Sustain and Mute stay on the panel above.</span>
    <span class="close"><span class="hb dim">◀ PREV</span><span class="hb dim">NEXT ▶</span><span class="hb">DONE ✓</span></span></div>
  <div class="groups">
    <div class="group sound"><div class="silk" style="color:var(--slot-0)">SOUND</div>
      <div class="row" style="align-items:flex-end;gap:14px">
        <div><div class="fieldlbl">INSTRUMENT · its own controls →</div><span class="picker lcd"><span><b>Grand Piano</b><br><small>PIANOS · SAMPLED</small></span><i>▾</i></span></div>
        ${knob('RELEASE', '0.12 s', .22, { size: 42 })}${knob('TONE', '100%', 1, { size: 42 })}
      </div>
      
    </div>
    <div class="group shape"><div class="silk" style="color:var(--slot-0)">COLOUR &amp; STEREO</div>
      <div class="row" style="gap:14px">${knob('LOWS', '0 dB', 0, { size: 42, bip: true })}${knob('HIGHS', '+2 dB', .17, { size: 42, bip: true })}${knob('CHORUS', '0%', 0, { size: 42, off: true })}${knob('PAN', 'Center', 0, { size: 42, bip: true })}${knob('WIDTH', '100%', .67, { size: 42 })}</div>
    </div>
    <div class="group play"><div class="silk" style="color:var(--slot-0)">HOW IT PLAYS</div>
      <div class="row" style="gap:20px">
        <div style="display:grid;gap:8px">
          <div><div class="fieldlbl">TRANSPOSE</div><div class="stepper">${hb('−')}<b>0 st</b>${hb('+')}</div></div>
          <div><div class="fieldlbl">PITCH BEND</div>${hb('BENDS THIS SOUND', { ledOn: false })}</div>
        </div>
        <div style="display:grid;gap:8px">
          <div><div class="fieldlbl">NOTES AT ONCE</div><div class="seg c0"><span class="on">All (chords)</span><span>Lowest</span><span>Highest</span></div></div>
          <div><div class="fieldlbl">TOUCH FOR THIS SOUND</div><div class="seg c0"><span>Soft</span><span class="on">Normal</span><span>Hard</span><span>Fixed</span></div></div>
        </div>
      </div>
    </div>
    <div class="group range"><div class="silk" style="color:var(--slot-0)">WHERE IT PLAYS</div>
      <div class="rangebox lcd c0"><span class="led on"></span><b style="white-space:nowrap">Whole keyboard</b></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div><div class="fieldlbl">LOWEST</div><div class="stepper">${hb('−')}<b>C2</b>${hb('+')}</div></div><div><div class="fieldlbl">HIGHEST</div><div class="stepper">${hb('−')}<b>C7</b>${hb('+')}</div></div></div>
      
    </div>
  </div>
</section>`;
}

const CTL_EDIT_CSS = '.panel .sec.cn:first-child .sec-h{letter-spacing:.06em}';
function editBody({ drawer = slotDrawer(), selectedSlot = 0, fxSel = false } = {}) {
  let panel = `${controlSection().replace('<div class="sec-h">CONTROL</div>', '<div class="sec-h">CONTROL<span class="sp"></span><span class="menu-tab">▾</span></div>')}
    ${[0, 1, 2, 3].map((i) => slotSection(i, { edit: true, selected: i === selectedSlot })).join('\n')}
    ${droneSection({ edit: true })}
    ${effectsSection({ edit: true })}`;
  if (fxSel) panel = panel.replace(/<section class="sec cn">\s*<div class="sec-h">EFFECTS/, '<section class="sec cn selected"><div class="sec-h">EFFECTS');
  return `${topbar('edit')}
${progRow({ edit: true })}
${progButtons({ edit: true })}
<div class="panelwrap">
  <main class="panel">
    ${panel}
  </main>
  ${drawer}
</div>
<footer class="bottom edit">${keyboard({ held: new Set(), sel: selectedSlot, labels: true })}
  <div class="editfoot"><div class="meter" style="width:100%"><i style="--m:48%"></i><i style="--m:52%"></i></div><div class="hint">Changes save to this song as you make them. Perform shows exactly this panel, drawers closed.</div></div></footer>`;
}

// Effects drawer
const FX_CSS = String.raw`
.drawer.fx{--c:#dfe5ec}
.drawer.fx::before{left:calc(var(--ctl) + 4 * var(--slot) + var(--drone));width:calc(100% - var(--ctl) - 4 * var(--slot) - var(--drone) - 2px)}
.sec.cn.selected .menu-tab{color:#111}
.fxgroups{display:flex}
.fxgroups .group{gap:0}
.fxgroups .group .row{gap:12px}
.fxgroups .knob .kl{font-size:9.5px}
.onoff{font-size:10px;font-weight:900;letter-spacing:.1em;padding:1px 5px;border-radius:3px;background:#2b3038;color:var(--faint)}
.onoff.on{background:var(--ok);color:#05230f}
`;
function fxDrawer() {
  const g = (title, extra, knobs, style = '') => `<div class="group" style="${style}"><div class="silk" style="color:#dfe5ec">${title} ${extra}</div><div class="row">${knobs}</div></div>`;
  return `<section class="drawer fx">
  <div class="drawer-h"><b>Effects — fine-tune</b><span>Shared by all four sounds. Picking a Space or Echo preset on the panel sets these for you.</span>
    <span class="close"><span class="hb">DONE ✓</span></span></div>
  <div class="fxgroups">
    ${g('SPACE', '<span class="onoff on">STAGE</span>', knob('SIZE', '42%', .42, { size: 40 }) + knob('DARK', '50%', .5, { size: 40 }) + knob('PRE-DLY', '25 ms', .125, { size: 40 }))}
    ${g('ECHO', '<span class="onoff on">QUARTER</span>', `<div><div class="fieldlbl">TIMING</div><div class="seg ca" style="margin-bottom:8px"><span>Free</span><span class="on">¼</span><span>⅛.</span><span>⅛</span></div>${hb('PING-PONG', { ledOn: false })}</div>` + knob('REPEATS', '30%', .33, { size: 40 }) + knob('TONE', '50%', .5, { size: 40 }))}
    ${g('CHORUS', '<span class="onoff on">ON</span>', knob('LEVEL', '−4.4 dB', .52, { size: 40 }) + knob('RATE', '0.4 Hz', .45, { size: 40 }) + knob('DEPTH', '50%', .5, { size: 40 }))}
    ${g('LOFI TAPE', '<span class="onoff">OFF</span>', knob('AMOUNT', '0%', 0, { size: 40, off: true }) + `<div style="display:grid;grid-template-columns:repeat(3,auto);gap:4px 10px;opacity:.55">${knob('WOW', '50%', .5, { size: 26 })}${knob('FLUTTER', '50%', .5, { size: 26 })}${knob('CRACKLE', '30%', .3, { size: 26 })}${knob('BITS', '50%', .5, { size: 26 })}${knob('TONE', '50%', .5, { size: 26 })}${knob('SATUR.', '50%', .5, { size: 26 })}</div>`)}
    ${g('TONE', '', knob('LOW', '0 dB', 0, { size: 40, bip: true }) + knob('MID', '−1 dB', -.08, { size: 40, bip: true }) + knob('HIGH', '+1 dB', .08, { size: 40, bip: true }))}
    ${g('GLUE', '<span class="onoff">OFF</span>', knob('AMOUNT', '0%', 0, { size: 40, off: true }))}
  </div>
</section>`;
}

// ------------------------------------------------------------------ write
const files = {
  'perform.html': page('Worship Rig — Perform (C: Hardware panel)', performBody(), PERFORM_CSS),
  'quick-settings.html': page('Worship Rig — Perform + System (C)', quickBody(), PERFORM_CSS + QUICK_CSS),
  'edit.html': page('Worship Rig — Edit (C: panel opened)', editBody(), EDIT_CSS),
  'edit-fx.html': page('Worship Rig — Edit, Effects drawer (C)', editBody({ drawer: fxDrawer(), selectedSlot: -1, fxSel: true }), EDIT_CSS + FX_CSS),
};
for (const [f, html] of Object.entries(files)) writeFileSync(join(OUT, f), html);
console.log('wrote', Object.keys(files).join(', '));
