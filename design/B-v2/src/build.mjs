// Builds the self-contained proposal B-v2 mockups (design/B-v2/*.html) from src/*.css + the templates below,
// then screenshots them with Playwright. Run from the repo root:  node design/B-v2/src/build.mjs [--no-shots]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editBody } from './edit-body.mjs';

const SRC = dirname(fileURLToPath(import.meta.url));
const OUT = join(SRC, '..');
const css = (...names) => names.map((n) => readFileSync(join(SRC, n), 'utf8')).join('\n');

// ---------------------------------------------------------------- icons
const I = {
  brand: '<svg viewBox="0 0 20 20" fill="#7cc4ff"><rect x="1" y="9" width="3" height="10" rx="1"/><rect x="6" y="4" width="3" height="15" rx="1"/><rect x="11" y="7" width="3" height="12" rx="1"/><rect x="16" y="11" width="3" height="8" rx="1"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
  down: '<svg class="dn" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m5 12 5 5 9-10"/></svg>',
};
const lockI = `<span class="lk">${I.lock}</span>`;

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
const KBD_CSS = '.kbd .kin{position:relative;display:flex;flex:1}.kbd .b{top:0}';

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
    <button class="btn iconbtn frz" title="Settings">${I.gear}</button>
  </div>
</header>`;

// ---------------------------------------------------------------- Perform
function vfader(pos, { wheel = null } = {}) {
  return `<div class="vf"><div class="tr"></div><div class="fl" style="height:calc(${pos}% - 8px)"></div>${
    wheel !== null ? `<div class="wm" style="bottom:${wheel}%"></div>` : ''
  }<div class="th" style="bottom:${pos}%"></div></div>`;
}
const ontile = (role, on) =>
  `<button class="ontile ${on ? 'on' : 'off'}" aria-pressed="${on}"><i class="led"></i><span class="role">${role}</span><span class="st">${on ? 'ON' : 'OFF'}</span></button>`;

function strip({ i, role, inst, on = true, pos = 70, db, tag = '', sus = true, oct = 0, empty = false, open = false }) {
  const c = `var(--slot-${i})`;
  if (empty) {
    return `<section class="slim" style="--c:${c}" title="EXTRA is empty — tap to choose a sound">
      <span class="plus">+</span><span class="vt"><b>${role}</b> · EMPTY</span></section>`;
  }
  const octTxt = oct === 0 ? '0' : oct > 0 ? `+${oct}` : `−${-oct}`;
  return `<section class="strip${on ? '' : ' dim'}" style="--c:${c}">
    ${ontile(role, on)}
    <button class="pick frz${open ? ' open' : ''}" data-pick="${i}"><span class="nm">${inst}</span>${I.down}${lockI}</button>
    <div class="fbody"><div class="tag">${tag}</div>${vfader(pos, { wheel: tag ? pos : null })}<div class="db">${db}</div></div>
    <div class="foot">
      <div class="mod${sus ? ' on' : ''}"><span>Sustain</span><i class="led"></i></div>
      <div class="oct${oct ? ' on' : ''}"><span>−</span><b>Oct ${octTxt}</b><span>+</span></div>
    </div></section>`;
}

const drone = () => `
  <section class="drone">
    ${ontile('DRONE', true)}
    <div class="full">
      <div class="drow1"><span class="keyname">D major</span><div class="seg2 frz"><span class="on">Synth</span><span>My Pads</span></div></div>
      <div class="keys12 hold">${['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
        .map((k) => `<span class="${k === 'D' ? 'on' : ''}">${k}</span>`).join('')}</div>
      <div class="drow"><div class="seg2 hold"><span class="on">Major</span><span>Minor</span></div>
        <div class="hbar"><b style="width:58%"></b><em style="left:58%"></em></div><span class="v">−9.1 dB</span></div>
      <div class="drow" style="grid-template-columns:1fr;margin-top:-2px"><span class="holdtag" style="justify-self:start">HOLD A KEY TO CHANGE IT WHILE LOCKED</span></div>
      <button class="dmore"><span>Drone options</span><i>brightness, movement, carry over</i>${I.chev}</button>
    </div>
    <div class="mini">
      <span class="kn">D <small>maj</small></span>
      ${vfader(58)}
      <span class="db" style="font-weight:800;font-size:15px">−9.1</span>
    </div>
  </section>`;

// ---------------------------------------------------------------- Quick settings drawer (right side, pushes the stage)
const qrow = (label, desc, chips, { frz = false } = {}) => `
    <div class="qrow${frz ? ' frz' : ''}"><div class="qh"><b>${label}</b>${frz ? I.lock : ''}<span>${desc}</span></div>
      <div class="qchips">${chips}</div></div>`;
const sw = (list, on) => list.map((t) => `<span class="sw${t === on ? ' on' : ''}">${t}</span>`).join('');

const qsSong = () => `
  <div class="dscope">Saved with <b>“Sunday Pad + Piano”</b>. Locked: Space, Echo, Lofi stay live; rows with ${I.lock} freeze.</div>
  <div class="dbody">
    ${qrow('Space', '<em>Hall</em> — big concert hall. Pads bloom, piano gets lush.',
      sw(['Dry', 'Room', 'Stage', 'Hall', 'Cathedral', 'Ambient Wash'], 'Hall'))}
    ${qrow('Echo', "<em>Song's own</em> — 420 ms, a few repeats. Tap it to get it back.",
      sw(['Off', 'Slapback', 'Quarter', 'Dotted ⅛', 'Trails']) + '<span class="sw own on">Song\'s own<small>420 ms</small></span>')}
    ${qrow('Lofi', 'Tape wobble and crackle. Amount is in Edit.', '<span class="sw"><i class="led"></i>Tape</span>')}
    ${qrow('Vibe', 'Sets space + echo + lofi together.', sw(['Sunday', 'Full Set', 'Prayer', 'Jam', 'Lofi Tape', 'Ambient']), { frz: true })}
    ${qrow('Drone', 'Set and forget.', `<div class="qsl" style="--c:var(--drone)">
        <div><div class="lab2">Brightness <b>40%</b></div><div class="hbar thin"><b style="width:40%"></b><em style="left:40%"></em></div></div>
        <div><div class="lab2">Movement <b>30%</b></div><div class="hbar thin"><b style="width:30%"></b><em style="left:30%"></em></div></div>
        <span class="mod on"><span>Carry over to next song</span><i class="led"></i></span>
        <span class="mod"><span>Follow chords <small>beta</small></span><i class="led"></i></span></div>`, { frz: true })}
    ${qrow('Swell button', 'Time to reach full.', sw(['4 s', '8 s', '12 s', '16 s'], '8 s'), { frz: true })}
  </div>`;

const qsMac = () => `
  <div class="dscope"><b>Every song on this Mac.</b> Locked: all frozen except Test my pedal and Restart audio.</div>
  <div class="dbody">
    ${qrow('Sustain pedal', 'Pedal is <em>up</em> right now. Press it: the light should come on.',
      sw(['Normal', 'Reversed'], 'Normal') + '<span class="sw test"><i class="led"></i>Test my pedal</span>')}
    ${qrow('Output', 'Built-in Output. Mono is for one speaker or a mono PA feed.',
      sw(['Stereo', 'Mono'], 'Stereo'))}
    ${qrow('Touch', 'Normal: the harder you play, the louder it gets.', sw(['Light', 'Normal', 'Heavy', 'Fixed'], 'Normal'))}
    ${qrow('Keyboard', 'What the song buttons and the computer keys do.',
      '<span class="sw"><i class="led"></i>Song buttons pick songs</span><span class="sw lit"><i class="led"></i>Computer keys play notes</span>')}
    ${qrow('Audio', 'Sound OK · 12 ms. Restart if the sound stops or you changed speakers.', '<span class="sw">Restart audio</span>')}
  </div>`;

const drawer = (tab) => `
  <aside class="drawer" aria-label="Quick settings">
    <div class="dhead">${I.sliders.replace('<svg', '<svg width="20" height="20"')}<h2>Quick settings</h2><span class="sp"></span>
      <button class="btn frz">${I.gear.replace('<svg', '<svg width="16" height="16"')}All settings…</button>
      <button class="btn done">Done</button></div>
    <div class="dtabs"><span class="${tab === 'song' ? 'on' : ''}">This song<small>saved with the song</small></span>
      <span class="${tab === 'mac' ? 'on' : ''}">This Mac<small>every song</small></span></div>
    ${tab === 'mac' ? qsMac() : qsSong()}
  </aside>`;

// ---------------------------------------------------------------- sound picker popover
const picker = () => `
<div class="pop" id="pickpop" style="--c:var(--slot-0);width:330px">
  <div class="ph"><b>Sound for KEYS</b><span>saved with this song</span></div>
  <div class="pl">
    <div class="gh">Piano</div>
    <div class="it cur">Grand Piano ${I.check}</div>
    <div class="it">Upright Piano</div>
    <div class="it hover">Bright Piano</div>
    <div class="gh">Electric Piano</div>
    <div class="it">Rhodes</div>
    <div class="it">Wurlitzer</div>
    <div class="it">Electric Grand</div>
    <div class="gh">Organ · Synth Pads · Synth Keys · Mallets · Guitar · Bass · My Samples</div>
    <div class="it"><span>Show all sounds</span><small>9 groups ${I.chev}</small></div>
  </div>
  <div class="pf"><span>${I.lock} Frozen while locked</span><button class="btn">Edit Keys…</button></div>
</div>
<script>
  // anchor the popover under the KEYS picker (mockup only)
  const a = document.querySelector('.pick.open').getBoundingClientRect();
  const p = document.getElementById('pickpop');
  p.style.left = a.left + 'px'; p.style.top = (a.bottom + 6) + 'px';
  p.style.maxHeight = (document.querySelector('.bottom').getBoundingClientRect().top - a.bottom - 16) + 'px';
</script>`;

function performBody({ qs = null, open = false } = {}) {
  return `
${topbar('perform')}
<section class="songrow">
  <div class="panel songcard"><h1>Sunday Pad + Piano</h1>
    <div class="songmeta"><span class="cap">Key</span><span class="key">D</span><span class="faint">you play in D · 72 BPM</span>
      <button class="btn notes-btn">Notes</button></div></div>
  <div class="panel tcard hold"><span class="cap">Transpose <span class="holdtag">HOLD</span></span>
    <div class="tpose"><button class="btn">−</button><b>0</b><button class="btn">+</button></div></div>
  <div class="panel chordcard"><span class="cap">Chord</span><b>D</b></div>
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
  <button class="btn next"><span class="nl"><small>NEXT</small><span>Building Swell · <span class="k2">G</span></span></span><span class="arr">▶</span></button>
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
  ${strip({ i: 0, role: 'KEYS', inst: 'Grand Piano', pos: 72, db: '−1.9 dB', open })}
  ${strip({ i: 1, role: 'PAD', inst: 'Warm Pad', pos: 60, db: '−5.2 dB', tag: 'wheel<br>100%' })}
  ${strip({ i: 2, role: 'EXTRA', empty: true })}
  ${strip({ i: 3, role: 'BASS', inst: 'Sub Bass', pos: 66, db: '−3.4 dB', on: false, sus: false, oct: -1 })}
  ${drone()}
  <section class="panel notes"><span class="cap">Notes</span>
    <p>The everyday worship sound: grand piano on top of a warm pad, with a soft key drone underneath.</p>
    <p>Mod wheel brings the pad in and out — start with piano alone and swell the pad for the chorus.</p>
    <p>Push the bend wheel up to lift the drone; pull it down to tuck it away.</p></section>
  ${qs ? drawer(qs) : ''}
</main>
<section class="panel switchbar">
  <div class="grp">
    <div class="gl"><span class="cap">Space</span><span class="val">Hall</span></div>
    <div class="row"><span class="sw">Room</span><span class="sw">Stage</span><span class="sw on">Hall</span>
      <span class="sw wide-only">Cathedral</span><span class="sw more">More ${I.down}</span></div>
  </div>
  <div class="grp">
    <div class="gl"><span class="cap">Echo</span><span class="val">Song's own</span></div>
    <div class="row"><span class="sw">Off</span><span class="sw wide-only">Slap</span><span class="sw">¼</span>
      <span class="sw">Dotted ⅛</span><span class="sw wide-only">Trails</span><span class="sw own on">Song's own<small>420 ms</small></span></div>
  </div>
  <div class="grp">
    <div class="gl"><span class="cap">Lofi</span></div>
    <div class="row"><span class="sw"><i class="led"></i>Tape</span></div>
  </div>
  <div class="grp">
    <div class="gl"><span class="cap">Undo</span><span class="holdtag">HOLD</span></div>
    <div class="row"><span class="sw revert hold"><span>↺ Revert<span class="wide-only"> song</span></span></span></div>
  </div>
  <div class="spacer"></div>
  <div class="grp" style="border-left:0;padding-right:0;justify-content:flex-end">
    <div class="row"><span class="sw quick">${I.sliders}Quick settings</span></div>
  </div>
</section>
<footer class="bottom">
  ${keyboard({ held: [38, 50, 54, 57] })}
  <button class="btn fade">Fade out</button>
  <button class="btn panic">PANIC</button>
  <button class="btn lockbtn"><span style="display:flex;gap:6px;align-items:center">${I.lock}<span class="lt">Lock</span></span><small class="ls"></small></button>
</footer>`;
}

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

// ---------------------------------------------------------------- write pages
const pcss = css('common.css', 'perform.css');
const lockedBody = () => performBody()
  .replace('<span class="lt">Lock</span></span><small class="ls"></small>', '<span class="lt">Locked</span></span><small class="ls">hold to unlock</small>');
const pages = [
  ['perform.html', 'Perform — B-v2', 'perform', performBody()],
  ['perform-locked.html', 'Perform locked — B-v2', 'perform locked', lockedBody()],
  ['perform-sound.html', 'Sound picker — B-v2', 'perform', performBody({ open: true }) + picker()],
  ['quick-settings.html', 'Quick settings — B-v2', 'perform qs', performBody({ qs: 'song' })],
  ['quick-mac.html', 'Quick settings, This Mac — B-v2', 'perform qs', performBody({ qs: 'mac' })],
  ['edit.html', 'Edit — B-v2', 'edit', editBody({ topbar: topbar('edit'), keyboard, I })],
];
for (const [file, title, cls, body] of pages) {
  writeFileSync(join(OUT, file), page(title, cls, cls.startsWith('edit') ? css('common.css', 'edit.css') : pcss, body));
}

// ---------------------------------------------------------------- screenshots
if (!process.argv.includes('--no-shots')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const pg = await browser.newPage();
  const shots = [
    ['perform.html', 'perform.png', 1440, 900],
    ['perform.html', 'perform-1024.png', 1024, 700],
    ['perform-locked.html', 'perform-locked.png', 1440, 900],
    ['perform-sound.html', 'perform-sound.png', 1440, 900],
    ['quick-settings.html', 'quick.png', 1440, 900],
    ['quick-settings.html', 'quick-1024.png', 1024, 700],
    ['quick-mac.html', 'quick-mac.png', 1440, 900],
    ['edit.html', 'edit.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
  ];
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  for (const [src, png, w, h] of shots) {
    if (only && !only.includes(png)) continue;
    await pg.setViewportSize({ width: w, height: h });
    await pg.goto('file://' + join(OUT, src));
    await pg.screenshot({ path: join(OUT, png) });
  }
  // measure fader throw (critique: "fader throw roughly halved")
  for (const [w, h] of [[1440, 900], [1024, 700]]) {
    await pg.setViewportSize({ width: w, height: h });
    await pg.goto('file://' + join(OUT, 'perform.html'));
    const t = await pg.$eval('.strip .vf .tr', (e) => Math.round(e.getBoundingClientRect().height));
    console.log(`fader track ${w}x${h}: ${t}px`);
  }
  await browser.close();
  console.log('shots written');
}
