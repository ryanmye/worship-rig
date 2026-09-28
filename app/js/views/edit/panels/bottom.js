// OWNER: drone+bottom agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the keyboard
// row (legend, per-slot range bars, 61-key keyboard, output meter, Fade out, PANIC).
import { stubMount } from './_stub.js';

export default {
  id: 'bottom',
  region: 'bottom',
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, { id: 'bottom', label: 'Keyboard row', file: 'panels/bottom.js' });
  },
};
