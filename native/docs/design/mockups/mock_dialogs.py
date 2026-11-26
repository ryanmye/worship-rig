# Quick HTML mockups: MIDI Learn on Perform, Arrange, and the small dialogs. Not app code.
import os
import mock_v6 as m
import mock_chart as ch

OUT = '/home/claude/artifacts/mock-dialogs/index.html'


def perform(inner_board, banner='', w=1280, h=800, folded=True, n=3, extra=''):
  return (f'<div class="frame" style="width:{w}px;height:{h}px;position:relative">{m.topbar()}{m.songbar(snap_chip=folded)}'
          f'{banner}{inner_board}{m.bottom(n)}{extra}</div>')


def strips(n=3, mark=None):
  out = ''
  for i, r in enumerate(m.ALL[:n]):
    s = m.strip(i, r)
    if mark:
      s = mark(i, r, s)
    out += s
  return out


def learn():
  # Learn mode: every learnable control gets a dashed outline; learned ones carry a small badge.
  def mark(i, r, s):
    s = s.replace('<div class="fwrap">', f'<div class="fwrap learnable{" picked2" if i == 1 else ""}">'
                  + ('<span class="lbadge">K1</span>' if i == 1 else ''), 1)
    s = s.replace('<button class="qb send">', '<button class="qb send learnable">', 2)
    return s
  ban = '''<div class="learnbar"><span class="tdot"></span><b>Learning</b><span class="step on">1 · Move a knob, fader or pad</span>
    <span class="step done">Knob 3 moved ✓</span><span class="step on">2 · Tap what it should change</span>
    <small>Dashed = can be learned · K1 = already learned</small><button class="btn">Done</button></div>'''
  board = f'<div class="board mid">{m.wheel()}<div class="strips">{strips(3, mark)}{m.addstrip(slim=True)}</div>{m.sidebar()}</div>'
  toast = '<div class="ltoast">Knob 3 → <b>Warm Pad level</b> ✓ · moves are live; Revert undoes them</div>'
  return perform(board, ban, extra=toast)


def arrange():
  def mark(i, r, s):
    return s.replace('<div class="s-name">', '<div class="arrbar"><span class="grip2">⠿ drag</span><button class="ab">◀</button><button class="ab">▶</button><button class="ab x">✕</button></div><div class="s-name">', 1)
  ban = '''<div class="learnbar arr"><b>Arrange</b><small>Drag a strip or a sidebar tab to move it · colours follow the position · ✕ removes (hold)</small>
    <button class="btn savebtn">Done</button></div>'''
  side = m.sidebar().replace('<div class="sbtabs">', '<div class="sbtabs arrtabs">', 1)
  board = f'<div class="board mid arranging">{m.wheel()}<div class="strips">{strips(3, mark)}{m.addstrip(slim=True)}</div>{side}</div>'
  return perform(board, ban)


def save_snapshot():
  inc = ''.join(f'<label class="offer"><span class="cb on"></span>{t}<small>{s}</small></label>' for t, s in [
    ('Instruments', 'which are on, levels, Space / Echo, octave, sustain'), ('Drone', 'on, C major, −6 dB'),
    ('Space & Echo', 'Hall, dotted 8th')])
  dlg = f'''<div class="dlg" role="dialog" aria-label="Save snapshot"><div class="pop-h">Save snapshot <span>a sound you can bring back with one tap</span></div>
    <div class="namebox"><input value="Piano + Pad, warmer" aria-label="Snapshot name"><small>Suggested from what changed</small></div>
    <div class="offers"><span class="lab">It keeps</span>{inc}</div>
    <div class="dlgb"><button class="ghost">Cancel</button><button class="btn">Update “Piano + Warm Pad”</button><button class="btn savebtn">Save as new</button></div></div>'''
  board = f'<div class="board mid dim">{m.wheel()}<div class="strips">{strips()}</div>{m.sidebar()}{dlg}</div>'
  return perform(board, m.snaps(), folded=False)


def song_menu():
  menu = '''<div class="pop songmenu" role="menu" aria-label="Song"><div class="pop-h">Piano + Warm Pad <span>song</span></div>
    <button class="mi"><b>Rename…</b></button><button class="mi"><b>Duplicate</b><small>a copy to change freely</small></button>
    <button class="mi"><b>Add to setlist ▸</b><small>My Set, Sunday 12/1</small></button>
    <button class="mi"><b>Export this song…</b><small>one file, to share or keep</small></button>
    <button class="mi"><b>Reset to as saved</b><small>same as Revert</small></button>
    <button class="mi warn2"><b>Delete (hold)</b><small>a backup is kept</small></button></div>'''
  board = f'<div class="board mid">{m.wheel()}<div class="strips">{strips()}{m.addstrip(slim=True)}</div>{m.sidebar()}</div>'
  sb = m.songbar(snap_chip=True).replace('<b class="song">Piano + Warm Pad</b>', '<b class="song">Piano + Warm Pad</b><button class="btn act2">⋯</button>', 1)
  return (f'<div class="frame" style="width:1280px;height:800px;position:relative">{m.topbar()}{sb}{board}{m.bottom(3)}{menu}</div>')


def chart_editor():
  src = '''{title: Morning Light}
{key: G}
{tempo: 72}

{start_of_verse: Verse 1}
[G]Morning light breaks [D/F#]over the hill
[Em]You were here be[C]fore I woke
{end_of_verse}

{start_of_chorus}
[C]Hallelujah, [G]You are near
[D]Steady my heart, [Em]quiet my fear
{end_of_chorus}'''
  dlg = f'''<div class="dlg cedit" role="dialog" aria-label="Edit chart"><div class="pop-h">Edit chart <span>Morning Light · changes show on the right as you type</span></div>
    <div class="ce-b"><div class="ce-src"><div class="ce-tools"><button class="seg sel">ChordPro</button><button class="seg">Chords over words</button>
      <button class="ghost">Insert section ▾</button><button class="ghost">Paste…</button></div><pre contenteditable="true">{src}</pre></div>
      <div class="ce-prev">{ch.chart_panel("s", compact=True, where="side")}</div></div>
    <div class="dlgb"><small class="keepnote">Written in G · shown in C (the song’s key) · 0 problems</small><button class="ghost">Cancel</button><button class="btn savebtn">Save chart</button></div></div>'''
  board = f'<div class="board dim">{m.wheel()}{ch.mini_strips(3)}{ch.chart_panel("l")}{dlg}</div>'
  return perform(board, '', folded=True)


CSS = ''.join(open(f'/home/claude/scratch/{f}').read() for f in
              ('mock_v5.css', 'mock_v6.css', 'mock_chart.css', 'mock_bank.css', 'mock_edit.css', 'mock_settings.css', 'mock_dialogs.css'))
frames = [('learn', 'MIDI Learn on Perform', learn()), ('arrange', 'Arrange', arrange()),
          ('snap', 'Save snapshot', save_snapshot()), ('song', 'Song menu (⋯)', song_menu()),
          ('chartedit', 'Edit chart', chart_editor())]


def build():
  tabs = ''.join(f'<button role="tab" data-t="{i}" aria-selected="{str(k == 0).lower()}">{t}</button>'
                 for k, (i, t, _) in enumerate(frames))
  secs = ''.join(f'<section id="{i}" class="{"on" if k == 0 else ""}"><div class="scale">{f}</div></section>'
                 for k, (i, t, f) in enumerate(frames))
  html = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MIDI Learn, Arrange and dialogs</title>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@700;800&family=Figtree:wght@400;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<header class="pg"><h1>MIDI Learn, Arrange and the small dialogs</h1>
<p><b>MIDI Learn</b> happens on Perform: tap Learn (Settings › MIDI Learn, or ⋯ on any control), move a knob, then tap
what it should change; dashed outlines show what can be learned, small badges show what already is. <b>Arrange</b>
puts handles on the strips and the sidebar tabs. <b>Save snapshot</b>, the <b>Song menu</b> and <b>Edit chart</b> (text on
the left, the chart live on the right) are the small dialogs. Rule from Settings: easy to navigate and use. Nothing is
wired up.</p>
<nav class="tabs" role="tablist">{tabs}</nav></header>
<main>{secs}</main>
<script>{{const tabs=[...document.querySelectorAll('[role=tab]')];
function show(id){{tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===id));document.querySelectorAll('main>section').forEach(s=>s.classList.toggle('on',s.id===id));fit();}}
tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));
function fit(){{document.querySelectorAll('section.on .scale').forEach(sc=>{{const f=sc.firstElementChild;const k=Math.min(1,(sc.clientWidth)/f.offsetWidth);f.style.transform='scale('+k+')';sc.style.height=(f.offsetHeight*k)+'px';}});}}
{m.RESIZE_JS}{m.RANGE_JS}new ResizeObserver(fit).observe(document.body);fit();}}</script></body></html>'''
  os.makedirs(os.path.dirname(OUT), exist_ok=True)
  open(OUT, 'w').write(html)
  print('ok', len(html))


if __name__ == '__main__':
  build()
