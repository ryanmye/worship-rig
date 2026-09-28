// Edit view markup for proposal B: a two-column "song sheet" (left: what plays · right: how it sounds).
const hb = (pos, c) => `<div class="hbar"${c ? ` style="--c:${c}"` : ''}><b style="width:${pos}%"></b><em style="left:${pos}%"></em></div>`;

export function editBody({ topbar, keyboard, I }) {
  const lvl = (pos, db, i) => `<div class="lvl">${hb(pos, `var(--slot-${i})`)}<span>${db}</span></div>`;
  const tok = (t) => `<span class="tok">${t}</span>`;
  return `
${topbar}
<div class="wrap">
  <aside class="rail">
    <div class="panel"><span class="cap">Setlist</span><div class="sel">Sunday 9am — Oct 5 ${I.down}</div></div>
    <div class="panel songs">
      <span class="cap" style="margin-bottom:6px">Songs in this set</span>
      <div class="s cur"><i>1</i>Sunday Pad + Piano<u>D</u></div>
      <div class="s"><i>2</i>Building Swell<u>G</u></div>
      <div class="s"><i>3</i>Way Maker<u>E</u></div>
      <div class="s"><i>4</i>Goodness of God<u>Ab</u></div>
      <div class="s"><i>5</i>Prayer Wash<u>D</u></div>
      <div class="s"><i>6</i>Graves Into Gardens<u>B</u></div>
      <div class="s"><i>7</i>King of Kings<u>D</u></div>
      <div class="s"><i>8</i>Build My Life<u>E</u></div>
      <div style="flex:1"></div>
      <div class="railbtns"><button class="btn">New</button><button class="btn">Factory</button><button class="btn">Library</button></div>
    </div>
    <div class="panel lib"><span>Library file</span><span style="color:var(--text)">Export / import ${I.chev}</span></div>
  </aside>

  <section class="sheet">
    <div class="panel shead">
      <div class="name">Sunday Pad + Piano <small>FROM FACTORY</small></div>
      <div class="acts"><button class="btn songs-btn">Songs ${I.down}</button><button class="btn">Notes</button><button class="btn">Reset to factory</button></div>
      <div class="say">In the key of ${tok('D major')} — you play in ${tok('D')}, no transpose · tempo ${tok('72 BPM')} <span class="hint" style="margin-left:6px">tap to set</span></div>
          </div>

    <div class="cols">
      <div class="col">
        <div class="colhd"><h2>What plays</h2><span>your four sounds, the drone, and what your hands do</span></div>

        <div class="line open" style="--c:var(--slot-0)">
          <div class="say"><span class="who">KEYS</span> plays ${tok('Grand Piano')} on ${tok('every key')}, sustain ${tok('on')}</div>
          <div class="ctl">${lvl(72, '−1.9 dB', 0)}<span class="onoff on"></span><span class="more">${I.chev}</span></div>
          <div class="det">
            <div class="k">Sound</div>
            <div class="v"><span class="pick">Grand Piano <small>Pianos</small>${I.down}</span>
              <span class="pp">Release ${hb(35, 'var(--slot-0)')}</span><span class="pp">Tone ${hb(80, 'var(--slot-0)')}</span></div>
            <div class="k sub">Where</div>
            <div class="v sub"><span class="sg"><span class="on">Every key</span><span>Split…</span></span>
              <span class="sg"><span>−2</span><span>−1</span><span class="on">Oct 0</span><span>+1</span><span>+2</span></span>
              <span class="sg"><span>−</span><span style="color:var(--text)">0 st</span><span>+</span></span></div>
            <div class="k sub">Feel</div>
            <div class="v sub"><span class="tg on"><i class="led"></i>Sustain pedal</span><span class="tg"><i class="led"></i>Pitch bend</span>
              <span class="sg"><span>Soft</span><span class="on">Normal</span><span>Hard</span><span>Fixed</span></span></div>
            <div class="k sub">Voices</div>
            <div class="v sub"><span class="sg"><span class="on">All notes</span><span>Lowest only</span><span>Highest only</span></span>
              <span class="fold" style="margin-left:auto">${I.chev} Placement &amp; tone <i>centre · full · flat</i></span></div>
          </div>
        </div>

        <div class="line" style="--c:var(--slot-1)">
          <div class="say"><span class="who">PAD</span> plays ${tok('Warm Pad')}, ${tok('swells with the mod wheel')}</div>
          <div class="ctl">${lvl(60, '−5.2 dB', 1)}<span class="onoff on"></span><span class="more">${I.chev}</span></div>
        </div>
        <div class="line empty" style="--c:var(--slot-2)">
          <div class="say"><span class="who">EXTRA</span> is empty — ${tok('choose a sound')} to layer or split</div>
          <div class="ctl"><span class="more">${I.chev}</span></div>
        </div>
        <div class="line off" style="--c:var(--slot-3)">
          <div class="say"><span class="who">BASS</span> plays ${tok('Sub Bass')} ${tok('below middle C')}, ${tok('an octave down')}</div>
          <div class="ctl">${lvl(66, '−3.4 dB', 3)}<span class="onoff"></span><span class="more">${I.chev}</span></div>
        </div>
        <div class="line" style="--c:var(--drone)">
          <div class="say"><span class="who">DRONE</span> hums ${tok('synth')} in ${tok('the song key')}, ${tok('carries over')}</div>
          <div class="ctl"><div class="lvl">${hb(58, 'var(--drone)')}<span>−9.1 dB</span></div><span class="onoff on" style="--c:var(--drone)"></span><span class="more">${I.chev}</span></div>
        </div>
        <div class="line" style="--c:#9aa3af">
          <div class="say"><span class="who" style="color:var(--text)">HANDS</span> wheel ${tok('brings in the Pad')}, bend ${tok('lifts the drone')}, Swell ${tok('8 s')}</div>
          <div class="ctl"><span class="more">${I.chev}</span></div>
        </div>
      </div>

      <div class="col">
        <div class="colhd"><h2>How it sounds</h2><span>the shared room and effects every sound can feed</span></div>

        <div class="fxc slim">
          <div class="top"><div class="say">Vibe: ${tok('your own mix')}</div><span class="hint">tap one to start from it</span></div>
          <div class="chips2"><span>Sunday</span><span>Full Set</span><span>Prayer</span><span>Jam</span><span>Lofi Tape</span><span>Ambient</span></div>
        </div>

        <div class="fxc">
          <div class="top"><div class="say">The room is a ${tok('Hall')}</div><span class="more" style="transform:rotate(90deg)">${I.chev}</span></div>
          <div class="chips2"><span>Dry</span><span>Room</span><span>Stage</span><span class="on">Hall</span><span>Cathedral</span><span>Ambient Wash</span></div>
          <div class="blurb">Big concert hall. Pads bloom, piano gets lush; back the level off if it muddies.</div>
          <div class="feeds">
            <div class="fh">SENT INTO THE ROOM</div>
            <div class="fr"><span class="r" style="--c:var(--slot-0)">Keys</span>${hb(25, 'var(--slot-0)')}<span>25%</span></div>
            <div class="fr"><span class="r" style="--c:var(--slot-1)">Pad</span>${hb(50, 'var(--slot-1)')}<span>50%</span></div>
            <div class="fr"><span class="r" style="--c:var(--slot-3)">Bass</span>${hb(0, 'var(--slot-3)')}<span>dry</span></div>
          </div>
          <div class="fold">${I.chev} Fine-tune <i>size 65% · darkness 45% · pre-delay 35 ms · level +1.2 dB</i></div>
        </div>

        <div class="fxc slim">
          <div class="top"><div class="say">Echo: ${tok('custom 420 ms')} — fed by
            <span class="dots" style="--c:var(--slot-0)"><i></i></span> 10%
            <span class="dots" style="--c:var(--slot-1)"><i></i></span> 10%</div><span class="more">${I.chev}</span></div>
        </div>
        <div class="fxc slim">
          <div class="top"><div class="say">Chorus: ${tok('gentle shimmer')} on
            <span class="dots" style="--c:var(--slot-1)"><i></i></span> Pad 35%</div><span class="more">${I.chev}</span></div>
        </div>
        <div class="fxc slim">
          <div class="top"><div class="say">Lofi tape: ${tok('off')}</div><span class="onoff"></span><span class="more">${I.chev}</span></div>
        </div>
        <div class="fxc slim">
          <div class="top"><div class="say">Finish: tone ${tok('flat')}, glue ${tok('off')}, master ${tok('−6 dB')}</div><span class="more">${I.chev}</span></div>
        </div>
      </div>
    </div>
  </section>
</div>

<footer class="dock">
  <div class="lanes-l"><span style="--c:var(--slot-0)">KEYS</span><span style="--c:var(--slot-1)">PAD</span><span style="--c:var(--slot-3);opacity:.55">BASS</span></div>
  <div class="lanes">
    <div class="lane" style="--c:var(--slot-0)"><b style="left:0;right:0"></b></div>
    <div class="lane" style="--c:var(--slot-1)"><b style="left:0;right:0"></b></div>
    <div class="lane dimmed" style="--c:var(--slot-3)"><b style="left:0;width:38.9%"></b></div>
  </div>
  <div class="mt"><span class="cap">Output</span><div class="meter"><i></i><i></i></div><span class="hint">Click keys to audition</span></div>
  <div class="kl">play<br>here</div>
  <div class="kbdwrap">${keyboard({ held: [] })}</div>
</footer>`;
}
