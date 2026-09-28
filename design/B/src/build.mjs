// Builds the self-contained proposal-B mockups (design/B/*.html) from src/*.css + the templates below,
// then screenshots them with Playwright. Run from the repo root:  node design/B/src/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const OUT = join(SRC, '..');
const css = (...names) => names.map((n) => readFileSync(join(SRC, n), 'utf8')).join('\n');

// ---------------------------------------------------------------- icons
const I = {
  brand: '<svg viewBox="0 0 20 20" fill="#7cc4ff"><rect x="1" y="9" width="3" height="10" rx="1"/><rect x="6" y="4" width="3" height="15" rx="1"/><rect x="11" y="7" width="3" height="12" rx="1"/><rect x="16" y="11" width="3" height="8" rx="1"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
};

// ---------------------------------------------------------------- keyboard
const BLACK = new Set([1, 3, 6, 8, 10]);
function keyboard({ from = 36, to = 96, held = [] } = {}) {
  const whites = [];
  for (let n = from; n <= to; n++) if (!BLACK.has(n % 12)) whites.push(n);
  const W = whites.length;
  let out = '';
  for (const n of whites) {
    const lab = n % 12 === 0 ? `<small>C${n / 12 - 1}</small>` : '';
    out += `<div class="w${held.includes(n) ? ' held' : ''}">${lab}</div>`;
  }
  let wi = 0;
  for (let n = from; n <= to; n++) {
    if (BLACK.has(n % 12)) {
      const left = (wi * 100) / W - (0.3 * 100) / W;
      out += `<div class="b${held.includes(n) ? ' held' : ''}" style="left:${left.toFixed(3)}%;width:${((0.6 * 100) / W).toFixed(3)}%"></div>`;
    } else wi++;
  }
  return `<div class="kbd"><div class="kin">${out}</div></div>`;
}
const KBD_CSS = `.kbd .kin{position:relative;display:flex;flex:1}.kbd .b{top:0}`;

// ---------------------------------------------------------------- shared top bar
const topbar = (view) => `
<header class="topbar">
  <div class="brand">${I.brand}<span>Worship Rig</span></div>
  <div class="tabs"><button class="${view === 'perform' ? 'on' : ''}">Perform</button><button class="${view === 'edit' ? 'on' : ''}">Edit</button></div>
  <div class="status">
    <span><i class="led lit" style="--c:var(--ok)"></i><span class="k">MIDI</span> Keystation 61</span>
    <span><i class="led lit" style="--c:var(--ok)"></i>Sound OK <span class="mono hide-sm" style="color:var(--muted)">12 ms</span></span>
    <span style="color:var(--ok);letter-spacing:.08em"><i class="led lit" style="--c:var(--ok)"></i>READY</span>
  </div>
  <div class="rec">
    <button class="btn"><i class="recdot"></i>REC</button><span class="timer">00:00</span>
    <div class="meter"><i></i><i></i></div>
    <span class="cap mlab" style="font-size:10px">Master</span><div class="hf"><b style="width:63%"></b><em style="left:63%"></em></div>
    <span style="font-weight:800;font-size:14px;min-width:54px">−6.0 dB</span>
    <button class="btn iconbtn" title="Settings">${I.gear}</button>
  </div>
</header>`;

// ---------------------------------------------------------------- Perform
function vfader(pos, { wheel = null } = {}) {
  return `<div class="vf"><div class="tr"></div><div class="fl" style="height:calc(${pos}% - 8px)"></div>${
    wheel !== null ? `<div class="wm" style="bottom:${wheel}%"></div>` : ''
  }<div class="th" style="bottom:${pos}%"></div></div>`;
}
function strip({ i, role, inst, on = true, pos = 70, db, tag = '', sus = true, oct = 0, empty = false }) {
  const c = `var(--slot-${i})`;
  if (empty) {
    return `<section class="strip" style="--c:${c}">
      <button class="layer empty"><span class="role">${role}</span><span class="st">EMPTY</span><span class="inst">Add a sound in Edit</span></button>
      <div class="emptybody">No sound<br>in this slot</div></section>`;
  }
  const octTxt = oct === 0 ? '0' : oct > 0 ? `+${oct}` : `−${-oct}`;
  return `<section class="strip${on ? '' : ' dim'}" style="--c:${c}">
    <button class="layer ${on ? 'on' : 'off'}"><span class="role">${role}</span><span class="st">${on ? 'ON' : 'OFF'}<i class="led"></i></span>
      <span class="inst">${inst}</span></button>
    <div class="fbody"><div class="tag">${tag}</div>${vfader(pos, { wheel: tag ? pos : null })}<div class="db">${db}</div></div>
    <div class="foot">
      <div class="mod${sus ? ' on' : ''}"><span>Sustain</span><i class="led"></i></div>
      <div class="oct${oct ? ' on' : ''}"><span>−</span><b>Oct ${octTxt}</b><span>+</span></div>
    </div></section>`;
}

const performBody = () => `
${topbar('perform')}
<section class="songrow">
  <div class="panel songcard"><h1>Sunday Pad + Piano</h1>
    <div class="songmeta"><span class="cap">Key</span><span class="key">D</span><span class="faint">you play in D · 72 BPM</span>
      <button class="btn notes-btn">Notes</button></div></div>
  <div class="panel tcard"><span class="cap">Transpose</span><div class="tpose"><button class="btn">−</button><b>0</b><button class="btn">+</button></div></div>
  <div class="panel chordcard"><span class="cap">Chord</span><b>D</b></div>
  <div class="panel nextcard"><span class="cap">Next ▸</span><b>Building Swell · <span class="k2">G</span></b></div>
</section>
<nav class="setrow">
  <button class="btn prev">◀ Prev</button>
  <div class="panel chips">
    <span class="chip cur"><i>1</i>Sunday Pad + Piano<u>D</u></span>
    <span class="chip"><i>2</i>Building Swell<u>G</u></span>
    <span class="chip"><i>3</i>Way Maker<u>E</u></span>
    <span class="chip"><i>4</i>Goodness of God<u>Ab</u></span>
    <span class="chip"><i>5</i>Prayer Wash<u>D</u></span>
    <span class="chip"><i>6</i>Graves Into Gardens<u>B</u></span>
  </div>
</nav>
<main class="stage">
  <section class="panel wheel">
    <span class="cap">Wheel</span>
    <div class="wcap"><b style="height:100%"></b></div>
    <span class="big">100%</span><span class="to">→ Pad level</span>
    <span class="mini hide-sm">EXPR 100%</span>
    <button class="btn"><span>◢</span>Swell</button>
    <span class="mini"><i class="led lit" style="--c:var(--ok)"></i>PEDAL</span>
  </section>
  ${strip({ i: 0, role: 'KEYS', inst: 'Grand Piano', pos: 72, db: '−1.9 dB' })}
  ${strip({ i: 1, role: 'PAD', inst: 'Warm Pad', pos: 60, db: '−5.2 dB', tag: 'wheel 100%' })}
  ${strip({ i: 2, role: 'EXTRA', empty: true })}
  ${strip({ i: 3, role: 'BASS', inst: 'Sub Bass', pos: 66, db: '−3.4 dB', on: false, sus: false, oct: -1 })}
  <section class="drone">
    <button class="layer on"><span class="role">DRONE</span><span class="st">ON<i class="led"></i></span>
      <span class="inst">D major <span class="mode"><span class="on">Synth</span><span>My Pads</span></span></span></button>
    <div class="keys12">${['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
      .map((k) => `<span class="${k === 'D' ? 'on' : ''}">${k}</span>`).join('')}</div>
    <div class="drow"><div class="seg2"><span class="on">Major</span><span>Minor</span></div>
      <div class="hbar"><b style="width:58%"></b><em style="left:58%"></em></div><span class="v">−9.1 dB</span></div>
    <div class="char">
      <div><div class="lab">Brightness <b>40%</b></div><div class="hbar thin"><b style="width:40%"></b><em style="left:40%"></em></div></div>
      <div><div class="lab">Movement <b>30%</b></div><div class="hbar thin"><b style="width:30%"></b><em style="left:30%"></em></div></div>
    </div>
    <div class="dtg"><span class="mod on" style="--c:var(--drone)"><span>Carry over to next song</span><i class="led"></i></span><span class="mod"><span>Follow chords <small>beta</small></span><i class="led"></i></span></div>
  </section>
  <section class="panel notes"><span class="cap">Notes</span>
    <p>The everyday worship sound: grand piano on top of a warm pad, with a soft key drone underneath.</p>
    <p>Mod wheel brings the pad in and out — start with piano alone and swell the pad for the chorus.</p>
    <p>Push the bend wheel up to lift the drone; pull it down to tuck it away.</p></section>
</main>
<section class="panel switchbar">
  <div class="grp">
    <div class="gl"><span class="cap">Space</span><span class="val">Hall</span></div>
    <div class="row"><span class="sw">Room</span><span class="sw">Stage</span><span class="sw on">Hall</span>
      <span class="sw wide-only">Cathedral</span><span class="sw more">More ${I.down}</span></div>
  </div>
  <div class="grp">
    <div class="gl"><span class="cap">Echo</span><span class="val">Custom 420 ms</span></div>
    <div class="row"><span class="sw">Off</span><span class="sw wide-only">Slap</span><span class="sw near" title="closest preset">¼</span>
      <span class="sw">Dotted ⅛</span><span class="sw wide-only">Trails</span></div>
  </div>
  <div class="grp">
    <div class="gl"><span class="cap">Lofi</span></div>
    <div class="row"><span class="sw"><i class="led"></i>Tape</span></div>
  </div>
  <div class="grp wide-only">
    <div class="gl"><span class="cap">Rig</span><span class="scope">THIS MAC · ALL SONGS</span></div>
    <div class="row"><span class="sw"><i class="led"></i>Pedal reversed</span><span class="sw"><i class="led"></i>Mono</span></div>
  </div>
  <div class="spacer"></div>
  <div class="grp" style="border-left:0;padding-right:0;justify-content:flex-end">
    <div class="row"><span class="sw quick QUICKOPEN">${I.sliders}Quick settings</span></div>
  </div>
</section>
<footer class="bottom">
  ${keyboard({ held: [38, 50, 54, 57] })}
  <button class="btn fade">Fade out</button>
  <button class="btn panic">PANIC</button>
  <button class="btn"><span style="display:flex">${I.lock}</span>Lock</button>
</footer>`;

// ---------------------------------------------------------------- Quick settings drawer
const drawer = () => `
<div class="scrim"></div>
<aside class="drawer">
  <div class="dhead">${I.sliders.replace('<svg', '<svg width="22" height="22"')}<h2>Quick settings</h2>
    <span class="hint2">Fade out and PANIC stay reachable below</span><span class="sp"></span>
    <button class="btn">${I.gear.replace('<svg', '<svg width="18" height="18"')}All settings…</button>
    <button class="btn done">Done</button></div>
  <div class="dbody">
    <section class="dsec">
      <div class="hd"><h3>This song</h3><span class="scope">saved with “Sunday Pad + Piano”</span>
        <span class="lock">${I.lock} frozen while Perform is locked</span></div>
      <div class="qrow"><div class="lab">Vibe<small>space + echo + lofi</small></div>
        <div><div class="qchips"><span class="sw">Sunday</span><span class="sw">Full Set</span><span class="sw">Prayer</span>
          <span class="sw">Jam</span><span class="sw">Lofi Tape</span><span class="sw">Ambient</span></div>
          <div class="blurb">Your own mix — none of these match exactly. Tap one to start from it.</div></div></div>
      <div class="qrow"><div class="lab">Space</div>
        <div><div class="qchips"><span class="sw">Dry</span><span class="sw">Room</span><span class="sw">Stage</span><span class="sw on">Hall</span>
          <span class="sw">Cathedral</span><span class="sw">Ambient Wash</span></div>
          <div class="blurb"><b>Hall</b> — big concert hall. Pads bloom, piano gets lush; back the level off if it muddies.</div></div></div>
      <div class="qrow"><div class="lab">Echo</div>
        <div><div class="qchips"><span class="sw">No Echo</span><span class="sw">Slapback</span><span class="sw near">Quarter</span>
          <span class="sw">Dotted ⅛</span><span class="sw">Ambient Trails</span></div>
          <div class="blurb"><b>Custom</b> — 420 ms, a few repeats; closest is Quarter. Fine-tune it in Edit.</div></div></div>
      <div class="qrow"><div class="lab">Swell button<small>time to full</small></div>
        <div class="qchips"><span class="sw">4 s</span><span class="sw on">8 s</span><span class="sw">12 s</span><span class="sw">16 s</span>
          <span class="sw" style="margin-left:auto">↺ Revert song</span></div></div>
    </section>
    <section class="dsec">
      <div class="hd"><h3>This Mac</h3><span class="scope">every song · stays live when locked</span></div>
      <div class="qrow"><div class="lab">Touch<small>how hard you play</small></div>
        <div><div class="qchips"><span class="sw">Light</span><span class="sw on">Normal</span><span class="sw">Heavy</span><span class="sw">Fixed</span></div>
        <div class="blurb">Normal: the harder you play, the louder it gets.</div></div></div>
      <div class="qrow"><div class="lab">Sustain pedal</div>
        <div><div class="qchips"><span class="sw on">Normal</span><span class="sw">Reversed</span><span class="sw">Test my pedal</span></div>
          <div class="blurb" style="display:flex;gap:8px;align-items:center"><i class="led"></i><span>Pedal is <b>up</b> right now — press it and this should light.</span></div></div></div>
      <div class="qrow"><div class="lab">Output<small>Built-in Output</small></div>
        <div><div class="qchips"><span class="sw on">Stereo</span><span class="sw">Mono</span></div>
        <div class="blurb">Mono for a single speaker or a mono PA feed.</div></div></div>
      <div class="qrow"><div class="lab">Keyboard</div>
        <div class="qchips"><span class="sw"><i class="led"></i>Song buttons pick songs</span>
          <span class="sw"><i class="led lit" style="--c:var(--ok)"></i>Computer keys play notes</span></div></div>
      <div class="qrow"><div class="lab">Audio<small>Sound OK · 12 ms</small></div>
        <div class="qchips"><span class="sw">Restart audio</span><span class="blurb" style="margin:0 0 0 6px">if sound stops or you changed speakers</span></div></div>
    </section>
  </div>
</aside>`;

function page(title, bodyClass, cssText, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${cssText}
${KBD_CSS}
</style></head>
<body class="${bodyClass}">
${body}
</body></html>
`;
}

// ---------------------------------------------------------------- Edit (song sheet)
import { editBody } from './edit-body.mjs';

const pcss = css('common.css', 'perform.css');
writeFileSync(join(OUT, 'perform.html'), page('Perform — proposal B', 'perform', pcss, performBody().replace(' QUICKOPEN', '')));
writeFileSync(join(OUT, 'quick-settings.html'),
  page('Quick settings — proposal B', 'perform', pcss, performBody().replace(' QUICKOPEN', ' opened') + drawer()));
writeFileSync(join(OUT, 'edit.html'), page('Edit — proposal B', 'edit', css('common.css', 'edit.css'),
  editBody({ topbar: topbar('edit'), keyboard, I })));

// ---------------------------------------------------------------- screenshots
if (!process.argv.includes('--no-shots')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shots = [
    ['perform.html', 'perform.png', 1440, 900],
    ['perform.html', 'perform-1024.png', 1024, 700],
    ['edit.html', 'edit.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
    ['quick-settings.html', 'quick.png', 1440, 900],
    ['quick-settings.html', 'quick-1024.png', 1024, 700],
  ];
  for (const [src, png, w, h] of shots) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('file://' + join(OUT, src));
    await page.screenshot({ path: join(OUT, png) });
  }
  await browser.close();
  console.log('shots written');
}
