"""Sanctuary v2 palette: plum-ink neutrals (OKLCH hue 298, same L/C as v1's 277), WCAG table, lamp ink/gradient checks,
   CVD (Machado 2009 severity 1.0, OKLab dE x100) and wheel glare.  python3 design/warmth/sanctuary-v2/palette.py"""
import sys, os, math, itertools
import importlib.util as _u
_s = _u.spec_from_file_location('studio_palette', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'studio', 'palette.py'))
_m = _u.module_from_spec(_s); _s.loader.exec_module(_m)  # shared helpers (Studio probe)
oklch, rgb, lin, lum, cr, oklab_lin, MACHADO, dE = _m.oklch, _m.rgb, _m.lin, _m.lum, _m.cr, _m.oklab_lin, _m.MACHADO, _m.dE

def to_oklch(h):
    L, a, b = oklab_lin(*[lin(c) for c in rgb(h)])
    return L, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360
def mix(a, b, t):  # sRGB-space mix like color-mix(in srgb, a (1-t), b t)
    A, B = rgb(a), rgb(b); return '#' + ''.join('%02x' % round(255 * (x * (1 - t) + y * t)) for x, y in zip(A, B))
def shade(h, dL):  # same hue/chroma, L + dL (OKLCH)
    L, C, H = to_oklch(h); return oklch(L + dL, C, H)

H = 298  # v1 was 277 (navy-indigo); critique: plum 290-300 at the same chroma
N = dict(bg=(.164, .038), panel=(.205, .040), panel2=(.244, .040), panel3=(.289, .038), off=(.225, .035),
         rig=(.179, .041), line=(.281, .039), line2=(.370, .034), track=(.306, .041), selfx=(.325, .068),
         hover=(.43, .036))
P = {k: oklch(L, C, H) for k, (L, C) in N.items()}
P['panel_hi'] = oklch(.235, .040, H)   # panel top stop (+3 % L): "lit from above"
P['panel2_hi'] = oklch(.270, .040, H)
P.update(text='#f5ecd8', muted='#cec1aa', faint='#ab9d87', label='#d3bf94', accent='#e6ba65', warn='#f7a23d',
         drone='#edd9a6', fx='#cdbf9f', notes='#e9dfcb', sent='#d8ccb5', chip='#a99d8b', ink='#150f08')
SLOTS = {'Keys': '#f78955', 'Pad': '#4ec491', 'Extra': '#7ad1f7', 'Bass': '#af80e1'}
# lit glass: top = slot +0.05 L, bottom = slot -0.065 L (about 90 % L), ink must clear 4.5 on the bottom stop
TILE = {k: (shade(v, .05), v, shade(v, -.065)) for k, v in SLOTS.items()}

if __name__ == '__main__':
    for k, v in P.items():
        if k in ('text',): print()
        print(f'{k:10} {v}  OKLCH {" ".join(f"{x:.3f}" if i < 2 else f"{x:.0f}" for i, x in enumerate(to_oklch(v)))}')
    bgs = ('bg', 'panel', 'panel_hi', 'panel2', 'panel2_hi', 'panel3', 'off', 'rig')
    print('\ncontrast (fg on each surface; min last)')
    for fg in ('text', 'muted', 'faint', 'label', 'accent', 'drone', 'warn', 'fx', 'chip', 'notes', 'sent'):
        r = [cr(P[fg], P[b]) for b in bgs]
        print(f'{fg:7} ' + ' '.join(f'{b}:{x:.1f}' for b, x in zip(bgs, r)) + f'  | min {min(r):.2f}')
    print('\nlit-glass tiles (top / mid / bottom) and ink on the darkest stop')
    for k, (t, m, b) in TILE.items():
        print(f'{k:6} {t} {m} {b}  ink: {cr(P["ink"], t):.1f} / {cr(P["ink"], m):.1f} / {cr(P["ink"], b):.2f}'
              f'   lamp vs off-tile {cr(m, P["off"]):.1f}   vs panel3 {cr(m, P["panel3"]):.1f}')
    print('ink on drone', round(cr(P['ink'], P['drone']), 1), ' ink on brass', round(cr('#1c1406', P['accent']), 1))
    lamps = dict(SLOTS, brass=P['accent'])
    print('\nCVD min OKLab dE x100 among the 4 slots (and incl. brass)')
    for kind in MACHADO:
        s = min((dE(a, b, kind), f'{x}/{y}') for (x, a), (y, b) in itertools.combinations(SLOTS.items(), 2))
        w = min((dE(a, b, kind), f'{x}/{y}') for (x, a), (y, b) in itertools.combinations(lamps.items(), 2))
        print(f'{kind:7} slots {s[0]:.1f} ({s[1]})   +brass {w[0]:.1f} ({w[1]})')
    v1 = {'Keys': '#f78955', 'Pad': '#6ed889', 'Extra': '#7ad1f7', 'Bass': '#b073da'}
    for kind in MACHADO:
        s = min((dE(a, b, kind), f'{x}/{y}') for (x, a), (y, b) in itertools.combinations(v1.items(), 2))
        print(f'v1 {kind:7} {s[0]:.1f} ({s[1]})')
    # wheel: candle gradient; mean relative luminance over the filled column (edge -> 70 % down eases to brass)
    edge, mid, base = '#dcc28a', '#bd8e44', '#9f7536'
    def at(t):  # t = 0 at the level edge, 1 at the bottom
        if t <= .7: a, b, u = edge, mid, t / .7
        else: a, b, u = mid, base, (t - .7) / .3
        u = u * u * (3 - 2 * u) if t <= .7 else u
        return lum(mix(a, b, u))
    mean = sum(at(i / 999) for i in range(1000)) / 1000
    print(f'\nwheel fill: edge {edge} L={lum(edge):.3f}, 70% {mid} L={lum(mid):.3f}, base {base}; mean L={mean:.3f} '
          f'(v1 flat #b9a77f {lum("#b9a77f"):.3f}; today #a9b8c9 {lum("#a9b8c9"):.3f})')
    print('track edge on panel', round(cr('#7d7a86', P['panel']), 2), ' led-off on topbar', round(cr('#77737f', P['bg']), 2),
          ' muted-fader on panel', round(cr('#8a8594', P['panel']), 2), ' white on panic', round(cr('#ffffff', '#d9363a'), 2))
    print('fade-out: text on panel2', round(cr(P['text'], P['panel2']), 1), ' brass rim (50%) on bg',
          round(cr(mix(P['panel2'], P['accent'], .5), P['bg']), 2))
