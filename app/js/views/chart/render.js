// Chart view (D7, hidden): model → DOM. No store, no listeners; index.js calls renderChart on every change.
// Each line is a row of segments; a segment stacks its chord over its lyric piece, both monospace, so the chord sits
// over the character at the parser's `at` (logic.js lineSegments). Text goes in through textContent only.
import { h } from '../components/util.js';
import { lineSegments } from './logic.js';

const KIND_LABEL = Object.freeze({
  verse: 'Verse', chorus: 'Chorus', prechorus: 'Pre-chorus', bridge: 'Bridge', tag: 'Tag', intro: 'Intro',
  outro: 'Outro', interlude: 'Interlude', instrumental: 'Instrumental', tab: 'Tab', grid: 'Grid', other: '',
});

/** Heading text for a section: its own name, else its kind. */
const sectionTitle = (s) => s.name || KIND_LABEL[s.kind] || '';

function renderLine(line, raw) {
  if (line.comment) return h('div.chv-comment', { text: line.lyric });
  if (raw) return h('div.chv-raw', { text: line.lyric });
  const segs = lineSegments(line);
  const hasChords = segs.some((s) => s.chord);
  const row = h('div.chv-line', { class: hasChords ? '' : 'no-chords' });
  for (const s of segs) {
    row.append(h('span.chv-seg', {},
      hasChords ? h('span.chv-ch', { class: s.annotation ? 'annot' : '', text: s.chord || ' ' }) : null,
      h('span.chv-ly', { text: s.text || (hasChords ? ' ' : '') })));
  }
  return row;
}

/**
 * Fill `el` with a chart.
 * @param {HTMLElement} el the scrolling body
 * @param {object} model transposed chart model
 * @returns {number} how many lines were drawn
 */
export function renderChart(el, model) {
  const out = [];
  let lines = 0;
  for (const s of model.sections || []) {
    if (!s) continue;
    const title = sectionTitle(s);
    const sec = h('section.chv-sec', { dataset: { kind: s.kind || 'other' } },
      title ? h('h3.chv-sec-h', { text: s.recall ? `${title} (again)` : title }) : null);
    const raw = s.kind === 'tab' || s.kind === 'grid';
    for (const l of s.lines || []) {
      if (!l) continue;
      sec.append(renderLine(l, raw));
      lines++;
    }
    out.push(sec);
  }
  el.replaceChildren(...out);
  return lines;
}
