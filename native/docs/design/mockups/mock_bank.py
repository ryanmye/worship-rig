# Quick HTML mockups of the Song bank (O-AW-PP bank packs) inside the Perform v6 layout. Not app code.
# Song titles, artists and packs are invented for the mockup.
import os
import mock_v6 as m

OUT = '/home/claude/artifacts/mock-bank/index.html'

BANK = [  # title, artist, key, bpm, time, tags, pack, in library, instruments
  ('Lantern Hymn', 'Northgate Worship', 'Eb', 68, '6/8', ['hymn', 'gentle'], 'Sunday pack', False,
   ['Felt Piano', 'Warm Pad', 'Cello Swell']),
  ('Still Water', 'River Hall', 'D', 72, '4/4', ['ambient', 'communion'], 'Sunday pack', True,
   ['Grand Piano', 'Shimmer Pad']),
  ('Anthem Build', 'Cityline', 'B', 140, '4/4', ['upbeat', 'big'], 'Sunday pack', False,
   ['Grand Piano', 'Synth Lead', 'Sub Bass', 'Strings']),
  ('Quiet Room', 'Ada Moss', 'C', 60, '4/4', ['ambient', 'prayer'], 'Desk sounds', False, ['Rhodes', 'Warm Pad']),
  ('Open Gate', 'Northgate Worship', 'A', 76, '4/4', ['gentle'], 'Sunday pack', False,
   ['Grand Piano', 'Warm Pad', 'Choir']),
  ('Harbour Light', 'River Hall', 'G', 128, '4/4', ['upbeat'], 'Sunday pack', False,
   ['Rhodes', 'Synth Lead', 'Sub Bass']),
  ('Evening Prayer', 'Ada Moss', 'F', 64, '3/4', ['prayer', 'hymn'], 'Desk sounds', True, ['Felt Piano', 'Strings']),
]
COL = {n: m.POS_COL[i % 7] for i, n in enumerate(
  ['Felt Piano', 'Warm Pad', 'Cello Swell', 'Grand Piano', 'Shimmer Pad', 'Synth Lead', 'Sub Bass', 'Strings', 'Rhodes',
   'Choir'])}


def row(b, sel=False):
  t, a, k, bpm, ts, tags, pack, lib, inst = b
  dots = ''.join(f'<i style="background:{COL[n]}"></i>' for n in inst)
  return (f'<button class="br{" sel" if sel else ""}"><span class="bt"><b>{t}{" <span class=badge>In library</span>" if lib else ""}</b><small>{a}</small></span>'
          f'<span class="bdots" title="{len(inst)} instruments">{dots}</span><span class="bkey">{k}</span>'
          f'<span class="bb">{bpm}</span></button>')


def filters(compact=False):
  keys = ''.join(f'<button class="fk{" on" if k == "any" else ""}">{k}</button>' for k in
                 ['any', 'C', 'D', 'Eb', 'F', 'G', 'A', 'B'])
  tags = ''.join(f'<button class="chip ft{""}">{t}</button>' for t in
                 ['gentle', 'ambient', 'hymn', 'prayer', 'communion', 'upbeat', 'big'])
  speed = ''.join(f'<button class="seg{" sel" if s == "Any" else ""}">{s}</button>' for s in ['Any', 'Slow', 'Mid', 'Fast'])
  return f'''<div class="bfil">
    <div class="bsearch"><span>⌕</span><input value="" placeholder="Search title or artist" aria-label="Search the Song bank"></div>
    <div class="fgrp"><span class="lab">Key</span><div class="fkeys">{keys}</div></div>
    <div class="fgrp"><span class="lab">Tempo</span><div class="fspeed">{speed}</div></div>
    <div class="fgrp"><span class="lab">Feel</span><div class="chips">{tags}</div></div>
    <div class="fgrp"><span class="lab">Packs</span><label class="pk"><span class="cb on"></span>Sunday pack<small>5</small></label>
      <label class="pk"><span class="cb on"></span>Desk sounds<small>2</small></label></div></div>'''


def detail(b):
  t, a, k, bpm, ts, tags, pack, lib, inst = b
  strips = ''.join(f'<div class="dstrip" style="--c:{COL[n]}"><i></i>{n}</div>' for n in inst)
  return f'''<div class="bdet"><h3>{t}</h3><p class="by">{a} · from <b>{pack}</b></p>
    <div class="facts"><span><small>Key</small><b>{k}</b></span><span><small>Tempo</small><b>{bpm}</b></span>
      <span><small>Time</small><b>{ts}</b></span><span><small>Snapshots</small><b>3</b></span></div>
    <div class="lab">Instruments</div><div class="dstrips">{strips}</div>
    <div class="lab">Also in this song</div><p class="also">Drone on {k} · Space: Cathedral · Echo: Dotted 8th · chart ✓</p>
    <div class="tags">{''.join(f'<span class="tag">{x}</span>' for x in tags)}</div>
    <div class="bact"><button class="try">▶ Try it<small>play it now; nothing is saved</small></button>
      <button class="btn addlib">Add to library</button><button class="btn">Add to setlist ▾</button></div></div>'''


def browser(sel=0, compact=False):
  rows = ''.join(row(b, i == sel) for i, b in enumerate(BANK))
  return f'''<div class="bank{" compact" if compact else ""}" role="dialog" aria-label="Song bank">
    <div class="bank-h"><b>Song bank</b><small>{len(BANK)} songs from 2 packs in My Samples</small>
      <div class="seg2 sm bview"><button class="on">Song bank</button><button>My library</button></div><button class="qx" aria-label="Close">×</button></div>
    <div class="bank-b">{filters(compact)}<div class="blist"><div class="bhead"><span>Song</span><span></span><span>Key</span><span>BPM</span></div>{rows}</div>
      {detail(BANK[sel])}</div></div>'''


def frame(inner, w=1280, h=800, narrow=False, cls='', n=2, folded=False):
  return (f'<div class="frame {cls}" style="width:{w}px;height:{h}px">{m.topbar(narrow)}{m.songbar(narrow, snap_chip=folded)}'
          f'{inner}{m.bottom(n)}</div>')


def browse(w=1280, h=800, narrow=False):
  # The bank opens over the stage; the keyboard row and PANIC stay live below it.
  board = f'<div class="board dim2">{m.wheel()}{browser()}</div>'
  return frame(board, w, h, narrow)


def trying():
  # "Try it": the song's sound loads as a trial; the banner keeps it or goes back.
  inst = BANK[0][8]
  rows = [(n, d, h, sp, ec, o, s) for n, (d, h, sp, ec, o, s) in zip(inst, [
    ('−3.0', 58, 40, 10, 'normal', True), ('−6.5', 46, 60, 20, 'normal', True), ('−9.0', 38, 55, 0, 'normal', True)])]
  strips = ''.join(m.strip(i, r) for i, r in enumerate(rows))
  ban = '''<div class="trybar"><span class="tdot"></span><b>Trying “Lantern Hymn”</b><small>from the Song bank · Eb · 68 bpm · nothing saved yet</small>
    <button class="btn addlib">Keep it · add to library</button><button class="btn">Add to setlist ▾</button>
    <button class="ghost">Back to Piano + Warm Pad</button></div>'''
  board = (f'<div class="board mid">{m.wheel()}<div class="strips">{strips}{m.addstrip(slim=True)}</div>'
           f'{m.sidebar()}</div>')
  return (f'<div class="frame" style="width:1280px;height:800px">{m.topbar()}'
          f'{m.songbar(snap_chip=True).replace("Piano + Warm Pad</b>", "Lantern Hymn</b>", 1).replace("C ▾", "Eb ▾", 1).replace("SNAPSHOT</span>Piano + Warm Pad<span class=\"edot\" title=\"edited since saved\"></span>", "SNAPSHOT</span>Verse", 1)}'
          f'{ban}{board.replace('class="k sel">C<', 'class="k">C<', 1).replace('class="k">Eb<', 'class="k sel">Eb<', 1)}{m.bottom(3)}</div>')


def setlist_add():
  # Entry points: the Setlist module's "+ Add song" menu.
  menu = '''<div class="pop addmenu" role="menu" aria-label="Add a song"><div class="pop-h">Add a song <span>to My Set</span></div>
    <button class="mi"><b>From my library</b><small>songs you already have</small></button>
    <button class="mi hi"><b>From the Song bank</b><small>7 ready-made songs from your packs</small></button>
    <button class="mi"><b>New song</b><small>starts from what you’re playing now</small></button></div>'''
  side = m.sidebar(tab='setlist').replace('<div class="d-row"><button class="qb"><b>◀ Prev</b>',
                                          f'<button class="addsong">+ Add song</button>{menu}<div class="d-row"><button class="qb"><b>◀ Prev</b>', 1)
  strips = ''.join(m.strip(i, r) for i, r in enumerate(m.ALL[:3]))
  board = f'<div class="board mid">{m.wheel()}<div class="strips">{strips}{m.addstrip(slim=True)}</div>{side}</div>'
  return frame(m.snaps() + board, n=3)


def ipad_portrait():
  board = f'<div class="board port dim2">{browser(compact=True)}</div>'
  return frame(board, 820, 1180, True, 'port')


CSS = ''.join(open(f'/home/claude/scratch/{f}').read() for f in ('mock_v5.css', 'mock_v6.css', 'mock_chart.css', 'mock_bank.css'))
frames = [
  ('browse', 'Browse the bank', browse()),
  ('trying', 'Trying a song', trying()),
  ('entry', 'Setlist › Add song', setlist_add()),
  ('ipl', 'iPad landscape', browse(1180, 820, True)),
  ('ipp', 'iPad portrait', ipad_portrait()),
]


def build():
  tabs = ''.join(f'<button role="tab" data-t="{i}" aria-selected="{str(k == 0).lower()}">{t}</button>'
                 for k, (i, t, _) in enumerate(frames))
  secs = ''.join(f'<section id="{i}" class="{"on" if k == 0 else ""}"><div class="scale">{f}</div></section>'
                 for k, (i, t, f) in enumerate(frames))
  html = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Song bank mockups</title>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@700;800&family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<header class="pg"><h1>Song bank: quick mockups</h1>
<p>The Song bank lists ready-made song setups from your bank packs in My Samples (today it is a plain list in
Settings). Here it opens over the stage while the keyboard and PANIC stay live: filter by key, tempo, feel and pack,
see what a song holds, then <b>Try it</b> (it plays straight away and nothing is saved; a banner keeps it or goes back),
<b>Add to library</b> or <b>Add to setlist</b>. It opens from the Setlist's “+ Add song”. Titles, artists and packs are
made up. Nothing is wired up.</p>
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
