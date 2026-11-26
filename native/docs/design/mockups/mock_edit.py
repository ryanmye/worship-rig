# Quick HTML mockups of Edit, redesigned in the Perform v6 language (D15/D16). Not app code.
import os
import mock_v6 as m

OUT = '/home/claude/artifacts/mock-edit/index.html'
LIB = ['Piano + Warm Pad', 'Building Swell', 'Prayer Wash', 'Organ Swell', 'Grand Piano', 'Rhodes', 'Felt Piano',
       'Lofi Rhodes', 'Dusty Piano', 'Lantern Hymn']


def topbar_edit(narrow=False):
  return m.topbar(narrow).replace('<button class="on">Perform</button><button>Edit</button>',
                                  '<button>Perform</button><button class="on">Edit</button>', 1)


def library(compact=False):
  rows = ''.join(f'<button class="lr{" cur" if i == 0 else ""}"><span class="n">{i + 1}</span><b>{t}</b><span class="k">C</span></button>'
                 for i, t in enumerate(LIB))
  return f'''<aside class="lib"><div class="lib-h"><span class="lab">Library</span><button class="sb-x sm" aria-label="Fold the library">⟨</button></div>
    <div class="lib-set"><button class="sel-box">My Set ▾</button></div>
    <div class="bsearch"><span>⌕</span><input placeholder="Find a song…" aria-label="Find a song"></div>
    <div class="lrows">{rows}</div>
    <div class="lib-b"><button class="btn">+ New song</button><button class="btn">Song bank…</button></div></aside>'''


def song_header():
  return '''<div class="eh"><span class="livebadge"><i></i>LIVE</span><b class="song">Piano + Warm Pad</b><button class="ghost pen" aria-label="Rename">✎</button>
    <button class="keybtn">C ▾</button><small class="youplay">you play C</small>
    <div class="trn"><span class="keylab">BPM</span><b>72</b><button class="tap sm2">Tap</button></div>
    <span class="keylab">TIME</span><button class="spc">4/4 ▾</button>
    <button class="btn" style="margin-left:auto">Notes</button><button class="btn">Chart</button><button class="btn">⋯ Song</button></div>'''


def rig_tabs(sel='Grand Piano', n=3):
  tabs = ''
  for i, r in enumerate(m.ALL[:n]):
    c = m.POS_COL[i]
    tabs += (f'<button class="rt{" on" if r[0] == sel else ""}" style="--c:{c}"><b>{r[0]}</b><small>{r[1]} dB</small>'
             f'{"<span class=cd title=changed></span>" if i == 1 else ""}</button>')
  tabs += '<button class="rt add">+ Add</button><span class="rsep"></span>'
  for name, sub, key in [('Drone', 'C major · Synth', 'drone'), ('Effects', 'Hall · Dotted 8th', 'fx'),
                         ('Master', '−6.0 dB', 'master')]:
    tabs += f'<button class="rt gl{" on" if key == sel else ""}"><b>{name}</b><small>{sub}</small></button>'
  return f'''<div class="rig"><div class="rig-h"><span class="lab">Your rig</span><small>Pick one to shape it. A dot means it changed since the song began.</small>
    <button class="ghost" style="margin-left:auto">Show wiring</button></div><div class="rtabs">{tabs}</div></div>'''


def wslider(label, word, v, lo, hi):
  return f'''<div class="ws"><div class="ws-h"><b>{label}</b><span>{word}</span></div>
    <div class="hfader"><i style="width:{v}%;background:var(--c)"></i><em style="left:{v}%"></em></div>
    <div class="ws-e"><small>{lo}</small><small>{hi}</small></div></div>'''


def instrument_panel():
  c = m.POS_COL[0]
  sentence = ('<p class="sent"><b class="sn">Grand Piano</b> plays on <u>every key</u>, <u>a little</u> into the '
              '<u>Hall</u>, with sustain <u>on</u>. <small>Tap an underlined word to jump to it.</small></p>')
  stage = m.strip(0, m.ALL[0])
  sound = (wslider('Brightness', 'Bright · 100%', 92, 'darker', 'brighter') + wslider('Warmth', 'Neutral · 0 dB', 50, 'thinner', 'fuller')
           + wslider('Ring-out', 'Natural · 0.12 s', 38, 'short', 'long')
           + '''<button class="eqcard"><svg viewBox="0 0 120 34" aria-hidden="true"><path d="M0 22 C20 22 30 10 50 14 S80 24 120 18" fill="none" stroke="var(--c)" stroke-width="2"/></svg>
             <span><b>Tone EQ</b><small>2 bands · low shelf, high shelf</small></span><em>Open ▸</em></button>''')
  keys = ''.join(f'<i class="{"in" if 8 <= k <= 44 else ""}"></i>' for k in range(52))
  where = f'''<div class="rng"><div class="ws-h"><b>Keyboard range</b><span>every key</span></div><div class="mkb">{keys}</div>
      <div class="hrow"><button class="sel-box">C-1</button><span>to</span><button class="sel-box">G9</button><button class="btn">Whole keyboard</button></div>
      <div class="hrow"><button class="btn grow">Set lowest by playing</button><button class="btn grow">Set highest by playing</button></div></div>
    <div class="ws-h" style="margin-top:6px"><b>Touch</b><span>how it answers your playing</span></div>
    <div class="touch"><button class="seg">Light</button><button class="seg sel">Normal</button><button class="seg">Heavy</button><button class="seg">Fixed</button></div>
    <div class="hrow"><span class="lab">Octave</span><button class="sq">−</button><b>0</b><button class="sq">+</button>
      <span class="lab" style="margin-left:auto">Pan</span><div class="hfader" style="max-width:120px"><i style="width:50%"></i><em style="left:50%"></em></div></div>'''
  return f'''<div class="ipanel" style="--c:{c}"><div class="ip-h"><span class="ico" style="background:{c}"></span>{sentence}
      <button class="btn chgi">Change instrument ▾</button></div>
    <div class="cols"><section class="col1"><h4>On stage <small>the same strip as Perform</small></h4>{stage}</section>
      <section><h4>The sound itself</h4>{sound}</section><section><h4>Where it plays</h4>{where}</section></div>
    <details class="adv"><summary>Advanced <small>Width 100% · Transpose 0 · Voices all · Pitch bend off · Sustain row</small><span>Just as the song began</span></summary></details></div>'''


def fx_panel():
  rooms = ''.join(f'<button class="room{" sel" if t == "Hall" else ""}"><b>{t}</b><small>{d}</small></button>' for t, d in [
    ('Dry', 'no room'), ('Room', 'small, close'), ('Stage', 'medium'), ('Hall', 'big, warm'), ('Cathedral', 'huge, long'),
    ("Song's own", 'as saved')])
  echoes = ''.join(f'<button class="room{" sel" if t == "Dotted 8th" else ""}"><b>{t}</b><small>{d}</small></button>' for t, d in [
    ('Off', 'no echo'), ('Slapback', '1 repeat'), ('Quarter', 'on the beat'), ('Dotted 8th', 'worship echo'), ('Trails', 'long, dark')])
  sends = ''
  for i, r in enumerate(m.ALL[:3]):
    c = m.POS_COL[i]
    sends += f'''<div class="sendrow" style="--c:{c}"><span class="sname"><i></i>{r[0]}</span>
      <div class="hfader"><i style="width:{r[3]}%;background:var(--c)"></i><em style="left:{r[3]}%"></em></div><small>{r[3]}%</small>
      <div class="hfader"><i style="width:{r[4]}%;background:var(--c)"></i><em style="left:{r[4]}%"></em></div><small>{r[4]}%</small></div>'''
  return f'''<div class="ipanel" style="--c:var(--fx)"><p class="sent">Everything plays into a <u>Hall</u> with a <u>dotted-8th echo</u> synced to <u>72 bpm</u>.</p>
    <div class="cols fx"><section><h4>Space <small>the room</small></h4><div class="rooms">{rooms}</div>
        {wslider('Size', 'Big', 70, 'small', 'huge')}{wslider('Length', '2.8 s', 55, 'short', 'long')}</section>
      <section><h4>Echo</h4><div class="rooms">{echoes}</div>{wslider('Repeats', '3', 40, 'one', 'many')}
        <div class="hrow"><span class="qb sus lit" style="--c:var(--accent)"><span class="dot"></span><b>Follow tempo</b></span><small style="color:var(--muted)">72 bpm · 312 ms</small></div></section>
      <section><h4>Sends <small>how much of each instrument goes in</small></h4>
        <div class="sendhead"><span></span><span>Space</span><span></span><span>Echo</span><span></span></div>{sends}
        <p class="hint">The same Space and Echo buttons as each strip on Perform.</p></section></div></div>'''


def eq_panel():
  return f'''<div class="ipanel" style="--c:{m.POS_COL[0]}"><div class="ip-h"><span class="ico" style="background:{m.POS_COL[0]}"></span>
    <p class="sent"><b class="sn">Grand Piano</b> · Tone EQ <small>kept from today's Edit, restyled only</small></p><button class="btn">◂ Back</button></div>
    <img class="eqimg" src="img/eq-today.png" alt="Today's Tone EQ: frequency graph with keyboard, band table and cuts"></div>'''


def chooser():
  cats = [('Pianos', 5), ('Electric pianos', 4), ('Organs', 4), ('Pads', 9), ('Strings', 5), ('Synths', 6), ('Bass', 4),
          ('Mallets', 8), ('Guitars & plucks', 6), ('My Samples', 3)]
  cl = ''.join(f'<button class="cat{" on" if c == "Pianos" else ""}">{c}<small>{n}</small></button>' for c, n in cats)
  tiles = ''.join(f'''<button class="tile2{" sel" if t == "Felt Piano" else ""}{" cur" if t == "Grand Piano" else ""}"><b>{t}</b><small>{s}</small>
      <span class="pv" aria-label="Preview {t}">▶</span>{"<em>playing now</em>" if t == "Grand Piano" else ""}</button>''' for t, s in [
    ('Grand Piano', 'sampled · Salamander'), ('Upright Piano', 'sampled · VSCO'), ('Felt Piano', 'sampled · soft'),
    ('Bright Piano', 'sampled'), ('Honky-Tonk Piano', 'sampled'), ('Harpsichord', 'sampled')])
  dlg = f'''<div class="dlg chooser" role="dialog" aria-label="Change instrument"><div class="pop-h">Change instrument <span>for the 1st strip, now Grand Piano</span>
      <div class="bsearch" style="margin-left:auto;width:240px"><span>⌕</span><input placeholder="Search sounds"></div></div>
    <div class="ch-b"><div class="cats">{cl}</div><div class="tiles">{tiles}</div></div>
    <div class="dlgb"><small class="keepnote">Keeps its level, Space and Echo, range and Sustain. Kinds of sound show only here.</small>
      <button class="ghost">Cancel</button><button class="btn savebtn">Use Felt Piano</button></div></div>'''
  return dlg


def frame(main, w=1280, h=800, narrow=False, lib=True, n=3, cls=''):
  return (f'<div class="frame edit {cls}" style="width:{w}px;height:{h}px">{topbar_edit(narrow)}'
          f'<div class="ebody{"" if lib else " nolib"}">{library() if lib else ""}<div class="emain">{song_header()}{main}</div></div>'
          f'{m.bottom(n)}</div>')


def inst_side_body(eq_wide=False):
  # Per-instrument edit, as a sidebar module (Ryan, 2026-11-26): tap a strip's name (or ⋯ › Edit sound).
  c = m.POS_COL[0]
  keys = ''.join(f'<i class="{"in" if 8 <= k <= 44 else ""}"></i>' for k in range(52))
  sound = (wslider('Brightness', 'Bright · 100%', 92, 'darker', 'brighter') + wslider('Warmth', 'Neutral · 0 dB', 50, 'thinner', 'fuller')
           + wslider('Ring-out', 'Natural · 0.12 s', 38, 'short', 'long'))
  eq = ('<img class="eqimg side" src="img/eq-today.png" alt="Tone EQ">' if eq_wide else
        '''<button class="eqcard"><svg viewBox="0 0 120 34" aria-hidden="true"><path d="M0 22 C20 22 30 10 50 14 S80 24 120 18" fill="none" stroke="var(--c)" stroke-width="2"/></svg>
          <span><b>Tone EQ</b><small>2 bands</small></span><em>Widen ▸</em></button>''')
  return f'''<div class="isb" style="--c:{c}"><div class="isb-h"><span class="ico" style="background:{c}"></span><b>Grand Piano</b>
      <button class="btn chgi">Change ▾</button></div>
    <p class="sent sm">Plays on <u>every key</u>, <u>a little</u> into the <u>Hall</u>, sustain <u>on</u>.</p>
    <details class="sec" open><summary>The sound</summary>{sound}</details>
    <details class="sec"{" open" if eq_wide else ""}><summary>Tone EQ <small>2 bands</small></summary>{eq}</details>
    <details class="sec"{"" if eq_wide else " open"}><summary>Where it plays <small>every key · Normal touch</small></summary>
      <div class="mkb">{keys}</div><div class="hrow"><button class="btn grow">Set lowest</button><button class="btn grow">Set highest</button></div>
      <div class="touch"><button class="seg">Light</button><button class="seg sel">Normal</button><button class="seg">Heavy</button><button class="seg">Fixed</button></div></details>
    <details class="sec"><summary>Advanced <small>Width · Transpose · Voices · Pitch bend</small></summary></details></div>'''


def perform_with_inst_side(n=5, width=None, eq_wide=False, w=1280, h=800, narrow=False, port=False):
  m.BODIES['inst'] = lambda wide: inst_side_body(eq_wide)
  mods = [('inst', 'Grand Piano ✕'), ('drone', 'Drone'), ('setlist', 'Setlist'), ('notes', 'Notes')]
  rows = m.ALL[:n]
  strips = ''.join(m.strip(i, r).replace('class="strip"', 'class="strip editing"', 1) if i == 0 else m.strip(i, r)
                   for i, r in enumerate(rows))
  side = m.sidebar(tab='inst', mods=mods, cls='instside', width=width, wide=port)
  if port:
    board = f'<div class="board port mid"><div class="toprow">{m.wheel()}<div class="strips">{strips}{m.addstrip(slim=True)}</div></div>{side}</div>'
    return f'<div class="frame port" style="width:820px;height:1180px">{m.topbar(True)}{m.songbar(True, snap_chip=True)}{board}{m.bottom(n)}</div>'
  dense = ' mid' if n >= 4 else ' few'
  board = f'<div class="board{dense}">{m.wheel()}<div class="strips">{strips}{m.addstrip(slim=n >= 5)}</div>{side}</div>'
  return (f'<div class="frame" style="width:{w}px;height:{h}px">{m.topbar(narrow)}{m.songbar(snap_chip=True)}'
          f'{board}{m.bottom(n)}</div>')


CSS = ''.join(open(f'/home/claude/scratch/{f}').read() for f in
              ('mock_v5.css', 'mock_v6.css', 'mock_chart.css', 'mock_bank.css', 'mock_edit.css'))
frames = [
  ('side', 'Sidebar edit · Perform', perform_with_inst_side()),
  ('sidewide', 'Sidebar edit · EQ, widened', perform_with_inst_side(n=3, width=700, eq_wide=True)),
  ('sideipp', 'Sidebar edit · iPad portrait', perform_with_inst_side(n=3, port=True)),
  ('inst', 'Edit · an instrument', frame(rig_tabs() + instrument_panel())),
  ('fx', 'Edit · Effects', frame(rig_tabs('fx') + fx_panel())),
  ('eq', 'Edit · Tone EQ', frame(rig_tabs() + eq_panel())),
  ('choose', 'Change instrument', frame(rig_tabs() + instrument_panel() + chooser(), cls='dimmed')),
  ('nolib', 'Library folded', frame(rig_tabs(n=5).replace('rtabs', 'rtabs', 1) + instrument_panel(), lib=False, n=5)),
  ('ipp', 'iPad portrait', frame(rig_tabs() + instrument_panel(), 820, 1180, True, lib=False, cls='port')),
  ('today', 'Today (for comparison)', '<img class="todayimg" src="img/edit-today.png" alt="Today\'s Edit view" width="1280" height="800">'),
]


def build():
  tabs = ''.join(f'<button role="tab" data-t="{i}" aria-selected="{str(k == 0).lower()}">{t}</button>'
                 for k, (i, t, _) in enumerate(frames))
  secs = ''.join(f'<section id="{i}" class="{"on" if k == 0 else ""}"><div class="scale">{f}</div></section>'
                 for k, (i, t, f) in enumerate(frames))
  html = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edit mockups</title>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@700;800&family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<header class="pg"><h1>Edit: quick mockups</h1>
<p><b>New first three tabs: editing an instrument in the right sidebar, right on Perform.</b> Tap a strip's name (or ⋯ › Edit sound): it gets a gold outline and the sidebar opens a tab for it with the same sections as Edit (the sound, Tone EQ, where it plays, Advanced). Drag the sidebar wider for the EQ; ✕ closes the tab. Below that, the full Edit screen: Today's Edit, carried into the Perform v6 language. Kept: the library on the left (now foldable), the song header,
the plain-English sentence with tappable words, the three columns (on stage · the sound · where it plays), Advanced and
the Tone EQ. Changed: tabs are named by instrument with their position colour, never Keys / Pad / Extra / Bass (D15);
the "On stage" column is the very same strip as Perform; the keyboard row is Perform's. The instrument chooser is
the one place where kinds of sound appear. Nothing is wired up.</p>
<nav class="tabs" role="tablist">{tabs}</nav></header>
<main>{secs}</main>
<script>{{const tabs=[...document.querySelectorAll('[role=tab]')];
function show(id){{tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===id));document.querySelectorAll('main>section').forEach(s=>s.classList.toggle('on',s.id===id));fit();}}
tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));
function fit(){{document.querySelectorAll('section.on .scale').forEach(sc=>{{const f=sc.firstElementChild;const k=Math.min(1,(sc.clientWidth)/(f.offsetWidth||1280));f.style.transform='scale('+k+')';sc.style.height=((f.offsetHeight||800)*k)+'px';}});}}
new ResizeObserver(fit).observe(document.body);window.addEventListener('load',fit);fit();}}</script></body></html>'''
  os.makedirs(os.path.dirname(OUT), exist_ok=True)
  open(OUT, 'w').write(html)
  print('ok', len(html))


if __name__ == '__main__':
  build()
