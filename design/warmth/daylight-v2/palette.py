"""Daylight v2 palette check: WCAG contrast for every token pair the theme uses, OKLCH of each token, and slot separation
under colour-vision deficiency (Machado 2009, severity 1.0, min OKLab dE x100). Run: python3 palette.py"""
import math

DAY = dict(
    bg='#f3efe7', panel='#fdfbf7', panel2='#f6f2eb', panel3='#ece6dc', line='#e5ded2', line2='#d2c8b9',
    text='#27211b', muted='#5e554b', faint='#6f665b', accent='#f4b73f', accent_ink='#2a1d05', accent_text='#8a5300',
    track='#e7e0d4', track_edge='#958b7e', led_off='#958b7e', muted_fader='#948a7d', thumb='#fffdf8',
    slot0='#f28a4c', slot1='#79c68f', slot2='#7cc4ee', slot3='#a883d4', drone='#e4d3a8', fx='#8c8172',
    ink_on_lamp='#241a10', topbar='#fbf8f2', key_white='#fffdf8', key_black='#2c2621', panic='#d23f2f',
    rail='#efe9df', notes='#fbf5e8', pop='#fffdf9',
)
DUSK = dict(  # v2: warm walnut, OKLCH chroma 0.012-0.019 at hue 57-67 (v1 was <= 0.008, "charcoal")
    bg='#1b1611', panel='#261f19', panel2='#2f2720', panel3='#3a3129', line='#3a3029', line2='#52463b',
    text='#f5ede0', muted='#cfc3b2', faint='#ada08e', accent='#f6c35a', accent_ink='#2a1d05', accent_text='#f6c35a',
    track='#140f0b', track_edge='#877a6b', led_off='#877a6b', muted_fader='#877a6b', thumb='#efe8dc',
    slot0='#f39a62', slot1='#7fcb92', slot2='#8fd0f5', slot3='#b98bdc', drone='#eddcae', fx='#bfb3a3',
    ink_on_lamp='#1d1712', topbar='#211a15', key_white='#cfc6b6', key_black='#17110d', panic='#c9372a',
    rail='#211a15', notes='#2a221b', pop='#2c241d',
)


def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def L(h):
    r, g, b = (lin(v) for v in rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def cr(a, b):
    x, y = sorted([L(a), L(b)], reverse=True)
    return (x + 0.05) / (y + 0.05)


def mix(a, b, t):
    """t of a, (1-t) of b, in OKLab (like color-mix(in oklab, a t%, b))."""
    la, lb = oklab(rgb(a)), oklab(rgb(b))
    m = [la[i] * t + lb[i] * (1 - t) for i in range(3)]
    return '#' + ''.join('%02x' % max(0, min(255, round(v))) for v in from_oklab(m))


def oklab(c):
    r, g, b = (lin(v) for v in c)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (math.copysign(abs(v) ** (1 / 3), v) for v in (l, m, s))
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s]


def from_oklab(o):
    L_, a, b = o
    l = (L_ + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L_ - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L_ - 0.0894841775 * a - 1.2914855480 * b) ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    enc = lambda v: 255 * (12.92 * v if v <= 0.0031308 else 1.055 * max(v, 0) ** (1 / 2.4) - 0.055)
    return [enc(r), enc(g), enc(bb)]


def oklch(h):
    L_, a, b = oklab(rgb(h))
    return L_, math.hypot(a, b), (math.degrees(math.atan2(b, a)) + 360) % 360


MACHADO = {
    'deutan': [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    'protan': [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    'tritan': [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
}


def sim(h, kind):
    c = [lin(v) for v in rgb(h)]
    M = MACHADO[kind]
    out = [max(0, min(1, sum(M[i][j] * c[j] for j in range(3)))) for i in range(3)]
    enc = lambda v: 255 * (12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055)
    return [enc(v) for v in out]


def dE(a, b):
    return 100 * math.dist(oklab(a), oklab(b))


def report(name, P):
    print(f'\n=== {name} ===')
    for k in ('bg', 'panel', 'panel2', 'text', 'muted', 'faint', 'accent', 'slot0', 'slot1', 'slot2', 'slot3'):
        l, c, h = oklch(P[k])
        print(f'  {k:8s} {P[k]}  OKLCH({l:.3f} {c:.3f} {h:.0f})')
    pairs = [
        ('text', 'bg'), ('text', 'panel'), ('text', 'panel2'), ('text', 'panel3'), ('text', 'topbar'),
        ('muted', 'panel'), ('muted', 'panel2'), ('muted', 'panel3'), ('muted', 'bg'),
        ('faint', 'panel'), ('faint', 'panel2'), ('faint', 'panel3'), ('faint', 'bg'),
        ('accent_ink', 'accent'), ('accent_text', 'panel'), ('accent_text', 'panel2'),
        ('ink_on_lamp', 'slot0'), ('ink_on_lamp', 'slot1'), ('ink_on_lamp', 'slot2'), ('ink_on_lamp', 'slot3'),
        ('ink_on_lamp', 'drone'), ('ink_on_lamp', 'accent'),
        ('text', 'key_white'), ('#ffffff', 'panic'),
        ('text', 'notes'), ('muted', 'notes'), ('faint', 'notes'), ('faint', 'bg'), ('text', 'pop'), ('muted', 'pop'),
    ]
    nontext = [('track_edge', 'panel'), ('led_off', 'panel'), ('led_off', 'topbar'), ('muted_fader', 'panel'),
               ('slot0', 'panel'), ('slot1', 'panel'), ('slot2', 'panel'), ('slot3', 'panel'), ('line2', 'panel'),
               ('key_black', 'key_white'), ('panel', 'bg')]
    get = lambda k: k if k.startswith('#') else P[k]
    print('  text pairs (need 4.5):')
    for a, b in pairs:
        r = cr(get(a), get(b))
        print(f'    {a:12s} on {b:10s} {r:5.2f} {"ok" if r >= 4.5 else "LOW"}')
    print('  non-text (need 3 where it carries meaning):')
    for a, b in nontext:
        print(f'    {a:12s} on {b:10s} {cr(get(a), get(b)):5.2f}')
    # slot ink text on panel: color-mix(in oklab, slot 55%, text) (day) / slot 100% (dusk)
    mixto = P['text']
    for i in range(4):
        for t in (1.0, 0.7, 0.55, 0.45):
            m = mix(P[f'slot{i}'], mixto, t)
            print(f'    slot{i} ink {int(t*100)}% {m} on panel {cr(m, P["panel"]):5.2f}  on panel2 {cr(m, P["panel2"]):5.2f}')
    slots = [P['slot0'], P['slot1'], P['slot2'], P['slot3'], P['drone']]
    names = ['Keys', 'Pad', 'Extra', 'Bass', 'Drone']
    for kind in ('normal', 'deutan', 'protan', 'tritan'):
        col = [rgb(s) if kind == 'normal' else sim(s, kind) for s in slots]
        best = min(((dE(col[i], col[j]), names[i], names[j]) for i in range(5) for j in range(i + 1, 5)))
        print(f'  CVD {kind:7s} min dE {best[0]:5.1f} ({best[1]} vs {best[2]})')


if __name__ == '__main__':
    report('Day', DAY)
    report('Dusk', DUSK)
