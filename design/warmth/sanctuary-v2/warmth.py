"""Colour temperature of a screenshot, measured: mean OKLab b (yellow +, blue -) and a (red +, green -) over all pixels,
   and over "surface" pixels only (L < 0.35: the room, not the text or lamps). Compares today, v1, v2 and Ember.
   python3 design/warmth/sanctuary-v2/warmth.py"""
import os, numpy as np
from PIL import Image
H = os.path.dirname(os.path.abspath(__file__))
SHOTS = {'today': '../probe/base-perform-1440.png', 'Sanctuary v1': '../sanctuary/perform.png',
         'Sanctuary v2': 'perform.png', 'Ember': '../ember/perform.png'}
def oklab(img):
    x = np.asarray(img.convert('RGB'), dtype=np.float64) / 255
    x = np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)
    M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]])
    M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]])
    return np.cbrt(x @ M1.T) @ M2.T
for name, f in SHOTS.items():
    p = os.path.join(H, f)
    if not os.path.exists(p): print(f'{name:13} (missing {f})'); continue
    lab = oklab(Image.open(p)).reshape(-1, 3); s = lab[lab[:, 0] < 0.35]
    print(f'{name:13} all: a {lab[:,1].mean()*100:+.2f} b {lab[:,2].mean()*100:+.2f} | surfaces ({len(s)/len(lab):.0%}): '
          f'a {s[:,1].mean()*100:+.2f} b {s[:,2].mean()*100:+.2f} L {s[:,0].mean():.3f} | warm-pixel share (b>0) {np.mean(lab[:,2] > 0):.0%}')

# side-by-side at half size (compare.png): today | v1 | v2 | Ember
if __name__ == '__main__':
    from PIL import ImageDraw
    tiles = [(n, Image.open(os.path.join(H, f)).convert('RGB').resize((720, 450), Image.LANCZOS))
             for n, f in SHOTS.items() if os.path.exists(os.path.join(H, f))]
    out = Image.new('RGB', (720 * 2 + 12, (450 + 30) * 2 + 6), '#0c0716')
    for i, (n, t) in enumerate(tiles):
        x, y = (i % 2) * 732, (i // 2) * 486
        out.paste(t, (x, y + 30)); ImageDraw.Draw(out).text((x + 8, y + 8), n, fill='#f5ecd8')
    out.save(os.path.join(H, 'compare.png'))
