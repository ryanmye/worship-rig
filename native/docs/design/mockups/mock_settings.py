# Quick HTML mockups of Settings in the v6 language (category list with summaries, D18). Not app code.
import json
import os
import mock_v6 as m

OUT = '/home/claude/artifacts/mock-settings/index.html'
THEMES = json.load(open('/home/claude/scratch/themes.json'))

CATS = [('sound', 'Sound', 'Built-in output · 42 ms'), ('keys', 'Keyboards & MIDI', 'Keystation 49 · Normal touch'),
        ('learn', 'MIDI Learn', '3 controls learned'), ('samples', 'Sounds & Samples', '2 packs · 7 bank songs'),
        ('layout', 'Perform layout', 'sidebar open · snapshots shown'), ('look', 'Look', 'Sanctuary · Auto'),
        ('library', 'Library & Backup', 'backed up 2 min ago'), ('mac', 'Mac', 'menu bar · updates'),
        ('about', 'About', '2.0')]


def seg(opts, cur):
  return '<div class="seg2 st">' + ''.join(f'<button class="{"on" if o == cur else ""}">{o}</button>' for o in opts) + '</div>'


def row(label, hint, ctl):
  return f'<div class="srow"><div class="slb"><b>{label}</b>{f"<small>{hint}</small>" if hint else ""}</div><div class="sc">{ctl}</div></div>'


def card(title, body):
  return f'<section class="scard"><h4>{title}</h4>{body}</section>'


def toggle(on, label=''):
  return f'<span class="tgl{" on" if on else ""}"><i></i></span>{label}'


def content(cat):
  if cat == 'sound':
    return (card('Audio', row('Output', 'where the sound goes', '<button class="sel-box">Built-in output ▾</button>')
                 + row('Latency', 'lower is snappier; raise it if you hear crackles', seg(['Lowest', 'Balanced', 'Safe'], 'Balanced') + '<small class="ok2">42 ms · fine</small>')
                 + row('Audio engine', 'if sound stops, or after plugging in new gear', '<button class="btn">Restart audio (hold)</button>'))
            + card('Click', row('Click output', 'Outputs 3–4 need an interface with 4+ outputs', seg(['With the music', 'Outputs 3–4'], 'With the music')))
            + '<details class="sadv"><summary>Advanced · Voices per sound 64 · Buffer 128</summary></details>')
  if cat == 'keys':
    devs = ''.join(f'<div class="dev"><span class="dd{" on" if on else ""}"></span><b>{n}</b><small>{s}</small>{toggle(on)}</div>' for n, s, on in [
      ('Keystation 49es', 'USB · playing now', True), ('Nord Stage 3', 'not connected', False), ('Computer keys', 'A W S E D …, Z/X octave', True)])
    return (card('Keyboards', devs + row('Touch', 'how hard you play → how loud', seg(['Light', 'Normal', 'Heavy', 'Fixed'], 'Normal')))
            + card('Sustain pedal', row('Pedal', 'press it: the light should come on', '<span class="lamp on2"></span><small>down</small><button class="ghost">Reversed: off</button>')))
  if cat == 'learn':
    rows = ''.join(f'<div class="lrn"><span class="ctl">{c}</span><span class="arr">→</span><b>{t}</b><button class="ghost sm3">Forget</button></div>' for c, t in [
      ('Knob 1', 'Warm Pad level'), ('Fader 9', 'Master volume'), ('Pad 4', 'Drone on / off')])
    return card('MIDI Learn <small>moves change the live sound; Revert undoes them; the song is never edited (D20)</small>',
                rows + '<div class="learnbox"><b>Learn a new control</b><small>Tap “Learn”, move a knob, fader or pad, then tap what it should change on screen.</small><button class="btn savebtn">Learn</button></div>')
  if cat == 'samples':
    packs = ''.join(f'<div class="dev"><span class="dd on"></span><b>{n}</b><small>{s}</small><button class="ghost sm3">Rescan</button></div>' for n, s in [
      ('Sunday pack', '5 bank songs · 3 instruments'), ('Desk sounds', '2 bank songs · 1 instrument')])
    return (card('Song bank', '<div class="hrow"><button class="btn savebtn">Open Song bank…</button><small class="muted">7 ready-made songs from your packs</small></div>')
            + card('My Samples', packs + '<button class="link">Bringing GarageBand instruments over ▸</button>')
            + card('My Pads folder', row('Folder', 'put the key in each file name, e.g. “Pad - Eb.wav”', '<button class="btn">Choose folder…</button>')))
  if cat == 'layout':
    mods = ''.join(f'<div class="cz"><span class="grip">⠿</span>{lab}<small>{sub}</small><span class="sw{" on" if on else ""}"></span></div>' for lab, sub, on in [
      ('Drone', 'key, level, sound', True), ('Setlist', 'songs, cue and go', True), ('Notes', 'song notes', True),
      ('Chart', 'chord chart (2.1)', True), ('Tone', 'bright and warm', False)])
    return (card('Right sidebar <small>the same as ⋯ on the sidebar</small>', mods + row('Starts', '', seg(['Open', 'Collapsed'], 'Open')))
            + card('Perform', row('Snapshots row', '', seg(['Shown', 'Folded'], 'Shown')) + row('Left panel', 'Quick and the wheel', seg(['Shown', 'Hidden'], 'Shown'))
                   + row('Chart opens', 'remembered on this device', seg(['On the stage', 'In the sidebar'], 'On the stage'))
                   + row('Chart text', '100% is the default', seg(['75%', '100%', '125%', '150%'], '100%'))))
  if cat == 'look':
    cards = ''.join(f'''<button class="thm{" sel" if t[0] == "sanctuary" else ""}" style="--tb:{t[3]["bg"]};--tp:{t[3]["panel"]};--tt:{t[3]["text"]};--ta:{t[3]["accent"]}">
      <span class="tprev"><i></i><i></i><i></i><em>Aa</em></span><b>{t[1]}</b><small>{"light" if t[2] == "light" else "dark"}</small></button>''' for t in THEMES)
    return card('Theme', f'<div class="thms">{cards}</div>') + card('Light or dark', row('Mode', 'Auto follows this Mac', seg(['Day', 'Stage', 'Auto'], 'Auto')))
  if cat == 'library':
    bk = ''.join(f'<div class="dev"><span class="dd on"></span><b>{t}</b><small>{s}</small><button class="ghost sm3">Restore…</button></div>' for t, s in [
      ('Today 16:51', 'automatic · 42 songs'), ('Today 14:10', 'automatic · 41 songs'), ('Yesterday 21:03', 'before import · 19 songs')])
    return (card('Library', row('Export', 'one file with every song, setlist and setting', '<button class="btn">Export…</button>')
                 + row('Import', 'add songs from a file, or replace the library', '<button class="btn">Import…</button>'))
            + card('Backups <small>the newest 10 are kept</small>', bk))
  return card('…', '')


def settings(cat='sound'):
  nav = ''.join(f'<button class="cn{" on" if k == cat else ""}"><b>{lab}</b><small>{sub}</small></button>' for k, lab, sub in CATS)
  return f'''<div class="sdlg" role="dialog" aria-label="Settings"><div class="sdlg-h"><b>Settings</b>
      <div class="bsearch sm"><span>⌕</span><input placeholder="Search settings"></div><button class="btn">Close</button></div>
    <div class="sdlg-b"><nav class="cnav" aria-label="Settings categories">{nav}</nav><div class="scont">{content(cat)}</div></div></div>'''


def frame(cat):
  board = f'<div class="board dim2 sdim">{m.wheel()}<div class="strips">{"".join(m.strip(i, r) for i, r in enumerate(m.ALL[:3]))}</div>{m.sidebar()}</div>'
  return (f'<div class="frame" style="width:1280px;height:800px;position:relative">{m.topbar()}{m.songbar(snap_chip=True)}{board}{m.bottom(3)}'
          f'{settings(cat)}</div>')


CSS = ''.join(open(f'/home/claude/scratch/{f}').read() for f in
              ('mock_v5.css', 'mock_v6.css', 'mock_chart.css', 'mock_bank.css', 'mock_edit.css', 'mock_settings.css'))
frames = [(k, lab, frame(k)) for k, lab, _ in CATS if k not in ('mac', 'about')]


def build():
  tabs = ''.join(f'<button role="tab" data-t="{i}" aria-selected="{str(k == 0).lower()}">{t}</button>'
                 for k, (i, t, _) in enumerate(frames))
  secs = ''.join(f'<section id="{i}" class="{"on" if k == 0 else ""}"><div class="scale">{f}</div></section>'
                 for k, (i, t, f) in enumerate(frames))
  html = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settings mockups</title>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@700;800&family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<header class="pg"><h1>Settings: quick mockups</h1>
<p>Today's Settings already has a category list; this keeps it and brings it in line with Edit: each category shows
its current state under its name, there is a search box, and the cards use the v6 controls. New categories follow
the decisions so far: <b>MIDI Learn</b> (live only, Revert undoes, D20), <b>Perform layout</b> (sidebar modules, snapshots
row, left panel, chart placement and text size) and the <b>Song bank</b> entry in Sounds &amp; Samples (D17). Look shows
the 8 themes as previews. Nothing is wired up.</p>
<nav class="tabs" role="tablist">{tabs}</nav></header>
<main>{secs}</main>
<script>{{const tabs=[...document.querySelectorAll('[role=tab]')];
function show(id){{tabs.forEach(b=>b.setAttribute('aria-selected',b.dataset.t===id));document.querySelectorAll('main>section').forEach(s=>s.classList.toggle('on',s.id===id));fit();}}
tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));
function fit(){{document.querySelectorAll('section.on .scale').forEach(sc=>{{const f=sc.firstElementChild;const k=Math.min(1,(sc.clientWidth)/f.offsetWidth);f.style.transform='scale('+k+')';sc.style.height=(f.offsetHeight*k)+'px';}});}}
new ResizeObserver(fit).observe(document.body);fit();}}</script></body></html>'''
  os.makedirs(os.path.dirname(OUT), exist_ok=True)
  open(OUT, 'w').write(html)
  print('ok', len(html))


if __name__ == '__main__':
  build()
