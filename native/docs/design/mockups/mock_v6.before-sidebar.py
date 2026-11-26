# Quick HTML mockups of Perform v6: the instrument strips ARE the main screen (Sunday Keys-style),
# with a Drone panel beside them. Not app code; rebuilt in code once Ryan picks.
OUT = '/home/claude/artifacts/mock-v5/index.html'

# Colours follow position (1st, 2nd, ...), not instrument type: every sound is an equal instrument (D15).
POS_COL = ['#f78955', '#4ec491', '#7ad1f7', '#af80e1', '#e46aa0', '#c9d867', '#6f9cf0']
ALL = [  # name, dB, fader %, space %, echo %, octave, sustain held
  ('Grand Piano', '−1.9', 62, 45, 10, 'normal', True),
  ('Warm Pad', '−5.2', 50, 55, 20, 'normal', True),
  ('Sub Bass', '−8.0', 40, 0, 0, '−1', False),
  ('Strings', '−7.5', 44, 60, 15, 'normal', True),
  ('Rhodes', '−4.0', 54, 30, 25, 'normal', True),
  ('Synth Lead', '−9.0', 36, 35, 40, '+1', False),
  ('Choir', '−10.5', 32, 70, 10, 'normal', True),
]


def quick(i, sp, ec, octv, sus):
  def send(lab, v):
    return f'<button class="qb send"><b>{lab}</b><small>{v}%</small><i style="width:{v}%"></i></button>'
  return (f'<div class="qgrid">{send("Space", sp)}{send("Echo", ec)}'
          f'<button class="qb{" alt" if octv != "normal" else ""}"><b>Octave</b><small>{octv}</small></button>'
          f'<button class="qb sus{" lit" if sus else ""}"><span class="dot"></span><b>Sustain</b></button></div>')


def strip(i, row, more_open=False, small=False):
  name, db, h, sp, ec, octv, sus = row
  c = POS_COL[i % len(POS_COL)]
  pop = ''
  if more_open:
    pop = f'''<div class="pop" role="dialog" aria-label="{name} more">
      <div class="pop-h">{name} <span>more</span></div>
      <div class="prow"><button class="ghost">◀ Earlier</button><button class="ghost">Later ▶</button></div>
      <div class="prow"><button class="ghost">Duplicate</button><button class="ghost">Open in Edit</button></div>
      <div class="prow"><button class="ghost warn">Remove (hold)</button></div></div>'''
  return f'''<div class="strip{' sm' if small else ''}" style="--c:{c}">
    <div class="s-name"><span class="ico"></span><span class="nm">{name}</span></div>
    <button class="tile on"><span class="dot"></span>ON</button>
    <div class="fwrap"><div class="ftrack"><i style="height:{h}%"></i><em style="bottom:{h}%"></em></div>
      <div class="meter"><i style="height:{max(h - 18, 5)}%"></i></div></div>
    <div class="db">{db} dB</div>
    {'' if small else quick(i, sp, ec, octv, sus)}
    <div class="s-btns"><button class="btn">Change</button><button class="btn more{' act' if more_open else ''}" aria-label="{name} more">⋯</button></div>
    {pop}</div>'''


def addstrip(slim=False):
  return (f'<button class="strip add{" slim" if slim else ""}" aria-label="Add instrument"><span>+</span>'
          f'{"" if slim else "Add instrument"}</button>')


KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']


def drone(wide=False):
  keys = ''.join(f'<button class="k{" sel" if k == "C" else ""}">{k}</button>' for k in KEYS)
  def sl(lab, v, extra=''):
    return (f'<div class="dsl"><span class="lab">{lab}</span><div class="hfader"><i style="width:{v}%;background:var(--drone)"></i>'
            f'<em style="left:{v}%"></em></div><small>{extra}</small></div>')
  return f'''<aside class="drone{' wide' if wide else ''}" style="--c:var(--drone)">
    <div class="d-h"><span class="ico"></span><b>Drone</b><div class="seg2 sm"><button class="on">Synth</button><button>My Pads</button></div></div>
    <div class="d-row"><button class="tile on"><span class="dot"></span>ON</button><div class="seg2 sm"><button class="on">Major</button><button>Minor</button></div></div>
    <div class="dkeys">{keys}</div>
    <div class="d-sl">{sl('Level', 72, '−6 dB')}{sl('Bright', 50, 'soft')}{sl('Move', 30, 'gentle')}</div>
    <div class="d-row"><button class="qb sus lit"><span class="dot"></span><b>Sustain</b></button><button class="qb"><b>Keep</b><small>across songs</small></button></div>
  </aside>'''


def topbar(narrow=False):
  return f'''<div class="top"><span class="logo">⛪</span><div class="seg2"><button class="on">Perform</button><button>Edit</button></div>
  <button class="tb">⚙</button><div class="status"><i class="ok"></i>MIDI ok<i class="ok"></i>Sound ok<span>42 ms</span></div>
  <button class="tb rec">● REC</button>{'' if narrow else '<div class="mvol"><span>Master</span><div class="hfader"><i style="width:68%"></i><em style="left:68%"></em></div></div>'}</div>'''


def songbar(narrow=False):
  return f'''<div class="songbar"><b class="song">Piano + Warm Pad</b><span class="keylab">KEY</span><button class="keybtn">C ▾</button>
  <div class="trn"><span class="keylab">TRANSPOSE</span><button class="sq">−</button><b>0</b><button class="sq">+</button></div>
  <button class="spc"><span class="keylab">SPACE</span>Hall ▾</button>
  {'' if narrow else '<span class="chord">CHORD <b>D</b></span>'}<button class="btn">Notes</button>
  <button class="setbtn">Setlist<small>My Set · not in use</small></button></div>'''


def snaps():
  return '''<div class="snaps"><span class="keylab">SNAPSHOTS</span>
  <button class="chip plate">Piano + Warm Pad<span class="chg" title="edited since saved"></span></button>
  <button class="chip">Felt piano, dry</button><button class="chip">Upright + drone</button><button class="chip">Full band</button>
  <button class="chip dash">+ Save</button>
  <span class="dirty">edited · <button class="link">Update</button> · <button class="link">Save as new</button></span>
  <button class="btn arr">Arrange</button></div>'''


WHITE = 'CDEFGAB'
HAS_BLACK = {'C', 'D', 'F', 'G', 'A'}
LET_W = {'C4': 'A', 'D4': 'S', 'E4': 'D', 'F4': 'F', 'G4': 'G', 'A4': 'H', 'B4': 'J', 'C5': 'K', 'D5': 'L', 'E5': ';'}
LET_B = {'C#4': 'W', 'D#4': 'E', 'F#4': 'T', 'G#4': 'Y', 'A#4': 'U', 'C#5': 'O', 'D#5': 'P'}
HELD = {'D3', 'A3', 'D4', 'F#4', 'A4'}   # a D chord, matching "CHORD D"
RANGES = {'Sub Bass': ('C2', 'B3')}      # one split to show the range bars doing their job


def kbd(n):
  # Today's Perform keyboard (perform.js .rbars + keys): C2–C7, a range bar per instrument, octave labels on C,
  # computer-key letters, held notes in gold.
  whites = [f'{l}{o}' for o in range(2, 7) for l in WHITE] + ['C7']
  N = len(whites); w = 100 / N
  idx = {k: i for i, k in enumerate(whites)}
  wk = ''.join(f'<span class="wk{" held" if k in HELD else ""}">{"<em>" + LET_W[k] + "</em>" if k in LET_W else ""}'
               f'{"<i>" + k + "</i>" if k[0] == "C" and k in ("C2", "C3", "C6", "C7") else ""}</span>' for k in whites)
  bk = ''
  for i, k in enumerate(whites[:-1]):
    if k[0] in HAS_BLACK:
      name = f'{k[0]}#{k[1:]}'
      bk += (f'<span class="bk{" held" if name in HELD else ""}" style="left:{(i + 1) * w - w * 0.3:.3f}%;width:{w * 0.6:.3f}%">'
             f'{"<em>" + LET_B[name] + "</em>" if name in LET_B else ""}</span>')
  bars = ''
  for i, r in enumerate(ALL[:n]):
    lo, hi = RANGES.get(r[0], ('C2', 'C7'))
    a, b = idx[lo], idx[hi] + 1
    bars += f'<i style="--c:{POS_COL[i % len(POS_COL)]};top:calc({i} * (100% + 2px) / {n});left:{a * w:.3f}%;width:{(b - a) * w:.3f}%"></i>'
  return f'<div class="keys2"><div class="rbars" style="--n:{n}">{bars}</div><div class="kb">{wk}{bk}</div></div>'


def bottom(n=2):
  return f'''<div class="bottom">{kbd(n)}<button class="act">↺ Revert<small>nothing changed</small></button>
  <button class="act">Fade out</button><button class="act panic">PANIC<small>hold · or Esc</small></button><button class="act">🔒 Lock<small>hold to lock</small></button></div>'''


def stage(n, more=None, port=False):
  rows = ALL[:n]
  strips = ''.join(strip(i, r, more_open=(r[0] == more)) for i, r in enumerate(rows))
  # More than 5 instruments: strips keep the 5-across width and the row scrolls sideways (Ryan, 2026-11-26).
  scroll = n > 5
  dense = ' scroll mid' if scroll else (' mid' if n >= 4 else ' few')
  mm = ''
  if scroll:
    pills = ''.join(f'<button class="mmp{" vis" if i < 5 else ""}" style="--c:{POS_COL[i % len(POS_COL)]}">{r[0]}</button>'
                    for i, r in enumerate(rows))
    mm = f'<div class="minimap" aria-label="All instruments; tap one to scroll to it">{pills}<span class="mmh">{n} instruments · scroll ⟷</span></div>'
  inner = f'<div class="strips">{strips}{addstrip(slim=n >= 5)}</div>'
  if scroll:
    inner = f'<div class="scrollwrap">{mm}<div class="sfade">{inner}</div></div>'
  return (f'<div class="board{dense}{" port" if port else ""}">{inner}'
          f'{drone(wide=port)}</div>')


def mac(n, more=None, w=1280, h=800, narrow=False):
  return (f'<div class="frame" style="width:{w}px;height:{h}px">{topbar(narrow)}{songbar()}{snaps()}'
          f'{stage(n, more)}{bottom(n)}</div>')


def portrait(n):
  return (f'<div class="frame port" style="width:820px;height:1180px">{topbar(True)}{songbar(True)}{snaps()}'
          f'{stage(n, port=True)}{bottom(n)}</div>')


def menubar():
  strips = ''.join(strip(i, r, small=True) for i, r in enumerate(ALL[:2]))
  return f'''<div class="frame mb" style="width:340px;height:492px"><div class="mb-h">Worship Rig <span>Piano + Warm Pad</span><button class="btn">Open</button></div>
  <div class="strips mbs">{strips}</div>
  <div class="mbrow"><span class="lab">Volume</span><div class="hfader"><i style="width:68%"></i><em style="left:68%"></em></div></div>
  <div class="mbrow"><span class="lab">Transpose</span><button class="sq">−</button><b>0</b><button class="sq">+</button><span class="lab" style="margin-left:auto">Drone</span><button class="tile on cand sm2"><span class="dot"></span>C</button></div>
  <div class="chips mbc"><button class="chip plate">Piano + Warm Pad</button><button class="chip">Felt piano</button><button class="chip">Upright</button></div>
  <button class="act panic wide">PANIC · hold</button></div>'''


CSS = open('/home/claude/scratch/mock_v5.css').read() + open('/home/claude/scratch/mock_v6.css').read()
frames = [
  ('mac', 'Mac · 2 instruments', mac(2)),
  ('five', 'Mac · 5 instruments', mac(5)),
  ('seven', 'Mac · 7 (scrolls)', mac(7)),
  ('tweak', 'Mac · ⋯ open', mac(5, more='Warm Pad')),
  ('ipl', 'iPad landscape · 5', mac(5, w=1180, h=820, narrow=True)),
  ('ipl7', 'iPad landscape · 7 (scrolls)', mac(7, w=1180, h=820, narrow=True)),
  ('ipp', 'iPad portrait · 3', portrait(3)),
  ('mb', 'Menu bar popover', menubar()),
]
tabs = ''.join(f'<button role="tab" data-t="{i}" aria-selected="{str(k == 0).lower()}">{t}</button>'
               for k, (i, t, _) in enumerate(frames))
secs = ''.join(f'<section id="{i}" class="{"on" if k == 0 else ""}"><div class="scale">{f}</div></section>'
               for k, (i, t, f) in enumerate(frames))
html = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perform v5 mockups</title>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@700;800&family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<header class="pg"><h1>Perform v6: the strips are the main screen</h1>
<p>Quick HTML mockups in the app's Sanctuary v2 colours and fonts; nothing is wired up. The instrument strips fill the
screen, as in Sunday Keys, with the Drone panel beside them. Transpose and Space moved into the song bar and snapshots
got their own row, so the strips get the room. Colours go by position, not by kind of sound. With 6 or more
instruments the strips keep the 5-across width and the row scrolls sideways; the coloured pills above it show every instrument and which ones are on screen (tap one to jump to it). In this page you can scroll the 7-instrument views.</p>
<nav class="tabs" role="tablist">{tabs}</nav></header>
<main>{secs}</main>
<script>{{const tabs=[...document.querySelectorAll('[role=tab]')];
function show(id){{tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===id));document.querySelectorAll('main>section').forEach(s=>s.classList.toggle('on',s.id===id));fit();}}
tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));
function fit(){{document.querySelectorAll('section.on .scale').forEach(sc=>{{const f=sc.firstElementChild;const k=Math.min(1,(sc.clientWidth)/f.offsetWidth);f.style.transform='scale('+k+')';sc.style.height=(f.offsetHeight*k)+'px';}});}}
document.querySelectorAll('.scrollwrap').forEach(w=>{{const sc=w.querySelector('.strips');const ps=[...w.querySelectorAll('.mmp')];const st=[...sc.querySelectorAll('.strip:not(.add)')];
function upd(){{const a=sc.scrollLeft,b=a+sc.clientWidth;st.forEach((s,i)=>ps[i]&&ps[i].classList.toggle('vis',s.offsetLeft-sc.offsetLeft>=a-4&&s.offsetLeft-sc.offsetLeft+s.offsetWidth<=b+4));w.classList.toggle('atend',b>=sc.scrollWidth-4);}}
sc.addEventListener('scroll',upd);ps.forEach((p,i)=>p.addEventListener('click',()=>sc.scrollTo({{left:st[i].offsetLeft-sc.offsetLeft-10,behavior:'smooth'}})));upd();}});
new ResizeObserver(fit).observe(document.body);fit();}}</script></body></html>'''
open(OUT, 'w').write(html)
print('ok', len(html))
