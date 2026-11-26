# Quick HTML mockups of the chart view (D7, 2.1) inside the Perform v6 layout. Not app code.
# The song and its lyrics are invented for the mockup.
import os
import mock_v6 as m

OUT = '/home/claude/artifacts/mock-chart/index.html'

SONG = [  # (section, [lines]); a line is a list of (chord, text) segments
  ('Intro', None, [[('G', '    '), ('D/F#', '    '), ('Em', '    '), ('C', '    ')]]),
  ('Verse 1', 'V1', [
    [('G', 'Morning light breaks '), ('D/F#', 'over the hill')],
    [('Em', 'You were here be'), ('C', 'fore I woke')],
    [('G', 'Every breath I '), ('D/F#', 'take is still')],
    [('Em', 'held in the '), ('C', 'words you spoke')]]),
  ('Chorus', 'C', [
    [('C', 'Hallelujah, '), ('G', 'You are near')],
    [('D', 'Steady my heart, '), ('Em', 'quiet my fear')],
    [('C', 'Hallelujah, '), ('G', 'You remain')],
    [('D', 'Over the '), ('C', 'storm and the '), ('G', 'rain')]]),
  ('Verse 2', 'V2', [
    [('G', 'When the evening '), ('D/F#', 'settles in')],
    [('Em', 'and the road is '), ('C', 'long and grey')],
    [('G', 'You are where the '), ('D/F#', 'light begins')],
    [('Em', 'You are '), ('C', 'with me all the way')]]),
  ('Bridge', 'B', [
    [('Em', 'Nothing can '), ('C', 'move me')],
    [('G', 'nothing can '), ('D', 'shake')],
    [('Em', 'what you have '), ('C', 'spoken')],
    [('G', 'You will not '), ('D', 'break')]]),
]
JUMPS = ['Intro', 'V1', 'C', 'V2', 'C', 'B', 'C']


# Written in G; the song is in C, so Heard shows it moved up a 4th (Easy Transpose follows the song's key).
TO_C = {'G': 'C', 'D/F#': 'G/B', 'Em': 'Am', 'C': 'F', 'D': 'G'}


def sheet(cur=('Chorus', 1)):
  out = ''
  for name, short, lines in SONG:
    rows = ''
    for li, line in enumerate(lines):
      segs = ''.join(f'<span class="cs"><span class="ch">{TO_C.get(c, c)}</span><span class="ly">{t}</span></span>' for c, t in line)
      rows += f'<div class="cl{" now" if (name, li) == cur else ""}">{segs}</div>'
    out += f'<section class="csec{" cur" if name == cur[0] else ""}"><h5>{name}</h5>{rows}</section>'
  return out


def chart_head(compact=False, mode='hear', where='stage', fs=28):
  jumps = ''.join(f'<button class="jp{" on" if i == 2 else ""}">{j}</button>' for i, j in enumerate(JUMPS))
  return f'''<div class="chh">
    <div class="cht"><b>Morning Light</b><small><em>Key C</em> · written in G · 72 bpm · 4/4</small></div>
    <div class="chgrp"><div class="seg2 sm"><button class="{"on" if mode == "hear" else ""}">Heard</button><button class="{"on" if mode == "play" else ""}">Hands</button></div>
      <div class="tsize" role="group" aria-label="Text size"><button class="ts-b sm-a" aria-label="Smaller text">A</button><b class="ts-n">{fs}</b>
        <button class="ts-b big-a" aria-label="Bigger text">A</button><button class="ts-fit" title="Biggest size where the longest line still fits">Fit</button></div>{'' if compact else '<button class="ghost">Edit chart…</button>'}
      <button class="ghost place" title="Choose where the chart shows; it remembers per device">{'⇥ Sidebar' if where == 'stage' else '⤢ Stage'}</button></div>
    <div class="chs"><button class="play">▶ Scroll</button><button class="sq sm">−</button><b>1.0×</b><button class="sq sm">+</button></div>
    <div class="jumps">{jumps}</div></div>'''


def chart_panel(size='m', compact=False, mode='hear', where='stage', fs=None, toast=False):
  fs = fs or {'s': 17, 'm': 24, 'l': 28}[size]
  t = (f'<div class="ts-toast">Text {fs} · pinch, ⌘+ / ⌘−, or ⌘-scroll</div>' if toast else '')
  return f'''<div class="chart sz-{size}">{chart_head(compact, mode, where, fs)}<div class="sheet" style="--fs:{fs}px">{t}{sheet()}<div class="readline" title="auto-scroll reading line"></div></div></div>'''


def mini_strips(n):
  out = ''
  for i, r in enumerate(m.ALL[:n]):
    name, db, h = r[0], r[1], r[2]
    c = m.POS_COL[i]
    out += f'''<div class="mini" style="--c:{c}"><button class="mon"><span class="dot"></span></button>
      <div class="fwrap"><div class="ftrack"><i style="height:{h}%"></i><em style="bottom:{h}%"></em></div></div>
      <small class="mdb">{db}</small><span class="mnm">{name}</span></div>'''
  return f'<div class="minis">{out}</div>'


def frame(inner, w=1280, h=800, narrow=False, cls=''):
  return f'<div class="frame {cls}" style="width:{w}px;height:{h}px">{m.topbar(narrow)}{m.songbar(narrow)}{inner}{m.bottom(3)}</div>'


MODS = [('drone', 'Drone'), ('setlist', 'Setlist'), ('chart', 'Chart'), ('notes', 'Notes')]


def beside(width=None, size='s', n=3):
  # A: the chart is a sidebar module; the sidebar widens while Chart is the open tab.
  m.BODIES['chart'] = lambda wide: chart_panel(size, compact=True, where='side')
  rows = m.ALL[:n]
  strips = ''.join(m.strip(i, r) for i, r in enumerate(rows))
  board = (f'<div class="board mid">{m.wheel()}<div class="strips">{strips}{m.addstrip(slim=True)}</div>'
           f'{m.sidebar(tab="chart", mods=MODS, cls="chartw", width=width)}</div>')
  return frame(m.snaps() + board)


def stage_mode(w=1280, h=800, narrow=False, fs=None, toast=False):
  # B: the chart takes the stage; the strips shrink to mini faders (still live), the sidebar folds to its rail.
  board = (f'<div class="board">{m.wheel()}{mini_strips(3)}{chart_panel("l", fs=fs, toast=toast)}'
           f'{m.sidebar(collapsed=True, mods=MODS, active="chart")}</div>')
  return frame(board, w, h, narrow)


def ipad_portrait(fs=None, toast=False):
  board = (f'<div class="board port chartport"><div class="toprow">{mini_strips(3).replace("minis", "minis row")}'
           f'<button class="backto">▤ Strips</button></div>{chart_panel("l", fs=fs, toast=toast)}</div>')
  return frame(board, 820, 1180, True, 'port')


def add_dialog():
  offers = ''.join(f'<label class="offer"><span class="cb{" on" if on else ""}"></span>{t}<small>{sub}</small></label>'
                   for t, sub, on in [('Set the song’s key to G', 'the song is in C now', False),
                                      ('Set tempo to 72 bpm', 'none set now', True),
                                      ('Set time to 4/4', 'none set now', True)])
  dlg = f'''<div class="dlg" role="dialog" aria-label="Add chart"><div class="pop-h">Add a chart <span>to “Piano + Warm Pad”</span></div>
    <div class="srcrow"><button class="seg sel">Paste text</button><button class="seg">Choose file…</button><small>ChordPro, WorshipTools, OnSong or plain chords over words</small></div>
    <div class="paste"><pre>{{title: Morning Light}}
{{key: G}}
{{tempo: 72}}
[G]Morning light breaks [D/F#]over the hill
[Em]You were here be[C]fore I woke …</pre></div>
    <div class="found"><b>Found:</b> 5 sections · 21 lines · key G · 72 bpm · 4/4 <span class="warn1">1 line skipped: “x2” read as a note</span></div>
    <div class="offers"><span class="lab">Also update the song?</span>{offers}</div>
    <div class="dlgb"><button class="ghost">Cancel</button><button class="btn savebtn">Save chart</button></div></div>'''
  board = f'<div class="board dim">{m.wheel()}{mini_strips(3)}{chart_panel("l")}{dlg}</div>'
  return frame(board)


CSS = open('/home/claude/scratch/mock_v5.css').read() + open('/home/claude/scratch/mock_v6.css').read() + open(
  '/home/claude/scratch/mock_chart.css').read()
frames = [
  ('stage', 'Chart takes the stage', stage_mode()),
  ('beside', 'Chart in the sidebar', beside()),
  ('wide', 'Sidebar dragged wider', beside(width=780, size='m', n=2)),
  ('big', 'Text made bigger', stage_mode(fs=40, toast=True)),
  ('ipl', 'iPad landscape', stage_mode(1180, 820, True)),
  ('ipp', 'iPad portrait (music stand)', ipad_portrait()),
  ('ippbig', 'iPad portrait · pinched bigger', ipad_portrait(fs=40, toast=True)),
  ('add', 'Add a chart', add_dialog()),
]


def build():
  tabs = ''.join(f'<button role="tab" data-t="{i}" aria-selected="{str(k == 0).lower()}">{t}</button>'
                 for k, (i, t, _) in enumerate(frames))
  secs = ''.join(f'<section id="{i}" class="{"on" if k == 0 else ""}"><div class="scale">{f}</div></section>'
                 for k, (i, t, f) in enumerate(frames))
  html = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chart view mockups</title>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@700;800&family=Figtree:wght@400;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<header class="pg"><h1>Chart view: quick mockups</h1>
<p>The chord chart (D7, ships in 2.1) inside the Perform v6 layout. You choose where it goes, per device: on the stage, while the instruments shrink to live mini faders (⇥ Sidebar moves it),
or as a tab in the right sidebar (⤢ Stage moves it back). The sidebar is resizable: drag its left edge (try it in the
sidebar tabs); dragging it very narrow folds it to the icon rail. Chords follow the song's key: this chart was written in G and the song is in C, so it shows in C. <b>Heard</b> shows the key
the band hears, <b>Hands</b> the key your hands play when Easy Transpose is on. Text size is one tap away: the small and big <b>A</b> buttons step through 16–56, <b>Fit</b> picks the biggest size
where the longest line still fits, and pinch, ⌘+ / ⌘− or ⌘-scroll work on the chart itself. Each device remembers its
own size. The gold line is where auto-scroll reads; the section buttons jump. The song and words are made up for the mockup. Nothing is wired up.</p>
<nav class="tabs" role="tablist">{tabs}</nav></header>
<main>{secs}</main>
<script>{{const tabs=[...document.querySelectorAll('[role=tab]')];
function show(id){{tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===id));document.querySelectorAll('main>section').forEach(s=>s.classList.toggle('on',s.id===id));fit();}}
tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));
function fit(){{document.querySelectorAll('section.on .scale').forEach(sc=>{{const f=sc.firstElementChild;const k=Math.min(1,(sc.clientWidth)/f.offsetWidth);f.style.transform='scale('+k+')';sc.style.height=(f.offsetHeight*k)+'px';}});}}
{m.RESIZE_JS}new ResizeObserver(fit).observe(document.body);fit();}}</script></body></html>'''
  os.makedirs(os.path.dirname(OUT), exist_ok=True)
  open(OUT, 'w').write(html)
  print('ok', len(html))


if __name__ == '__main__':
  build()
