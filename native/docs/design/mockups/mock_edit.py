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
  return '''<div class="eh"><span class="live"><i></i>LIVE</span><b class="song">Piano + Warm Pad</b><button class="ghost pen" aria-label="Rename">✎</button>
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


CATS = [('sound', 'Sound', 'Bright · Neutral · Natural', False), ('eq', 'Tone EQ', '2 bands', True),
        ('range', 'Range', 'every key · A0–C8', False), ('touch', 'Touch', 'Normal', False),
        ('sustain', 'Sustain', 'pedal holds · 0.1 s', False), ('sends', 'Space & Echo', '45% · 10%', True),
        ('adv', 'Advanced', 'Width 100% · Transpose 0', False)]


def cat_content(sec):
  keys = ''.join(f'<i class="{"in" if 8 <= k <= 44 else ""}"></i>' for k in range(52))
  if sec == 'sound':
    return ('<h4>Sound <small>how this instrument itself sounds</small></h4>'
            + wslider('Brightness', 'Bright · 100%', 92, 'darker', 'brighter') + wslider('Warmth', 'Neutral · 0 dB', 50, 'thinner', 'fuller')
            + wslider('Ring-out', 'Natural · 0.12 s', 38, 'short', 'long'))
  if sec == 'eq':
    return '<h4>Tone EQ <small>2 bands · drag a point, or double-tap to add one</small></h4><img class="eqimg" src="img/eq-today.png" alt="Tone EQ">'
  if sec == 'range':
    return (f'<h4>Range <small>which keys play it · drag the ends of the colour, or set by playing</small></h4>{m.range_kbd("Grand Piano", m.POS_COL[0])}'
            '<div class="hrow"><button class="sel-box">A0</button><span>to</span><button class="sel-box">C8</button><button class="btn">Whole keyboard</button></div>'
            '<div class="hrow"><button class="btn grow">Set lowest by playing</button><button class="btn grow">Set highest by playing</button></div>'
            '<div class="hrow"><span class="lab">Octave</span><button class="sq">−</button><b>0</b><button class="sq">+</button></div>')
  return '<h4>…</h4>'


def instrument_panel_nav(sec='sound'):
  # Each instrument's edit gets a short category list on its left, so it is clear what is being edited
  # (Ryan, 2026-11-26). The strip stays on the right.
  c = m.POS_COL[0]
  nav = ''.join(f'''<button class="cn{" on" if k == sec else ""}"><b>{lab}{"<span class=cd2></span>" if chg else ""}</b><small>{sub}</small></button>'''
                for k, lab, sub, chg in CATS)
  sentence = ('<p class="sent"><b class="sn">Grand Piano</b> plays on <u>every key</u>, <u>a little</u> into the '
              '<u>Hall</u>, with sustain <u>on</u>.</p>')
  return f'''<div class="ipanel" style="--c:{c}"><div class="ip-h"><span class="ico" style="background:{c}"></span>{sentence}
      <button class="btn chgi">Change instrument ▾</button></div>
    <div class="ncols"><nav class="cnav" aria-label="What to edit">{nav}</nav><section class="ccont">{cat_content(sec)}</section>
      <section class="col1"><h4>On stage</h4>{m.strip(0, m.ALL[0])}</section></div></div>'''


def nav_panel(color, sentence, cats, sel, content, right=''):
  # The same category-list pattern as an instrument (D18), for Drone, Effects and Master.
  nav = ''.join(f'''<button class="cn{" on" if k == sel else ""}"><b>{lab}{"<span class=cd2></span>" if chg else ""}</b><small>{sub}</small></button>'''
                for k, lab, sub, chg in cats)
  cols = 'ncols' + ('' if right else ' noright')
  return f'''<div class="ipanel" style="--c:{color}"><div class="ip-h"><span class="ico" style="background:{color}"></span>{sentence}</div>
    <div class="{cols}"><nav class="cnav" aria-label="What to edit">{nav}</nav><section class="ccont">{content}</section>{right}</div></div>'''


FX_CATS = [('space', 'Space', 'Hall · big, warm', False), ('echo', 'Echo', 'Dotted 8th · 72 bpm', True),
           ('sends', 'Sends', 'how much of each goes in', False)]


def fx_nav(sec):
  sent = '<p class="sent">Everything plays into a <u>Hall</u> with a <u>dotted-8th echo</u> synced to <u>72 bpm</u>.</p>'
  rooms = lambda items, cur: ''.join(f'<button class="room{" sel" if t == cur else ""}"><b>{t}</b><small>{d}</small></button>' for t, d in items)
  if sec == 'space':
    c = ('<h4>Space <small>the room everything plays in</small></h4><div class="rooms">' + rooms([
      ('Dry', 'no room'), ('Room', 'small, close'), ('Stage', 'medium'), ('Hall', 'big, warm'), ('Cathedral', 'huge, long'),
      ("Song's own", 'as saved')], 'Hall') + '</div>' + wslider('Size', 'Big', 70, 'small', 'huge')
      + wslider('Length', '2.8 s', 55, 'short', 'long') + wslider('Brightness', 'Warm', 35, 'dark', 'bright'))
  elif sec == 'echo':
    c = ('<h4>Echo</h4><div class="rooms">' + rooms([('Off', 'no echo'), ('Slapback', '1 repeat'), ('Quarter', 'on the beat'),
      ('Dotted 8th', 'worship echo'), ('Trails', 'long, dark')], 'Dotted 8th') + '</div>'
      + wslider('Repeats', '3', 40, 'one', 'many') + wslider('Tone', 'Dark', 30, 'dark', 'bright')
      + '<div class="hrow"><span class="qb sus lit" style="--c:var(--accent)"><span class="dot"></span><b>Follow tempo</b></span><small style="color:var(--muted)">72 bpm · 312 ms</small></div>')
  else:
    sends = ''
    for i, r in enumerate(m.ALL[:3]):
      col = m.POS_COL[i]
      sends += f'''<div class="sendrow" style="--c:{col}"><span class="sname"><i></i>{r[0]}</span>
        <div class="hfader"><i style="width:{r[3]}%;background:var(--c)"></i><em style="left:{r[3]}%"></em></div><small>{r[3]}%</small>
        <div class="hfader"><i style="width:{r[4]}%;background:var(--c)"></i><em style="left:{r[4]}%"></em></div><small>{r[4]}%</small></div>'''
    c = ('<h4>Sends <small>how much of each instrument goes into Space and Echo</small></h4>'
         '<div class="sendhead"><span></span><span>Space</span><span></span><span>Echo</span><span></span></div>' + sends
         + '<p class="hint">The same Space and Echo buttons as each strip on Perform.</p>')
  return nav_panel('var(--fx)', sent, FX_CATS, sec, c)


DRONE_CATS = [('drone', 'Key & sound', 'C major · Synth', False), ('pads', 'My Pads', 'no folder yet', False),
              ('behave', 'Behaviour', 'keeps across songs · 4 s fade', True)]


def drone_nav(sec):
  sent = '<p class="sent">A <u>C major</u> drone from the <u>synth</u> at <u>−6 dB</u>, kept across songs.</p>'
  if sec == 'drone':
    c = '<h4>Key &amp; sound <small>the same Drone module as Perform’s sidebar</small></h4>' + m.drone(wide=True)
  elif sec == 'pads':
    c = ('<h4>My Pads <small>your own pad recordings, one per key</small></h4><p class="hint">No pad folder yet; the built-in synth drone plays.</p>'
         '<div class="hrow"><button class="btn">Choose folder…</button><button class="ghost">How to name the files</button></div>')
  else:
    c = ('<h4>Behaviour</h4>' + wslider('Fade in / out', '4 s', 40, 'quick', 'slow')
         + '<div class="hrow"><span class="qb sus lit" style="--c:var(--drone)"><span class="dot"></span><b>Keep across songs</b></span>'
           '<span class="qb sus lit" style="--c:var(--drone)"><span class="dot"></span><b>Follow the song key</b></span></div>')
  return nav_panel('var(--drone)', sent, DRONE_CATS, sec, c)


MASTER_CATS = [('vol', 'Volume & output', '−6.0 dB · Built-in output', False), ('meq', 'Master EQ', 'flat', False),
               ('comp', 'Glue', 'gentle', False), ('wheels', 'Wheels & pedal', 'wheel → Warm Pad level', True)]


def master_nav(sec):
  sent = '<p class="sent">Everything comes out at <u>−6 dB</u> through the <u>built-in output</u>, with <u>gentle</u> glue.</p>'
  if sec == 'vol':
    c = ('<h4>Volume &amp; output</h4>' + wslider('Master volume', '−6.0 dB', 68, 'quiet', 'loud')
         + '<div class="hrow"><span class="lab">Output</span><button class="sel-box">Built-in output ▾</button><small style="color:var(--muted)">42 ms</small></div>'
         + '<div class="hrow"><span class="qb sus lit" style="--c:var(--accent)"><span class="dot"></span><b>Safety limiter</b></span><small style="color:var(--muted)">stops sudden loud peaks</small></div>')
  elif sec == 'wheels':
    c = ('<h4>Wheels &amp; pedal <small>what your keyboard’s wheel and pedal do in this song</small></h4>'
         '<div class="hrow"><span class="lab">Mod wheel</span><button class="sel-box">→ Warm Pad level ▾</button></div>'
         + wslider('Swell time', '8 s', 45, 'quick', 'slow')
         + '<div class="hrow"><span class="lab">Pitch wheel</span><button class="sel-box">Off ▾</button></div>'
         '<div class="hrow"><span class="lab">Sustain pedal</span><span class="lamp"></span><small style="color:var(--muted)">up</small><button class="ghost">Reversed: off</button></div>'
         '<p class="hint">Which instruments the pedal holds is each strip’s Sustain button.</p>')
  else:
    c = '<h4>…</h4>'
  return nav_panel('var(--label)', sent, MASTER_CATS, sec, c)


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


CSS = ''.join(open(f'/home/claude/scratch/{f}').read() for f in
              ('mock_v5.css', 'mock_v6.css', 'mock_chart.css', 'mock_bank.css', 'mock_edit.css'))
frames = [
  ('nav', 'Instrument · Sound', frame(rig_tabs() + instrument_panel_nav('sound'))),
  ('naveq', 'Instrument · Tone EQ', frame(rig_tabs() + instrument_panel_nav('eq'))),
  ('navrange', 'Instrument · Range', frame(rig_tabs() + instrument_panel_nav('range'))),
  ('navipp', 'Instrument · iPad portrait', frame(rig_tabs() + instrument_panel_nav('sound'), 820, 1180, True, lib=False, cls='port')),
  ('fxspace', 'Effects · Space', frame(rig_tabs('fx') + fx_nav('space'))),
  ('fxsends', 'Effects · Sends', frame(rig_tabs('fx') + fx_nav('sends'))),
  ('drone', 'Drone', frame(rig_tabs('drone') + drone_nav('drone'))),
  ('master', 'Master · Wheels & pedal', frame(rig_tabs('master') + master_nav('wheels'))),
  ('mastervol', 'Master · Volume & output', frame(rig_tabs('master') + master_nav('vol'))),
  ('inst', 'Earlier: three columns', frame(rig_tabs() + instrument_panel())),
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
<p><b>New:</b> each instrument's edit has a short list of categories on its left (Sound, Tone EQ, Range, Touch, Sustain, Space &amp; Echo, Advanced), each with its current setting; Drone, Effects and Master use the same pattern, under the name and a dot when it changed; the chosen one fills the middle, the strip stays on the right. The earlier three-column version is kept as a tab. Today's Edit, carried into the Perform v6 language. Kept: the library on the left (now foldable), the song header,
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
{m.RANGE_JS}new ResizeObserver(fit).observe(document.body);window.addEventListener('load',fit);fit();}}</script></body></html>'''
  os.makedirs(os.path.dirname(OUT), exist_ok=True)
  open(OUT, 'w').write(html)
  print('ok', len(html))


if __name__ == '__main__':
  build()
