// Theme font warming for a runtime theme switch (main.js applyTheme, mini.js createThemeFollower).
// A switch loads the new theme sheet disabled (media="not all"), so its @font-face rules are not in document.fonts
// yet. warmThemeFonts() copies each rule into a FontFace and loads it, so a font-display:block face can't blank text
// when the sheet is enabled. releaseWarmedFonts() then loads the sheet's own (CSS-connected) faces and deletes the
// copies.
//
// themes-final (reviews/themes-critic.md T1/T2/N1): the copies used to carry only weight/style/stretch. Faces added
// through the FontFaceSet win over CSS-connected ones with the same descriptors, so after a runtime switch the chord
// faces lost their ascent-/descent-override (.chord-name 56/51 px instead of 51/51) and a ranged face lost its
// unicode-range (Nave's minus/plus face took every glyph). Every descriptor is copied now, and the copies are
// deleted once the enabled sheet's own faces are loaded, so document.fonts ends up exactly as after a fresh boot.

/** [FontFace descriptor, @font-face property] pairs copied to a warmed face. */
export const FONT_FACE_DESCRIPTORS = Object.freeze([
  ['weight', 'font-weight'], ['style', 'font-style'], ['stretch', 'font-stretch'],
  ['unicodeRange', 'unicode-range'], ['featureSettings', 'font-feature-settings'],
  ['variationSettings', 'font-variation-settings'], ['display', 'font-display'],
  ['ascentOverride', 'ascent-override'], ['descentOverride', 'descent-override'],
  ['lineGapOverride', 'line-gap-override'], ['sizeAdjust', 'size-adjust'],
]);

const settle = (loads, ms) => (loads.length
  ? Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))])
  : Promise.resolve());

/**
 * Copy a (disabled) theme sheet's @font-face rules into document.fonts with all their descriptors and load them.
 * Resolves with the added faces once they are loaded, or after `timeout` ms.
 * @param {CSSStyleSheet|null} sheet
 * @param {Document} [doc]
 * @param {{timeout?: number}} [o]
 * @returns {Promise<FontFace[]>} the faces added (hand them to releaseWarmedFonts)
 */
export async function warmThemeFonts(sheet, doc = document, { timeout = 1500 } = {}) {
  const faces = [];
  const loads = [];
  let rules = [];
  try {
    rules = [...(sheet?.cssRules || [])];
  } catch {
    return faces;
  }
  const FaceRule = doc.defaultView?.CSSFontFaceRule;
  const Face = doc.defaultView?.FontFace;
  if (!FaceRule || !Face) return faces;
  for (const r of rules) {
    if (!(r instanceof FaceRule)) continue;
    const fam = r.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
    const url = /url\(\s*["']?([^"')]+)/.exec(r.style.getPropertyValue('src'))?.[1];
    if (!fam || !url) continue;
    const desc = {};
    for (const [k, p] of FONT_FACE_DESCRIPTORS) {
      const v = r.style.getPropertyValue(p).trim();
      if (v) desc[k] = v;
    }
    try {
      const face = new Face(fam, `url(${url})`, desc);
      doc.fonts.add(face);
      faces.push(face);
      loads.push(face.load().catch(() => {}));
    } catch {
      /* a descriptor the browser rejects: the sheet's own @font-face still loads it */
    }
  }
  await settle(loads, timeout);
  return faces;
}

/**
 * Once the theme sheet is enabled: load its own (CSS-connected) faces of the warmed families from the cache, then
 * delete the warmed copies (T2), so the page never falls back to a blank font-display:block face and document.fonts
 * holds no duplicates. Also used for a switch that was overtaken (its sheet never enabled: nothing to load first).
 * @param {FontFace[]} faces from warmThemeFonts
 * @param {Document} [doc]
 * @param {{timeout?: number}} [o]
 * @returns {Promise<void>}
 */
export async function releaseWarmedFonts(faces, doc = document, { timeout = 1500 } = {}) {
  if (!faces || !faces.length) return;
  const mine = new Set(faces);
  const unq = (f) => f.family.replace(/^["']|["']$/g, '');
  const fams = new Set(faces.map(unq));
  const t0 = Date.now();
  // Chromium lists a just-enabled sheet's @font-face rules in document.fonts only from the next task on (measured:
  // not after a forced style/layout, yes after setTimeout 0), so wait task by task until each family shows up
  let css = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    css = [...doc.fonts].filter((f) => !mine.has(f) && fams.has(unq(f)));
    if (new Set(css.map(unq)).size >= fams.size || Date.now() - t0 > timeout) break;
  }
  const loads = css.filter((f) => f.status === 'unloaded' || f.status === 'loading')
    .map((f) => f.load().catch(() => {}));
  await settle(loads, Math.max(0, timeout - (Date.now() - t0)));
  for (const f of faces) doc.fonts.delete(f);
}
