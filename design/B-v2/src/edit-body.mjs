// Edit view markup for proposal B-v2: a two-column "song sheet" (left: what plays · right: how it sounds),
// with a LIVE marker, calmer open lines (3 rows) and Fade out + PANIC in the dock.
const hb = (pos, c) => `<div class="hbar"${c ? ` style="--c:${c}"` : ''}><b style="width:${pos}%"></b><em style="left:${pos}%"></em></div>`;

export function editBody({ topbar, keyboard, I }) {
  const lvl = (pos, db, i) => `<div class="lvl">${hb(pos, `var(--slot-${i})`)}<span>${db}</span></div>`;
  const tok = (t) => `<span class="tok">${t}</span>`;
  const onp = (on, c) => `<span class="onp ${on ? 'on' : 'off'}"${c ? ` style="--c:${c}"` : ''}><i class="led"></i>${on ? 'ON' : 'OFF'}</span>`;
  return `
${topbar}
<div class="wrap">
  <aside class="rail">
    <div class="panel"><span class="cap">Setlist</span><div class="sel">Sunday 9am — Oct 5 ${I.down}</div></div>
    <div class="panel songs">
      <span class="cap">Songs in this set</span>
      <span class="rhint">Tap a song to switch to it — it starts playing.</span>
      <div class="s cur"><i>1</i>Sunday Pad + Piano<em class="playing"><b></b><b></b><b></b></em></div>
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
      <div class="name"><span class="live"><i></i>LIVE</span>Sunday Pad + Piano <small>FROM FACTORY</small></div>
      <div class="acts"><button class="btn songs-btn">Songs ${I.down}</button><button class="btn">Notes</button><button class="btn">Reset to factory</button></div>
      <div class="say">In the key of ${tok('D major')} — you play in ${tok('D')}, no transpose · tempo ${tok('72 BPM')} <span class="hint" style="margin-left:6px">tap to set</span></div>
      <div class="livenote">This is the song that's playing. Every change is heard right away and saved with the song.</div>
    </div>

    <div class="cols">
      <div class="col">
        <div class="colhd"><h2>What plays</h2><span>your four sounds, the drone, and your hands</span></div>

        <div class="line open" style="--c:var(--slot-0)">
          <div class="say"><span class="who">KEYS</span> plays ${tok('Grand Piano')} on ${tok('every key')}, sustain ${tok('on')}</div>
          <div class="ctl">${lvl(72, '−1.9 dB', 0)}${onp(true)}<span class="more">${I.chev}</span></div>
          <div class="det">
            <div class="k">Sound</div>
            <div class="v"><span class="pick">Grand Piano <small>Piano</small>${I.down}</span>
              <span class="pp">Release ${hb(35, 'var(--slot-0)')}<b>35%</b></span><span class="pp">Tone ${hb(80, 'var(--slot-0)')}<b>80%</b></span></div>
            <div class="k sub">Plays</div>
            <div class="v sub"><span class="sg"><span class="on">Every key</span><span>Split…</span></span>
              <span class="oct2"><span>−</span><b>Oct 0</b><span>+</span></span>
              <span class="tg on"><span>Sustain</span><i class="led"></i></span>
              <span class="same">same switches as the Perform strip</span></div>
            <div class="fold2">${I.chev}<b>More for Keys</b><i>all notes · normal response · pitch bend on · no shift · centre · flat</i></div>
          </div>
        </div>

        <div class="line" style="--c:var(--slot-1)">
          <div class="say"><span class="who">PAD</span> plays ${tok('Warm Pad')}, ${tok('swells with the mod wheel')}</div>
          <div class="ctl">${lvl(60, '−5.2 dB', 1)}${onp(true)}<span class="more">${I.chev}</span></div>
        </div>
        <div class="line empty" style="--c:var(--slot-2)">
          <div class="say"><span class="who">EXTRA</span> is empty — ${tok('choose a sound')} to layer or split</div>
          <div class="ctl"><span class="more">${I.chev}</span></div>
        </div>
        <div class="line off" style="--c:var(--slot-3)">
          <div class="say"><span class="who">BASS</span> plays ${tok('Sub Bass')} ${tok('below middle C')}, ${tok('an octave down')}, ${tok('one note at a time')}</div>
          <div class="ctl">${lvl(66, '−3.4 dB', 3)}${onp(false)}<span class="more">${I.chev}</span></div>
        </div>
        <div class="line" style="--c:var(--drone)">
          <div class="say"><span class="who">DRONE</span> hums a ${tok('synth')} in ${tok('the song key')}, ${tok('carries over')}</div>
          <div class="ctl"><div class="lvl">${hb(58, 'var(--drone)')}<span>−9.1 dB</span></div>${onp(true)}<span class="more">${I.chev}</span></div>
        </div>
        <div class="line" style="--c:#9aa3af">
          <div class="say"><span class="who" style="color:var(--text)">HANDS</span> the wheel ${tok('brings in the Pad')}, bend ${tok('lifts the drone')}, Swell takes ${tok('8 s')}</div>
          <div class="ctl"><span class="more">${I.chev}</span></div>
        </div>
      </div>

      <div class="col">
        <div class="colhd"><h2>How it sounds</h2><span>the shared room and effects</span></div>

        <div class="fxc slim">
          <div class="top"><div class="say">Vibe: ${tok('your own mix')}</div><span class="hint">tap one to start from it</span></div>
          <div class="chips2"><span>Sunday</span><span>Full Set</span><span>Prayer</span><span>Jam</span><span>Lofi Tape</span><span>Ambient</span></div>
        </div>

        <div class="fxc open">
          <div class="top"><div class="say">The room is a ${tok('Hall')}</div><span class="more" style="transform:rotate(90deg)">${I.chev}</span></div>
          <div class="chips2"><span>Dry</span><span>Room</span><span>Stage</span><span class="on">Hall</span><span>Cathedral</span><span>Ambient Wash</span></div>
          <div class="blurb">Big concert hall. Pads bloom, piano gets lush; back the level off if it muddies.</div>
          <div class="feeds">
            <div class="fh">HOW MUCH OF EACH SOUND GOES INTO THE ROOM</div>
            <div class="fr"><span class="r" style="--c:var(--slot-0)">Keys</span>${hb(25, 'var(--slot-0)')}<span>25%</span></div>
            <div class="fr"><span class="r" style="--c:var(--slot-1)">Pad</span>${hb(50, 'var(--slot-1)')}<span>50%</span></div>
            <div class="fr off"><span class="r" style="--c:var(--slot-3)">Bass</span>${hb(0, 'var(--slot-3)')}<span>dry</span></div>
          </div>
          <div class="fold">${I.chev} Fine-tune <i>size 65% · darkness 45% · pre-delay 35 ms · level +1.2 dB</i></div>
        </div>

        <div class="fxc slim">
          <div class="top"><div class="say">Echo: ${tok("song's own 420 ms")} ·
            <span class="dots" style="--c:var(--slot-0)"><i></i></span> Keys 10%
            <span class="dots" style="--c:var(--slot-1)"><i></i></span> Pad 10%</div><span class="more">${I.chev}</span></div>
        </div>
        <div class="fxc slim">
          <div class="top"><div class="say">Chorus: ${tok('gentle shimmer')} on
            <span class="dots" style="--c:var(--slot-1)"><i></i></span> Pad 35%</div><span class="more">${I.chev}</span></div>
        </div>
        <div class="fxc slim">
          <div class="top"><div class="say">Lofi tape: ${tok('off')}</div>${onp(false)}<span class="more">${I.chev}</span></div>
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
    <div class="lane act" style="--c:var(--slot-0)"><b style="left:0;right:0"></b></div>
    <div class="lane" style="--c:var(--slot-1)"><b style="left:0;right:0"></b></div>
    <div class="lane dimmed" style="--c:var(--slot-3)"><b style="left:0;width:38.9%"></b><span class="lt">up to B3</span></div>
  </div>
  <div class="kl">play<br>here</div>
  <div class="kbdwrap">${keyboard({ held: [] })}</div>
  <div class="mt">
    <div class="mtop"><span class="cap">Output</span><div class="meter"><i></i><i></i></div></div>
    <div class="acts2"><button class="btn fade">Fade out</button><button class="btn panic">PANIC</button></div>
  </div>
</footer>`;
}
