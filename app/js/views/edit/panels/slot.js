// OWNER: slot agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the Keys/Pad/Extra/
// Bass sound panel (ON STAGE · THE SOUND ITSELF · WHERE IT PLAYS · Advanced).
import { BLOCKS } from '../lib.js';
import { stubMount } from './_stub.js';

export default {
  id: 'slot',
  icon: 'piano',
  /** @param {HTMLElement} el @param {object} ctx @param {{slot:number, focus?:string}} opts */
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, {
      id: 'slot', label: 'Sound panel', file: 'panels/slot.js', icon: 'piano',
      title: (s, o) => {
        const i = Number(o.slot) || 0;
        const slot = s.patch.slots[i];
        const role = { text: BLOCKS[i].role.toUpperCase(), role: true };
        if (!slot) return [role, ' is empty. ', { text: 'Add a sound', control: '.ev2-stub' }];
        const meta = ctx.findInstrument(slot.instrument);
        return [role, ' plays ', { text: meta ? meta.name : slot.instrument.id, control: '.ev2-stub' }];
      },
    });
  },
};
