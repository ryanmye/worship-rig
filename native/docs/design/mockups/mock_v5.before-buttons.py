# Quick HTML mockups of Perform v5 (vertical strips, modular cards). Not app code.
OUT='/home/claude/artifacts/mock-v5/index.html'
STRIP_COL={'Grand Piano':'#f78955','Warm Pad':'#4ec491','Sub Bass':'#af80e1'}

def strip(name, db, lvl, on=True, icon='', tweaks_open=False, small=False):
  c=STRIP_COL.get(name,'#7ad1f7')
  tile=(f'<button class="tile on" style="--c:{c}"><span class="dot"></span>ON</button>' if on
        else '<button class="tile"><span class="dot"></span>OFF</button>')
  h=lvl
  pop=''
  if tweaks_open:
    pop=f'''<div class="pop" role="dialog" aria-label="{name} tweaks">
      <div class="pop-h">{name} <span>tweaks</span></div>
      <div class="prow"><span class="lab">Octave</span><button class="sq">−</button><b>0</b><button class="sq">+</button></div>
      <div class="prow"><span class="lab">Pedal</span><button class="seg sel">Holds</button><button class="seg">Ignores</button></div>
      <div class="prow col"><span class="lab">Space send</span><div class="hfader"><i style="width:45%;background:{c}"></i><em style="left:45%"></em></div><small>45%</small></div>
      <div class="prow col"><span class="lab">Echo send</span><div class="hfader"><i style="width:10%;background:{c}"></i><em style="left:10%"></em></div><small>10%</small></div>
      <div class="prow"><button class="ghost">◀ Earlier</button><button class="ghost">Later ▶</button><button class="ghost warn">Remove (hold)</button></div>
    </div>'''
  return f'''<div class="strip{' sm' if small else ''}" style="--c:{c}">
    <div class="s-name"><span class="ico">{icon}</span>{name}</div>
    {tile}
    <div class="fwrap"><div class="ftrack"><i style="height:{h}%"></i><em style="bottom:{h}%"></em></div><div class="meter"><i style="height:{max(h-18,5)}%"></i></div></div>
    <div class="db">{db} dB</div>
    <div class="s-btns"><button class="btn">Change</button><button class="btn more{' act' if tweaks_open else ''}" aria-label="{name} tweaks">⋯</button></div>
    {pop}
  </div>'''

def addstrip(): return '<button class="strip add"><span>+</span>Add instrument</button>'

def card(title, sub, body, cls=''):
  return f'<section class="card {cls}"><h3>{title} <span>{sub}</span></h3>{body}</section>'

SNAP=card('Snapshots','one tap brings one back','''<div class="chips">
  <button class="chip plate">Piano + Warm Pad<span class="chg" title="edited since saved"></span></button>
  <button class="chip">Felt piano, dry</button><button class="chip">Upright + drone</button>
  <button class="chip dash">+ Save</button>
  <span class="dirty">edited · <button class="link">Update</button> · <button class="link">Save as new</button></span></div>''','snap')
SPACE=card('Space','the room around everything','''<div class="chips sp">
  <button class="chip">Dry<small>none</small></button><button class="chip">Room<small>small</small></button>
  <button class="chip">Stage<small>medium</small></button><button class="chip sel">Hall<small>big</small></button>
  <button class="chip">Cathedral<small>huge</small></button></div>''')
VOL=card('Volume','everything','<div class="hrow"><div class="hfader big"><i style="width:68%"></i><em style="left:68%"></em></div><b>−6.0 dB</b></div>')
TRN=card('Transpose','semitones','<div class="hrow c"><button class="sq b">−</button><b class="num">0</b><button class="sq b">+</button></div>')
TONE=card('Tone','brightness and warmth of everything','''<div class="hrow"><span class="lab">Bright</span><div class="hfader"><i style="width:50%"></i><em style="left:50%"></em></div></div>
  <div class="hrow"><span class="lab">Warm</span><div class="hfader"><i style="width:56%"></i><em style="left:56%"></em></div></div>''')
DRONE=card('Drone','a held note under everything','''<div class="hrow"><button class="tile on cand"><span class="dot"></span>ON</button><button class="sel-box">C major ▾</button></div>
  <div class="hrow"><span class="lab">Level</span><div class="hfader"><i style="width:72%;background:var(--drone)"></i><em style="left:72%"></em></div></div>''')
SUS=lambda names: card('Sustain pedal','tap to choose what it holds','<div class="chips">'+''.join(f'<button class="chip sel hchip"><span class="dot" style="background:{STRIP_COL.get(n)}"></span>{n}<small>held</small></button>' for n in names)+'<button class="chip hchip"><span class="dot" style="background:var(--drone)"></span>Drone<small>not held</small></button></div>')

def topbar(narrow=False):
  return f'''<div class="top"><span class="logo">⛪</span><div class="seg2"><button class="on">Perform</button><button>Edit</button></div>
  <button class="tb">⚙</button><div class="status"><i class="ok"></i>MIDI ok<i class="ok"></i>Sound ok<span>42 ms</span></div>
  <button class="tb rec">● REC</button>{'' if narrow else '<div class="mvol"><span>Master</span><div class="hfader"><i style="width:68%"></i><em style="left:68%"></em></div></div>'}</div>'''

def songbar():
  return '''<div class="songbar"><b class="song">Piano + Warm Pad</b><span class="keylab">KEY</span><button class="keybtn">C ▾</button>
  <span class="chord">CHORD <b>D</b></span><button class="btn">Notes</button><button class="btn">Arrange</button>
  <button class="setbtn">Setlist<small>My Set · not in use</small>▾</button></div>'''

def bottom():
  return '''<div class="bottom"><div class="keys"></div><button class="act">↺ Revert<small>nothing changed</small></button>
  <button class="act">Fade out</button><button class="act panic">PANIC<small>hold · or Esc</small></button><button class="act">🔒 Lock<small>hold to lock</small></button></div>'''

def mac(layers, tweaks=None, w=1280, h=800, label=''):
  strips=''.join(strip(n,d,l,tweaks_open=(n==tweaks)) for n,d,l in layers)+addstrip()
  names=[n for n,_,_ in layers]
  return f'''<div class="frame" style="width:{w}px;height:{h}px" aria-label="{label}">{topbar()}{songbar()}
  <div class="stage"><div class="strips">{strips}</div>
  <div class="cards">{SNAP}{SPACE}<div class="row2">{VOL}{TRN}</div><div class="row2">{TONE}{DRONE}</div>{SUS(names)}</div></div>
  {bottom()}</div>'''

def portrait(layers):
  strips=''.join(strip(n,d,l) for n,d,l in layers)+addstrip()
  names=[n for n,_,_ in layers]
  return f'''<div class="frame port" style="width:820px;height:1180px">{topbar(True)}{songbar()}
  <div class="stage p"><div class="strips p">{strips}</div>
  <div class="cards p">{SNAP}{SPACE}<div class="row2">{VOL}{TRN}</div><div class="row2">{TONE}{DRONE}</div>{SUS(names)}</div></div>{bottom()}</div>'''

def menubar(layers):
  strips=''.join(strip(n,d,l,small=True) for n,d,l in layers)
  return f'''<div class="frame mb" style="width:340px;height:492px"><div class="mb-h">Worship Rig <span>Piano + Warm Pad</span><button class="btn">Open</button></div>
  <div class="strips mbs">{strips}</div>
  <div class="mbrow"><span class="lab">Volume</span><div class="hfader"><i style="width:68%"></i><em style="left:68%"></em></div></div>
  <div class="mbrow"><span class="lab">Transpose</span><button class="sq">−</button><b>0</b><button class="sq">+</button><span class="lab" style="margin-left:auto">Drone</span><button class="tile on cand sm2"><span class="dot"></span>C</button></div>
  <div class="chips mbc"><button class="chip plate">Piano + Warm Pad</button><button class="chip">Felt piano</button><button class="chip">Upright</button></div>
  <button class="act panic wide">PANIC · hold</button></div>'''

TWO=[('Grand Piano','−1.9',62),('Warm Pad','−5.2',50)]
THREE=TWO+[('Sub Bass','−8.0',40)]
CSS=open('/home/claude/scratch/mock_v5.css').read()
frames=[
 ('mac','Mac · piano + pad',mac(TWO,label='mac')),
 ('three','Mac · 3 instruments (all equal)',mac(THREE)),
 ('tweak','Mac · one strip’s ⋯ open',mac(TWO,tweaks='Grand Piano')),
 ('ipp','iPad portrait',portrait(THREE)),
 ('mb','Menu bar popover',menubar(TWO)),
]
tabs=''.join(f'<button role="tab" data-t="{i}" aria-selected="{str(k==0).lower()}">{t}</button>' for k,(i,t,_) in enumerate(frames))
secs=''.join(f'<section id="{i}" class="{"on" if k==0 else ""}"><div class="scale">{f}</div></section>' for k,(i,t,f) in enumerate(frames))
html=f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perform v5 mockups</title>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@700;800&family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<header class="pg"><h1>Perform v5: quick mockups</h1>
<p>These are quick HTML mockups in the app's own Sanctuary v2 colours and fonts. Each instrument is the same vertical strip, and the
shared cards sit beside the strips. They aren't wired up to anything; once you pick a direction it gets rebuilt in code.
The answers to your open questions are my recommendations, pending your confirmation: Update snapshot, Tone as one shared
card, tweaks behind ⋯, and Volume on the stage and in the top bar.</p>
<nav class="tabs" role="tablist">{tabs}</nav></header>
<main>{secs}</main>
<script>{{const tabs=[...document.querySelectorAll('[role=tab]')];
function show(id){{tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===id));document.querySelectorAll('main>section').forEach(s=>s.classList.toggle('on',s.id===id));fit();}}
tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));
function fit(){{document.querySelectorAll('section.on .scale').forEach(sc=>{{const f=sc.firstElementChild;const k=Math.min(1,(sc.clientWidth)/f.offsetWidth);f.style.transform='scale('+k+')';sc.style.height=(f.offsetHeight*k)+'px';}});}}
new ResizeObserver(fit).observe(document.body);fit();}}</script></body></html>'''
open(OUT,'w').write(html); print('ok', len(html))
