// The contrast audit shared by tools/themes/shoot.mjs (today's screens) and tools/themes/shoot-v6.mjs (UI v6 U8b):
// one copy of the measuring code, so both shoots judge colour the same way.
//
// Text (WCAG 1.4.3): every visible text run's computed colour vs the median rendered background behind it, 4.5 : 1
// (3 : 1 for large text, ≥ 24 px or ≥ 18.66 px bold); controls that are disabled (or inside one) are exempt.
// Non-text (WCAG 1.4.11, `ui: true`, U8b): (a) focus rings: every visible focusable control is focused in keyboard
// modality, its ring (outline, else a box-shadow ring) vs the median of what is behind the ring when it is not
// focused, 3 : 1; (b) boundaries of controls that have no text of their own to identify them (text fields, selects,
// switch tracks): border or fill vs the background just outside, whichever is higher, 3 : 1. Text-labelled buttons
// need no boundary (the text identifies them; WCAG 1.4.11 Understanding, "buttons with text").
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Chromium screenshots are) → RGBA bytes.
 * @param {Buffer} buf
 * @returns {{width:number, height:number, data:Uint8Array}}
 */
export function decodePng(buf) {
  let p = 8; let w = 0; let h = 0; let ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8); const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3; const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp;
  const out = new Uint8Array(w * h * 4); const prev = new Uint8Array(stride); const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c; const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = 255; }
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** WCAG contrast ratio of two sRGB triples. */
export const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/**
 * Mean luminance and bright-pixel share of a screenshot (the glare figures the theme critics compare).
 * @param {string} file a PNG
 */
export function glare(file) {
  const img = decodePng(fs.readFileSync(file));
  let bright = 0; let sum = 0; const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4; const l = 0.2126 * lin(img.data[o]) + 0.7152 * lin(img.data[o + 1]) + 0.0722 * lin(img.data[o + 2]);
    sum += l; if (l > 0.45) bright++;
  }
  return { meanLum: +(sum / n).toFixed(4), brightShare: +(bright / n).toFixed(4) };
}

/** Median (by luminance) of the pixels in the given rects (clipped to the image), or null. */
function medianIn(img, rects, step = 2) {
  const px = [];
  for (const q of rects) {
    const x0 = Math.round(q.x), y0 = Math.round(q.y), x1 = Math.round(q.x + q.w), y1 = Math.round(q.y + q.h);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += step) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4; px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
    }
  }
  if (!px.length) return null;
  const lum = px.map((q) => [L(q), q]).sort((a, b) => a[0] - b[0]);
  return lum[Math.floor(lum.length / 2)][1];
}
/** The four sides of a band between rect `r` grown by `a` and by `b` (a < b). */
function band(r, a, b) {
  const o = { x: r.x - b, y: r.y - b, w: r.w + 2 * b, h: r.h + 2 * b };
  const t = b - a;
  return [{ x: o.x, y: o.y, w: o.w, h: t }, { x: o.x, y: o.y + o.h - t, w: o.w, h: t },
    { x: o.x, y: o.y + t, w: t, h: o.h - 2 * t }, { x: o.x + o.w - t, y: o.y + t, w: t, h: o.h - 2 * t }];
}
const blend = (rgba, op, bg) => { const al = rgba[3] * op; return rgba.slice(0, 3).map((c, k) => c * al + bg[k] * (1 - al)); };
const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;

/**
 * In the page: every visible text run (and the CSS voice bridge's ::after words). `fades`: edge fades that say "more
 * this way" ({sel, side, px}: the last px of each match on that side); a run centred in one is marked `faded` (it is
 * scrolled half out of view; scrolled in, it is audited like the rest).
 */
function collectRuns(fades) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const zones = [];
  for (const f of fades || []) {
    for (const z of document.querySelectorAll(f.sel)) {
      const q = z.getBoundingClientRect();
      zones.push(f.side === 'right' ? { x0: q.right - f.px, x1: q.right, y0: q.top, y1: q.bottom }
        : { x0: q.left, x1: q.left + f.px, y0: q.top, y1: q.bottom });
    }
  }
  const inFade = (q) => { const cx = q.left + q.width / 2, cy = q.top + q.height / 2; return zones.some((z) => cx >= z.x0 && cx <= z.x1 && cy >= z.y0 && cy <= z.y1); };
  // the drop shadows of overlays (popovers, sheets, dialogs): text under one is darkened with its background, so it is
  // measured on the rendered pixels (both darkened) instead of its computed colour (U8b)
  const shades = [];
  for (const e of document.body.querySelectorAll('*')) {
    const c = getComputedStyle(e);
    if (c.boxShadow === 'none' || !/^(absolute|fixed)$/.test(c.position) || c.display === 'none') continue;
    let ext = 0;
    for (const m of c.boxShadow.matchAll(/\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?(?!\s*inset)/g)) {
      ext = Math.max(ext, Math.abs(+m[1]) + Math.abs(+m[2]) + +m[3] + (+m[4] || 0));
    }
    if (ext < 8) continue;
    const q = e.getBoundingClientRect();
    if (q.width < 20 || q.height < 20) continue;
    shades.push({ e, x0: q.left - ext, x1: q.right + ext, y0: q.top - ext, y1: q.bottom + ext, q });
  }
  const shaded = (el, q) => {
    const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
    return shades.some((z) => !z.e.contains(el) && cx >= z.x0 && cx <= z.x1 && cy >= z.y0 && cy <= z.y1
      && !(cx >= z.q.left && cx <= z.q.right && cy >= z.q.top && cy <= z.q.bottom));
  };
  // a run's box cut to what its scrolling / clipping ancestors show (null: clipped away)
  const clip = (el, q) => {
    let x0 = q.left, y0 = q.top, x1 = q.right, y1 = q.bottom;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const c = getComputedStyle(a);
      if (c.overflowX === 'visible' && c.overflowY === 'visible') continue;
      const r = a.getBoundingClientRect();
      x0 = Math.max(x0, r.left); y0 = Math.max(y0, r.top); x1 = Math.min(x1, r.right); y1 = Math.min(y1, r.bottom);
    }
    return x1 - x0 > 2 && y1 - y0 > 4 ? { left: x0, top: y0, width: x1 - x0, height: y1 - y0, right: x1, bottom: y1 } : null;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; let id = 0;
  while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,noscript,[hidden],svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
    // not rendered though it has boxes: inside a closed <details> (content-visibility: hidden) (U8b)
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true })) continue;
    if (parseFloat(cs.fontSize) < 1) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    const rects = [...r.getClientRects()].filter((q) => q.width > 2 && q.height > 4);
    if (!rects.length) continue;
    const q = clip(el, rects[0]);
    if (!q || q.right < 0 || q.bottom < 0 || q.left > vw || q.top > vh) continue;
    const hit = document.elementFromPoint(Math.min(vw - 1, q.left + q.width / 2), Math.min(vh - 1, q.top + q.height / 2));
    if (hit && !(el.contains(hit) || hit.contains(el))) continue;
    let op = 1; let disabled = false; let a = el;
    while (a) { const s = getComputedStyle(a); op *= parseFloat(s.opacity); if (a.disabled || a.getAttribute?.('aria-disabled') === 'true') disabled = true; a = a.parentElement; }
    if (op < 0.05) continue;
    out.push({ id: id++, text: n.textContent.trim().slice(0, 40), color: cs.color, rgba: rgba(cs.color), size: parseFloat(cs.fontSize),
      weight: parseInt(cs.fontWeight, 10), op, disabled, faded: inFade(q), shaded: shaded(el, q), cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 60),
      tag: el.tagName.toLowerCase(), rect: { x: Math.max(0, q.left), y: Math.max(0, q.top), w: Math.min(q.width, vw - q.left), h: Math.min(q.height, vh - q.top) } });
  }
  // v2: the CSS voice bridge writes words with ::after on an element whose own text is font-size 0. Audit those too
  // (the element's box is the pseudo's box, since its own text takes no space).
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (parseFloat(cs.fontSize) >= 1 || cs.display === 'none' || cs.visibility !== 'visible') continue;
    const ps = getComputedStyle(el, '::after');
    if (!/^["']/.test(ps.content)) continue;
    const q = el.getBoundingClientRect();
    if (q.width < 2 || q.height < 4 || q.right < 0 || q.bottom < 0 || q.left > vw || q.top > vh) continue;
    if (el.closest('[hidden]')) continue;
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true })) continue;
    // under a modal's scrim (or anything else on top) it is not shown: the same hit test as the text runs (U8b)
    const hit = document.elementFromPoint(Math.min(vw - 1, q.left + q.width / 2), Math.min(vh - 1, q.top + q.height / 2));
    if (hit && !(el.contains(hit) || hit.contains(el))) continue;
    let op = 1; let disabled = false; let a = el;
    while (a) { const s2 = getComputedStyle(a); op *= parseFloat(s2.opacity); a = a.parentElement; }
    out.push({ id: id++, text: `::after ${ps.content.slice(1, -1).slice(0, 36)}`, color: ps.color, rgba: rgba(ps.color), size: parseFloat(ps.fontSize),
      weight: parseInt(ps.fontWeight, 10), op, disabled, cls: String(el.className || '').slice(0, 60), tag: el.tagName.toLowerCase(),
      rect: { x: Math.max(0, q.left), y: Math.max(0, q.top), w: Math.min(q.width, vw - q.left), h: Math.min(q.height, vh - q.top) } });
  }
  return out;
}

/**
 * In the page: the visible, enabled, uncovered focusable controls (one per look: tag + class + role + type, so a
 * row of 12 keys is measured once) and the textless ones whose boundary must show. Marks each with data-aud.
 * A textless field drawn by its wrapper (a search box: the input is bare, the wrapper has the border) is measured on
 * the wrapper. A switch is measured by its thumb against its track (the state is the thumb's place).
 */
function collectControls([max, exempt]) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const vw = innerWidth, vh = innerHeight;
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio], '
    + '[role=switch], [role=checkbox], [role=slider], [role=option], [role=menuitem], [tabindex]:not([tabindex="-1"])';
  const seen = new Set();
  const out = [];
  let id = 0;
  const rectOf = (e) => { const q = e.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= max) break;
    if (el.disabled || el.closest('[hidden], [inert], [aria-disabled="true"], fieldset[disabled]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true })) continue;
    const q = el.getBoundingClientRect();
    if (q.width < 6 || q.height < 6 || q.left < 0 || q.top < 0 || q.right > vw || q.bottom > vh) continue;
    // a range input is drawn by the fader's own parts: its hit point may be a sibling; check the box centre is ours
    const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    if (!hit || !(el.contains(hit) || hit.contains(el) || (el.parentElement && el.parentElement.contains(hit)))) continue;
    let op = 1; let a = el;
    while (a) { op *= parseFloat(getComputedStyle(a).opacity); a = a.parentElement; }
    if (op < 0.5) continue; // dimmed = shown as unavailable (empty strips, a picking keyboard's others)
    const on = el.classList.contains('on') || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';
    const sig = `${el.tagName}|${String(el.className?.baseVal ?? el.className)}|${el.getAttribute('role') || ''}|${el.type || ''}|${on}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const type = (el.type || '').toLowerCase();
    const field = (el.tagName === 'INPUT' && /^(text|search|number|email|url|password|)$/.test(type))
      || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
    // a switch drawn as a track + thumb (v6 Settings' .toggle and .v6-sw): the state is the thumb's place and the
    // track's colour, so thumb vs track must read; today's LED toggles carry words and are not measured
    const led = el.matches('.toggle') ? el.querySelector('.toggle-led') : null;
    const ledThumb = led ? getComputedStyle(led, '::after') : null;
    const sw = (led && ledThumb.content !== 'none' && ledThumb.content !== 'normal') || el.matches('.v6-sw');
    let edge = null;
    if (exempt && el.matches(exempt)) {
      edge = null;
    } else if (field) {
      // the element that draws the field: itself, or a wrapper with the border when the input is bare
      let box = el;
      const bare = (e) => { const c = getComputedStyle(e); return !(parseFloat(c.borderTopWidth) >= 1 && c.borderTopStyle !== 'none') && rgba(c.backgroundColor)[3] < 0.05; };
      for (let k = 0, p = el; k < 3 && bare(box) && p.parentElement; k++) { p = p.parentElement; if (!bare(p)) box = p; }
      const bs = getComputedStyle(box);
      edge = { kind: 'field', rect: rectOf(box), bw: parseFloat(bs.borderTopWidth) || 0, bstyle: bs.borderTopStyle,
        bc: rgba(bs.borderTopColor), fill: rgba(bs.backgroundColor) };
    } else if (sw) {
      const k = led ? ledThumb.backgroundColor : getComputedStyle(el.querySelector('.v6-sw-k') || el, el.querySelector('.v6-sw-k') ? null : '::after').backgroundColor;
      const tr = led ? getComputedStyle(led).backgroundColor : getComputedStyle(el, '::before').backgroundColor;
      edge = { kind: 'switch', rect: rectOf(led || el), thumb: rgba(k), track: rgba(tr),
        on: el.classList.contains('on') || el.getAttribute('aria-checked') === 'true' };
    }
    el.dataset.aud = String(id);
    out.push({ id: id++, tag: el.tagName.toLowerCase(), cls: String(el.className?.baseVal ?? el.className).slice(0, 60),
      testid: el.dataset.testid || '', text: (el.textContent || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 30),
      rect: rectOf(el), edge });
  }
  return out;
}

/**
 * In the page: focus control `id` in keyboard modality and read what its focus changes: its outline or ring
 * shadow, else a focus-within wrapper's border / ring (up to 2 levels), else its ::before / ::after, else its own
 * border / fill. A decoration that is already there unfocused (Arrange's dashed outline, Learn's) is not a change.
 */
function ringOf(id) {
  const el = document.querySelector(`[data-aud="${id}"]`);
  if (!el) return null;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const ring = (cs) => {
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) {
      return { kind: 'outline', key: `${cs.outlineStyle} ${cs.outlineColor} ${cs.outlineWidth} ${cs.outlineOffset}`,
        c: cs.outlineColor, w: parseFloat(cs.outlineWidth), off: parseFloat(cs.outlineOffset) || 0 };
    }
    return null;
  };
  const shadow = (cs) => {
    if (!cs.boxShadow || cs.boxShadow === 'none') return null;
    // a ring: "<colour> 0px 0px 0px <spread>" (inset or not)
    const m = cs.boxShadow.match(/((?:rgba?|oklab|oklch|color)\([^)]*\))\s+0px\s+0px\s+0px\s+([\d.]+)px(\s+inset)?/);
    return m ? { kind: 'shadow', key: cs.boxShadow, c: m[1], w: parseFloat(m[2]), off: m[3] ? -parseFloat(m[2]) : 0 } : null;
  };
  const look = (e, pseudo) => {
    const cs = getComputedStyle(e, pseudo);
    return { ring: ring(cs), shadow: shadow(cs), box: cs.boxShadow, border: cs.borderTopColor, bw: cs.borderTopWidth,
      fill: cs.backgroundColor, op: cs.opacity, content: cs.content };
  };
  const anc = [el.parentElement, el.parentElement?.parentElement].filter(Boolean);
  const before = { self: look(el), b: look(el, '::before'), a: look(el, '::after'), anc: anc.map((e) => look(e)) };
  el.focus({ preventScroll: true });
  if (document.activeElement !== el) return { focusable: false };
  const now = { self: look(el), b: look(el, '::before'), a: look(el, '::after'), anc: anc.map((e) => look(e)) };
  const r = { focusable: true, visible: el.matches(':focus-visible') };
  const rectOf = (e) => { const q = e.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
  const pick = (ind, e) => ({ ...r, kind: ind.kind, c: rgba(ind.c), w: ind.w, off: ind.off, rect: rectOf(e) });
  const changed = (x, y) => x && (!y || x.key !== y.key);
  if (changed(now.self.ring, before.self.ring)) return pick(now.self.ring, el);
  if (changed(now.self.shadow, before.self.shadow)) return pick(now.self.shadow, el);
  for (let k = 0; k < anc.length; k++) {
    const x = now.anc[k], y = before.anc[k];
    if (changed(x.ring, y.ring)) return pick(x.ring, anc[k]);
    if (changed(x.shadow, y.shadow)) return pick(x.shadow, anc[k]);
    if (x.border !== y.border && parseFloat(x.bw) >= 1) {
      return { ...r, kind: 'wrap-border', c: rgba(x.border), w: 3, off: 0, rect: rectOf(anc[k]) };
    }
  }
  for (const [k, ps] of [['b', '::before'], ['a', '::after']]) {
    const x = now[k], y = before[k];
    if (x.content !== 'none' && (x.fill !== y.fill || x.border !== y.border || x.op !== y.op)) {
      return { ...r, kind: `pseudo${ps}`, c: rgba(x.fill !== y.fill ? x.fill : x.border), inside: true, rect: rectOf(el) };
    }
  }
  if (now.self.border !== before.self.border && parseFloat(now.self.bw) >= 1) {
    return { ...r, kind: 'border', c: rgba(now.self.border), w: 3, off: 0, rect: rectOf(el) };
  }
  if (now.self.fill !== before.self.fill) return { ...r, kind: 'fill', c: rgba(now.self.fill), inside: true, rect: rectOf(el) };
  return { ...r, kind: 'none' };
}

/**
 * Audit what the page shows now: writes <out>/audit-<label>.json and returns the counts.
 * @param {import('playwright').Page} page
 * @param {{out:string, label:string, shot:string, ui?:boolean, maxControls?:number, quiet?:boolean,
 *   fades?:Array<{sel:string, side:'left'|'right', px:number}>, boundaryExempt?:string[]}} o
 *   shot: the screenshot just taken of this state (for the glare figures); fades: see collectRuns; boundaryExempt:
 *   selectors of fields whose boundary is not needed to find them (each with its reason where it is passed)
 * @returns {Promise<{count:number, fails:number, lowest:string, failRows:object[], ui?:object}>}
 */
export async function audit(page, o) {
  const { out, label, shot } = o;
  const runs = await page.evaluate(collectRuns, o.fades || []);
  const controls = o.ui ? await page.evaluate(collectControls, [o.maxControls || 80, (o.boundaryExempt || []).join(', ') || null]) : [];
  const hide = await page.addStyleTag({ content: '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }' });
  await page.waitForTimeout(120);
  const buf = await page.screenshot();
  await hide.evaluate((n) => n.remove());
  const img = decodePng(buf);
  let shown = null; // the screenshot with the text, for runs under an overlay's shadow
  const results = [];
  for (const r of runs) {
    const med = medianIn(img, [r.rect]);
    if (!med) continue;
    let fg = blend(r.rgba, r.op, med);
    let cr = ratio(fg, med);
    if (r.shaded && cr < 4.5) {
      // under a drop shadow the text is darkened as much as its background: read the rendered ink (the 90th
      // percentile of the run's pixels by contrast with the background) instead of the computed colour
      shown ||= decodePng(fs.readFileSync(shot));
      const px = [];
      const x0 = Math.round(r.rect.x), y0 = Math.round(r.rect.y), x1 = Math.round(r.rect.x + r.rect.w), y1 = Math.round(r.rect.y + r.rect.h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (x < 0 || y < 0 || x >= shown.width || y >= shown.height) continue;
        const i = (y * shown.width + x) * 4; const c = [shown.data[i], shown.data[i + 1], shown.data[i + 2]];
        px.push([ratio(c, med), c]);
      }
      px.sort((a, b) => a[0] - b[0]);
      const ink = px.length ? px[Math.floor(px.length * 0.9)] : null;
      if (ink) { cr = ink[0]; fg = ink[1]; }
    }
    const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);
    const need = large ? 3 : 4.5;
    results.push({ ...r, fg: rgb(fg), bg: `rgb(${med.join(',')})`, cr: Math.round(cr * 100) / 100, need, pass: cr >= need });
  }
  const fails = results.filter((r) => !r.pass && !r.disabled && !r.faded);
  const dis = results.filter((r) => !r.pass && (r.disabled || r.faded));
  const minRow = results.filter((r) => !r.disabled && !r.faded).sort((a, b) => a.cr - b.cr).slice(0, 8);
  const strip = ({ rgba, rect, ...r }) => r;
  const report = { label, count: results.length, fails: fails.map(strip), disabledFails: dis.map(strip),
    lowest: minRow.map(strip), glare: glare(shot) };

  let ui = null;
  if (o.ui) {
    // keyboard modality first, so a script focus() shows :focus-visible the way Tab would (Chromium's heuristic)
    await page.keyboard.press('Shift');
    await page.evaluate(() => document.activeElement?.blur?.());
    const rings = [];
    const bounds = [];
    for (const c of controls) {
      const f = await page.evaluate(ringOf, c.id).catch(() => null);
      const base = { id: c.id, tag: c.tag, cls: c.cls, testid: c.testid, text: c.text };
      if (f && f.focusable) {
        if (f.kind === 'none') {
          rings.push({ ...base, kind: 'none', cr: 0, need: 3, pass: false, visible: f.visible });
        } else {
          let bg;
          if (f.inside) bg = medianIn(img, [f.rect], 1);
          else {
            const a = f.off; const b = f.off + f.w;
            bg = medianIn(img, b <= 0 ? band(f.rect, a, b) : band(f.rect, Math.max(a, 0), Math.max(b, 1)), 1);
          }
          if (bg) {
            const fg = blend(f.c, 1, bg);
            const cr = ratio(fg, bg);
            rings.push({ ...base, kind: f.kind, ring: rgb(fg), bg: `rgb(${bg.join(',')})`, cr: Math.round(cr * 100) / 100,
              need: 3, pass: cr >= 3, visible: f.visible });
          }
        }
      }
      const e = c.edge;
      if (e && e.kind === 'field') {
        const out1 = medianIn(img, band(e.rect, 1, 4), 1);
        if (!out1) continue;
        const bc = e.bw >= 1 && e.bstyle !== 'none' ? ratio(blend(e.bc, 1, out1), out1) : 0;
        const fc = ratio(blend(e.fill, 1, out1), out1);
        const cr = Math.max(bc, fc);
        bounds.push({ ...base, kind: 'field', border: Math.round(bc * 100) / 100, fill: Math.round(fc * 100) / 100,
          cr: Math.round(cr * 100) / 100, need: 3, pass: cr >= 3, bg: `rgb(${out1.join(',')})` });
      } else if (e && e.kind === 'switch') {
        const behind = medianIn(img, [e.rect], 1);
        if (!behind) continue;
        const track = e.track ? blend(e.track, 1, behind) : behind;
        const cr = ratio(blend(e.thumb, 1, track), track);
        bounds.push({ ...base, kind: `switch ${e.on ? 'on' : 'off'}`, thumb: rgb(blend(e.thumb, 1, track)),
          cr: Math.round(cr * 100) / 100, need: 3, pass: cr >= 3, bg: rgb(track) });
      }
    }
    await page.evaluate(() => {
      document.activeElement?.blur?.();
      for (const el of document.querySelectorAll('[data-aud]')) delete el.dataset.aud;
    });
    ui = { rings: rings.length, ringFails: rings.filter((r) => !r.pass), bounds: bounds.length,
      boundFails: bounds.filter((r) => !r.pass), lowestRings: rings.filter((r) => r.kind !== 'none')
        .sort((x, y) => x.cr - y.cr).slice(0, 5) };
    report.ui = ui;
  }
  fs.writeFileSync(path.join(out, `audit-${label}.json`), JSON.stringify(report, null, 1));
  if (!o.quiet) {
    console.log(`[audit ${label}] ${results.length} text runs, ${fails.length} fail, ${dis.length} disabled / under an edge fade (exempt) below`
      + (ui ? `; ${ui.rings} rings, ${ui.ringFails.length} fail; ${ui.bounds} boundaries, ${ui.boundFails.length} fail` : ''));
    for (const f of fails) console.log(`  FAIL ${f.cr} < ${f.need}  "${f.text}"  .${f.cls}  fg ${f.fg} op ${f.op.toFixed(2)} bg ${f.bg}`);
    if (ui) {
      for (const f of ui.ringFails) console.log(`  RING ${f.kind} ${f.cr} < 3  <${f.tag}> "${f.text}" .${f.cls} ${f.testid} ${f.ring || ''} on ${f.bg || ''}`);
      for (const f of ui.boundFails) console.log(`  EDGE ${f.kind} ${f.cr} < 3  <${f.tag}> "${f.text}" .${f.cls} ${f.testid} on ${f.bg}`);
    }
    for (const f of minRow.slice(0, 3)) console.log(`  low  ${f.cr}  "${f.text}"  .${f.cls}`);
  }
  return { count: results.length, fails: fails.length, lowest: minRow[0] ? `${minRow[0].cr} "${minRow[0].text}"` : '',
    failRows: fails.map(strip), ui };
}
