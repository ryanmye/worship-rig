// UI v6 Edit › Change instrument (U5b; native DECISIONS D15 "kinds of sound appear only in the instrument chooser";
// mockup native/docs/design/mockups/edit.html "Change instrument", mock_edit.py chooser).
//
// A dialog over the Edit view: the kinds of sound on the left (the groups the engine's instrument list really has,
// slot.js groupOf / groupOrder, in plain plural words; 'Guitar' and 'Guitar & Plucks' share one row), the sounds of
// the chosen kind as tiles (the one playing now marked), a search box, the note on what is kept, and Use <name> /
// Cancel. Nothing is written until Use: the caller (instrument.js) then does today's picker write with its 8 s Undo.
// There is no preview: today's picker and the engine have no audition of an instrument that is not in a slot, so the
// mockup's ▶ is left out (U5b report).
import { h, setText } from '../../edit/lib.js';
import { groupOf, groupOrder } from '../../edit/panels/slot.js';

/** The engine's group → the chooser's words (mockup cats). Unknown groups keep their own name. */
export const KIND_LABELS = Object.freeze({
  Piano: 'Pianos', 'Electric Piano': 'Electric pianos', Organ: 'Organs', 'Synth Pads': 'Pads',
  'Synth Keys': 'Synth keys',
  'Brass & Leads': 'Brass & leads', 'Mallets & Bells': 'Mallets & bells', 'Guitar & Plucks': 'Guitars & plucks',
  Guitar: 'Guitars & plucks', Bass: 'Bass', 'My Samples': 'My Samples', Other: 'Other',
});
const TYPE_WORDS = { sampler: 'sampled', synth: 'synth', organ: 'organ' };
const HIDDEN = new Set(['synth:drone-osc']);
const refKey = (ref) => (ref ? `${ref.type}:${ref.id}` : '');
const kindOf = (it) => KIND_LABELS[groupOf(it)] || groupOf(it);
const ORD = ['1st', '2nd', '3rd'];
const ordinal = (n) => ORD[n - 1] || `${n}th`;
let seq = 0;

/**
 * The chooser's kinds, in today's picker order, for an instrument list.
 * @param {object[]} list  listInstruments() entries
 * @returns {Array<{label:string, items:object[]}>}
 */
export function chooserKinds(list) {
  const out = [];
  for (const g of groupOrder(list)) {
    const label = KIND_LABELS[g] || g;
    let k = out.find((x) => x.label === label);
    if (!k) out.push((k = { label, items: [] }));
    k.items.push(...list.filter((it) => groupOf(it) === g));
  }
  return out;
}

/**
 * Open the chooser.
 * @param {object} o
 * @param {HTMLElement} o.host            the Edit view's body (the dialog covers it; the bottom row stays live)
 * @param {() => object[]} o.instruments  the engine's list (ctx.instruments)
 * @param {number} o.slot                 the instrument's place (0-based)
 * @param {{instrument:object}|null} o.current  the slot (null: an empty place)
 * @param {string} [o.currentName]        its display name
 * @param {string} [o.color]              the place's colour (--c: the chosen kind, tile and Use)
 * @param {(value:string) => void} o.onUse   'type:id' of the chosen sound (only when it differs from the current one)
 * @param {(() => void)|null} [o.onRemove]  "Remove this sound…" (filled places)
 * @param {(reason:string) => void} [o.onClose]  'use' | 'cancel' | 'escape' | 'remove' | 'api'
 * @param {(open:boolean) => void} [o.markDialog]
 * @returns {{el:HTMLElement, close(reason?:string):boolean, refresh():void, _debug:object}}
 */
export function openChooser(o) {
  const uid = `v6e-ch-${(seq += 1)}`;
  const cur = o.current ? refKey(o.current.instrument) : '';
  let selected = cur;
  let query = '';
  let kind = null;
  let open = true;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const title = h('h3.v6e-ch-title', { id: `${uid}-t`, text: o.current ? 'Change instrument' : 'Choose a sound' });
  const sub = h('span.v6e-ch-sub', {
    text: o.current ? `for the ${ordinal(o.slot + 1)} instrument, now ${o.currentName || ''}`
      : `for the ${ordinal(o.slot + 1)} instrument, empty now`,
  });
  const search = h('input.v6e-ch-search', {
    type: 'search', placeholder: 'Search sounds', 'aria-label': 'Search sounds', autocomplete: 'off',
    spellcheck: 'false', 'data-testid': 'v6e-ch-search',
  });
  const cats = h('div.v6e-ch-cats', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Kinds of sound',
    'data-testid': 'v6e-ch-cats' });
  const tiles = h('div.v6e-ch-tiles', { role: 'tabpanel', id: `${uid}-tiles`, 'data-testid': 'v6e-ch-tiles' });
  const keep = h('small.v6e-ch-keep', { 'data-testid': 'v6e-ch-keep', text: o.current
    ? 'Keeps its level, Space and Echo, range and Sustain; its own sound settings start fresh.'
    : 'It takes this place with the usual settings for it.' });
  const cancel = h('button.btn.ghost.v6e-ch-cancel', {
    type: 'button', text: 'Cancel', 'data-testid': 'v6e-ch-cancel',
  });
  const use = h('button.btn.v6e-ch-use', { type: 'button', 'data-testid': 'v6e-ch-use' });
  const remove = o.current && o.onRemove ? h('button.btn.ghost.v6e-ch-remove', {
    type: 'button', text: 'Remove this sound…', 'data-testid': 'v6e-ch-remove',
  }) : null;
  const dlg = h('div.v6e-chooser', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title.id, 'data-testid': 'v6e-chooser', tabindex: '-1',
  },
  h('div.v6e-ch-h', {}, title, sub, h('span.v6e-sp'), search),
  h('div.v6e-ch-b', {}, cats, tiles),
  h('div.v6e-ch-f', {}, remove || h('span'), keep, cancel, use));
  const back = h('div.v6e-ch-back', { 'data-testid': 'v6e-chooser-back',
    style: o.color ? { '--c': o.color } : undefined }, dlg);
  o.host.append(back);
  o.markDialog?.(true);

  const list = () => o.instruments().filter((it) => {
    const v = refKey(it.ref);
    return (!HIDDEN.has(v) && !it.hidden) || v === cur;
  });
  const nameOf = (v) => list().find((it) => refKey(it.ref) === v)?.name || '';

  function render({ focusTile = false } = {}) {
    const all = list();
    const kinds = chooserKinds(all);
    if (!kind || !kinds.some((k) => k.label === kind)) {
      kind = (cur && kinds.find((k) => k.items.some((it) => refKey(it.ref) === cur))?.label) || kinds[0]?.label || null;
    }
    const q = query.trim().toLowerCase();
    cats.replaceChildren(...kinds.map((k) => {
      const on = !q && k.label === kind;
      const n = q ? k.items.filter((it) => it.name.toLowerCase().includes(q)).length : k.items.length;
      const b = h('button.v6e-ch-cat', {
        type: 'button', role: 'tab', 'aria-selected': String(on), 'aria-controls': tiles.id, tabindex: on ? '0' : '-1',
        class: on ? 'on' : '', dataset: { kind: k.label }, disabled: !!q && !n,
      }, h('span', { text: k.label }), h('small', { text: String(n) }));
      b.addEventListener('click', (e) => {
        kind = k.label;
        if (query) {
          query = '';
          search.value = '';
        }
        render();
        // skeptic UI6-U5b F2: the render replaced this button; a keyboard press (Enter / Space) keeps the focus on
        // the kind, else it fell to <body>, where ← / → are Prev / Next song under the open dialog. A pointer click
        // leaves nothing focused, as every Edit button (shell.js blur)
        if (e.detail === 0) cats.querySelector(`[data-kind="${CSS.escape(k.label)}"]`)?.focus();
      });
      return b;
    }));
    const shown = q ? all.filter((it) => it.name.toLowerCase().includes(q))
      : (kinds.find((k) => k.label === kind)?.items || []);
    tiles.setAttribute('aria-label', q ? `Sounds matching “${query.trim()}”` : kind || 'Sounds');
    if (!all.length) tiles.replaceChildren(h('p.v6e-hint', { text: 'Instruments appear once sound has started.' }));
    else if (!shown.length) tiles.replaceChildren(h('p.v6e-hint', { text: 'No sound has that name.' }));
    else {
      tiles.replaceChildren(...shown.map((it) => {
        const v = refKey(it.ref);
        const isCur = v === cur;
        const b = h('button.v6e-ch-tile', {
          type: 'button', 'aria-pressed': String(v === selected), class: `${v === selected ? 'sel' : ''}${isCur
            ? ' cur' : ''}`, dataset: { value: v }, title: it.license ? `${it.name} — ${it.license}` : it.name,
        }, h('b', { text: it.name }),
        h('small', { text: q ? `${TYPE_WORDS[it.ref.type] || it.ref.type} · ${kindOf(it)}`
          : TYPE_WORDS[it.ref.type] || it.ref.type }),
        isCur ? h('em.v6e-ch-now', { text: 'playing now' }) : null);
        b.addEventListener('click', () => {
          selected = v;
          render();
          tiles.querySelector(`[data-value="${CSS.escape(v)}"]`)?.focus();
        });
        b.addEventListener('dblclick', () => doUse());
        return b;
      }));
    }
    const nm = nameOf(selected);
    const can = !!selected && selected !== cur && !!nm;
    use.disabled = !can;
    setText(use, can ? `Use ${nm}` : 'Pick a sound');
    if (focusTile) {
      const t = tiles.querySelector('.v6e-ch-tile.sel') || tiles.querySelector('.v6e-ch-tile');
      (t || search).focus({ preventScroll: true });
      t?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  function close(reason = 'api') {
    if (!open) return false;
    open = false;
    back.remove();
    o.markDialog?.(false);
    o.onClose?.(reason);
    if ((reason === 'cancel' || reason === 'escape') && opener && document.contains(opener)) {
      opener.focus({ preventScroll: true });
    }
    return true;
  }
  function doUse() {
    const v = selected;
    if (!v || v === cur || !nameOf(v)) return;
    close('use');
    o.onUse(v);
  }

  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      tiles.querySelector('.v6e-ch-tile')?.focus();
    }
    e.stopPropagation(); // typed letters never reach the computer keyboard / song navigation
  });
  cancel.addEventListener('click', () => close('cancel'));
  use.addEventListener('click', doUse);
  remove?.addEventListener('click', () => {
    close('remove');
    o.onRemove();
  });
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close('cancel');
  });
  // arrows move through the tiles (and the kinds), Enter on a chosen tile uses it; Tab stays inside the dialog
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const f = [...dlg.querySelectorAll('button:not([disabled]), input')].filter((x) => x.offsetParent !== null
        && x.tabIndex >= 0);
      if (!f.length) return;
      const k = f.indexOf(document.activeElement);
      if (e.shiftKey && k <= 0) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && k === f.length - 1) {
        e.preventDefault();
        f[0].focus();
      }
      return;
    }
    const t = e.target;
    if (t.classList?.contains('v6e-ch-tile')) {
      const all = [...tiles.querySelectorAll('.v6e-ch-tile')];
      const k = all.indexOf(t);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        e.stopPropagation();
        all[Math.max(0, Math.min(all.length - 1, k + step))]?.focus();
      } else if (e.key === 'Enter' && t.dataset.value === selected && selected !== cur) {
        e.preventDefault();
        doUse();
      }
      return;
    }
    if (t.classList?.contains('v6e-ch-cat') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const all = [...cats.querySelectorAll('.v6e-ch-cat:not([disabled])')];
      const k = all.indexOf(t);
      const n = all[(k + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
      e.preventDefault();
      e.stopPropagation();
      n?.click();
      cats.querySelector(`[data-kind="${CSS.escape(n?.dataset.kind || '')}"]`)?.focus();
    }
  });

  render({ focusTile: true });

  return {
    el: back,
    close,
    /** The instrument list changed (the engine started, a My Samples rescan). */
    refresh: () => open && render(),
    _debug: { selected: () => selected, kind: () => kind },
  };
}
