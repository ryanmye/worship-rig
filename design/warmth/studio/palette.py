"""Studio palette: OKLCH -> hex, WCAG contrast table and CVD (Machado 2009, severity 1.0) OKLab dE between lamps.
   python3 design/warmth/studio/palette.py"""
import math, itertools
def oklch(L, C, h):
    a, b = C*math.cos(math.radians(h)), C*math.sin(math.radians(h))
    l_ = L + 0.3963377774*a + 0.2158037573*b; m_ = L - 0.1055613458*a - 0.0638541728*b; s_ = L - 0.0894841775*a - 1.2914855480*b
    l, m, s = l_**3, m_**3, s_**3
    r = 4.0767416621*l - 3.3077115913*m + 0.2309699292*s; g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bb = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    enc = lambda x: 12.92*x if x <= 0.0031308 else 1.055*x**(1/2.4) - 0.055
    return '#' + ''.join('%02x' % round(255*min(1, max(0, enc(v)))) for v in (r, g, bb))
def rgb(h): h = h.lstrip('#'); return [int(h[i:i+2], 16)/255 for i in (0, 2, 4)]
lin = lambda c: c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
def lum(h): r, g, b = map(lin, rgb(h)); return 0.2126*r + 0.7152*g + 0.0722*b
def cr(a, b): x, y = sorted([lum(a), lum(b)], reverse=True); return (x+0.05)/(y+0.05)
def oklab_lin(r, g, b):
    l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b; m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b
    s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b
    l, m, s = [math.copysign(abs(v)**(1/3), v) for v in (l, m, s)]
    return (0.2104542553*l + 0.7936177850*m - 0.0040720468*s, 1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
            0.0259040371*l + 0.7827717662*m - 0.8086757660*s)
MACHADO = {'normal': [[1,0,0],[0,1,0],[0,0,1]],
  'deutan': [[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]],
  'protan': [[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
  'tritan': [[1.255528,-0.076749,-0.178779],[-0.078411,0.930809,0.147602],[0.004733,0.691367,0.303900]]}
def sim(h, kind):
    v = [lin(c) for c in rgb(h)]; M = MACHADO[kind]
    o = [max(0, min(1, sum(M[i][j]*v[j] for j in range(3)))) for i in range(3)]
    return oklab_lin(*o)
def dE(a, b, kind): A, B = sim(a, kind), sim(b, kind); return 100*math.dist(A, B)

P = dict(
  bg=oklch(.235, .007, 70), deep=oklch(.19, .006, 70), panel=oklch(.275, .008, 70), panel2=oklch(.315, .009, 70),
  panel3=oklch(.355, .010, 70), line=oklch(.335, .009, 70), line2=oklch(.43, .010, 70), linehover=oklch(.50, .012, 70),
  text=oklch(.955, .014, 85), muted=oklch(.83, .016, 78), faint=oklch(.745, .016, 75),
  accent=oklch(.845, .125, 80), warn=oklch(.80, .145, 68),
  s0=oklch(.755, .135, 52), s1=oklch(.78, .12, 148), s2=oklch(.86, .08, 236), s3=oklch(.68, .13, 312),
  drone=oklch(.89, .06, 88), fx=oklch(.80, .03, 75), ink=oklch(.22, .012, 60),
  tape=oklch(.84, .022, 88), tapeink=oklch(.26, .015, 60),
  ledoff=oklch(.56, .012, 70), trackedge=oklch(.56, .012, 70), track=oklch(.38, .010, 70),
  thumb=oklch(.90, .010, 80), panic=oklch(.575, .19, 30), ok=oklch(.79, .13, 150),
)
if __name__ == '__main__':
    for k, v in P.items(): print(f'{k:10} {v}  L={lum(v):.3f}')
    print('\ncontrast')
    for fg in ('text', 'muted', 'faint'):
        print(fg, ' '.join(f'{bg}:{cr(P[fg], P[bg]):.2f}' for bg in ('deep', 'bg', 'panel', 'panel2', 'panel3')))
    for k in ('s0', 's1', 's2', 's3', 'accent', 'warn', 'drone'):
        print(f'ink on {k}: {cr(P["ink"], P[k]):.2f}   {k} on panel {cr(P[k], P["panel"]):.2f}  on panel2 {cr(P[k], P["panel2"]):.2f}')
    for fg, bg in (('#5b5147', P['tape']), ('#5a5249', '#c8c0b2'), ('#ffffff', '#b93021'), ('#ffffff', '#d4412f'),
                   ('#c8c0b5', '#35312d'), ('#ebe4d8', '#35312d'), ('#b8b0a5', '#35312d'), ('#fff6e2', '#1b1815'),
                   (P['text'], '#4a443d'), ('#e0d8cc', '#302c28'), (P['faint'], '#302c28'), ('#1f1915', '#dccbb0')):
        print(f'{fg} on {bg}: {cr(fg, bg):.2f}')
    print('tapeink on tape', round(cr(P['tapeink'], P['tape']), 2), 'white on panic', round(cr('#ffffff', P['panic']), 2))
    for k in ('ledoff', 'trackedge', 'line2'): print(k, 'on panel', round(cr(P[k], P['panel']), 2), 'on bg', round(cr(P[k], P['bg']), 2), 'on deep', round(cr(P[k], P['deep']), 2))
    lamps = {'Keys': P['s0'], 'Pad': P['s1'], 'Extra': P['s2'], 'Bass': P['s3'], 'accent': P['accent']}
    print('\nCVD min dE x100 (pair)')
    for kind in MACHADO:
        m = min(((dE(a, b, kind), f'{x}/{y}') for (x, a), (y, b) in itertools.combinations(lamps.items(), 2)))
        print(f'{kind:7} {m[0]:.1f} {m[1]}')
    old = {'Keys': '#ff8a3d', 'Pad': '#3ddc84', 'Extra': '#4aa8ff', 'Bass': '#b784ff', 'accent': '#ffc94d'}
    for kind in MACHADO:
        m = min(((dE(a, b, kind), f'{x}/{y}') for (x, a), (y, b) in itertools.combinations(old.items(), 2)))
        print(f'today {kind:7} {m[0]:.1f} {m[1]}')
