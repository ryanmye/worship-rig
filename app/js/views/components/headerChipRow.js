// headerChipRow(): the song header's one-tap Space / Echo rows (H-v2 concept §1.5 4a, perform.png). Each chip is a
// plain word + a small hint ("Hall · big", "Dotted 8th · worship echo"); the selected chip is a neutral steel fill
// with a white outline (shared effects never use a slot colour). "Song's own" brings back the song's saved echo.
// Extra presets sit behind "…". At compact widths the row collapses into a pill that opens the row (styles.css).
import { h, setText, disposer } from './util.js';
import { openOverlay } from './overlay.js';

/** The id "Song's own" reports; Perform maps it to the snapshot's own fx values. */
export const SONG_OWN = 'own';

/** Space chips (ids = fx-presets SPACE_PRESETS ids). */
export const SPACE_CHIPS = Object.freeze(
  [
    { id: 'dry', label: 'Dry', hint: 'none' },
    { id: 'room', label: 'Room', hint: 'small' },
    { id: 'stage', label: 'Stage', hint: 'medium' },
    { id: 'hall', label: 'Hall', hint: 'big' },
    { id: 'cathedral', label: 'Cathedral', hint: 'huge' },
  ].map(Object.freeze),
);
/** Space presets behind "…". */
export const SPACE_MORE = Object.freeze([{ id: 'wash', label: 'Ambient Wash', hint: 'biggest' }].map(Object.freeze));
/** Echo chips (ids = fx-presets ECHO_PRESETS ids, plus Song's own). ms only appear in Edit (concept §1.5 4a). */
export const ECHO_CHIPS = Object.freeze(
  [
    { id: 'none', label: 'Off', hint: 'no echo' },
    { id: 'slapback', label: 'Slapback', hint: '1 repeat' },
    { id: 'quarter', label: 'Quarter', hint: 'on the beat' },
    { id: 'dotted', label: 'Dotted 8th', hint: 'worship echo' },
    { id: 'ambient-echo', label: 'Trails', hint: 'long, dark' },
    { id: SONG_OWN, label: 'Song’s own', hint: 'as saved', own: true },
  ].map(Object.freeze),
);

/**
 * One header chip row.
 * @param {object} o
 * @param {string} o.label                        'Space' / 'Echo' (row caption and group name)
 * @param {Array<{id:string,label:string,hint?:string,title?:string,own?:boolean}>} o.options
 * @param {Array<{id:string,label:string,hint?:string,title?:string}>} [o.more]   behind the "…" chip
 * @param {string|null} [o.value]                 selected id (null = none lit)
 * @param {(id:string) => void} [o.onSelect]
 * @param {boolean} [o.changed]                   white dot on the selected chip
 * @param {Node} [o.icon]
 * @returns {{el:HTMLElement, set(id:string|null):void, get():string|null, setChanged(b:boolean):void,
 *            setDisabled(b:boolean):void, setOptions(options:any[], more?:any[]):void, destroy():void}}
 */
export function headerChipRow(o = {}) {
  const d = disposer();
  let value = o.value ?? null;
  let changed = !!o.changed;
  let options = o.options || [];
  let more = o.more || [];
  let disabled = false;
  const label = o.label || '';
  const row = h('div.fxrow', { role: 'radiogroup', 'aria-label': label });
  const caption = h('div.fx-lab', { 'aria-hidden': 'true' }, o.icon || null, h('span', { text: label.toUpperCase() }));
  const pillValue = h('b.fxpill-v');
  const pill = h(
    'button.fxpill',
    { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: `${label}: choose` },
    h('span.fxpill-l', { text: label.toUpperCase() }),
    pillValue,
    h('span.fxpill-caret', { 'aria-hidden': 'true', text: '▾' }),
  );
  const el = h('div.fx-chiprow', { dataset: { row: label.toLowerCase() } }, caption, row, pill);
  let chips = [];
  let moreBtn = null;
  let menu = null;
  let closeMenu = null;
  let closeRow = null;

  const chip = (opt, cls = '') => {
    const b = h(
      `button.fxc${cls}${opt.own ? '.own' : ''}`,
      { type: 'button', role: 'radio', 'aria-checked': 'false', title: opt.title, dataset: { id: opt.id } },
      h('span.fxc-l', { text: opt.label }),
      opt.hint ? h('small', { text: opt.hint }) : null,
      h('em.cd', { hidden: true, title: 'Changed since the song was loaded' }),
    );
    b._id = opt.id;
    b._opt = opt;
    return b;
  };
  const choose = (id, how) => {
    closeMenu?.('api');
    closeRow?.('api');
    const was = value;
    value = id;
    render();
    if (how?.keyboard) (chips.find((b) => b._id === id) || moreBtn)?.focus();
    if (typeof o.onSelect === 'function' && (id !== was || id === SONG_OWN)) o.onSelect(id);
  };
  const openMenu = (focus) => {
    if (menu || disabled) return;
    menu = h(
      'div.fx-more',
      { role: 'group', 'aria-label': `More ${label}`, 'data-perform-overlay': '' },
      ...more.map((opt) => {
        const b = chip(opt);
        b.setAttribute('aria-checked', String(opt.id === value));
        b.classList.toggle('on', opt.id === value);
        b.addEventListener('click', (e) => choose(opt.id, { keyboard: e.detail === 0 }));
        return b;
      }),
    );
    el.append(menu);
    moreBtn.setAttribute('aria-expanded', 'true');
    closeMenu = openOverlay({
      el: menu,
      anchors: [moreBtn],
      swallow: true,
      group: 'fx-more',
      onClose: (reason) => {
        menu?.remove();
        menu = null;
        closeMenu = null;
        moreBtn.setAttribute('aria-expanded', 'false');
        if (reason === 'escape' && focus) moreBtn.focus();
      },
    });
    if (focus) menu.querySelector('button')?.focus();
  };

  const build = () => {
    closeMenu?.('api');
    row.replaceChildren();
    chips = options.map((opt) => chip(opt));
    for (const b of chips) {
      b.addEventListener('click', (e) => choose(b._id, { keyboard: e.detail === 0 }));
      row.append(b);
    }
    moreBtn = null;
    if (more.length) {
      moreBtn = h(
        'button.fxc.more',
        {
          type: 'button',
          'aria-haspopup': 'true',
          'aria-expanded': 'false',
          title: more.map((m) => m.label).join(' · '),
        },
        h('span.fxc-l', { text: '…' }),
        h('em.cd', { hidden: true }),
      );
      moreBtn.setAttribute('aria-label', `More ${label}: ${more.map((m) => m.label).join(', ')}`);
      moreBtn.addEventListener('click', (e) => (menu ? closeMenu('api') : openMenu(e.detail === 0)));
      row.append(moreBtn);
    }
    render();
  };
  const render = () => {
    const cur = chips.find((b) => b._id === value) || null;
    for (const b of chips) {
      const on = b === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.querySelector('.cd').hidden = !(on && changed);
      b.tabIndex = on || (!cur && b === chips[0]) ? 0 : -1;
      b.disabled = disabled;
    }
    const inMore = more.find((m) => m.id === value) || null;
    if (moreBtn) {
      moreBtn.classList.toggle('on', !!inMore);
      setText(moreBtn.querySelector('.fxc-l'), inMore ? inMore.label : '…');
      moreBtn.querySelector('.cd').hidden = !(inMore && changed);
      moreBtn.tabIndex = -1;
      moreBtn.disabled = disabled;
    }
    const sel = options.find((x) => x.id === value) || inMore;
    setText(pillValue, sel ? sel.label : '—');
    pill.classList.toggle('changed', changed);
    pill.disabled = disabled;
  };
  // arrows move focus; Enter / Space choose (so arrowing past Cathedral never applies it mid-song)
  d.listen(row, 'keydown', (e) => {
    const all = moreBtn ? [...chips, moreBtn] : chips;
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = Math.min(all.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = all.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    for (const b of all) b.tabIndex = -1;
    all[j].tabIndex = 0;
    all[j].focus();
  });
  // compact pill: opens the row as a popover (the row's own chips, so there is one set of controls)
  d.listen(pill, 'click', (e) => {
    if (closeRow) return closeRow('api');
    el.classList.add('fx-open');
    pill.setAttribute('aria-expanded', 'true');
    closeRow = openOverlay({
      el: row,
      anchors: [pill],
      swallow: true,
      group: 'fx-row',
      onClose: () => {
        el.classList.remove('fx-open');
        pill.setAttribute('aria-expanded', 'false');
        closeRow = null;
      },
    });
    if (e.detail === 0) (chips.find((b) => b._id === value) || chips[0])?.focus();
  });
  d.add(() => {
    closeMenu?.('api');
    closeRow?.('api');
  });
  build();
  return {
    el,
    set(id) {
      value = id ?? null;
      render();
    },
    get: () => value,
    setChanged(b) {
      changed = !!b;
      render();
    },
    setDisabled(b) {
      disabled = !!b;
      if (disabled) {
        closeMenu?.('api');
        closeRow?.('api');
      }
      render();
    },
    setOptions(opts, moreOpts) {
      options = opts || [];
      if (moreOpts) more = moreOpts;
      build();
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
