// Placeholder mount used by the hv2-edit-setup stubs. Each owner replaces their panel's mount() and drops the import;
// the integrator deletes this file once no panel imports it.
import { h, setText } from '../lib.js';

/**
 * Render a placeholder that proves the ctx wiring: it follows the current song through ctx.subscribe and (for block
 * panels) sets a sentence title.
 * @param {HTMLElement} el
 * @param {object} ctx      panel ctx (CONTRACT.md §3)
 * @param {object} opts     mount options
 * @param {{id:string, label:string, file:string, title?:(song:object, opts:object) => Array}} o
 * @returns {{destroy():void, update(opts:object):void}}
 */
export function stubMount(el, ctx, opts, o) {
  const line = h('span.ev2-stub-song');
  const box = h('div.ev2-stub', { dataset: { stub: o.id } },
    h('b', { text: o.label }), ' — coming soon ', h('code', { text: `views/edit/${o.file}` }), h('br'), line);
  el.replaceChildren(box);
  let cur = { ...opts };
  const render = () => {
    const s = ctx.song();
    box.dataset.songId = s ? s.id : '';
    box.dataset.opts = JSON.stringify(cur);
    setText(line, s ? `Song: ${s.name}` : 'No song selected');
    if (o.title && s) ctx.setTitle(o.title(s, cur), { icon: o.icon, sub: `Placeholder for ${o.file}` });
  };
  ctx.subscribe((e) => {
    if (e.songChanged || e.full || e.rels.length) render();
  });
  render();
  return {
    update(next) {
      cur = { ...next };
      render();
    },
    destroy() {
      el.replaceChildren();
    },
  };
}
