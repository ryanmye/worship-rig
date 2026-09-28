// OWNER: setlist agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the setlist column
// (setlist picker, song list, reorder/rename/duplicate/delete, search, factory + library browsers, import/export).
import { stubMount } from './_stub.js';

export default {
  id: 'setlist',
  region: 'left',
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, { id: 'setlist', label: 'Setlist', file: 'panels/setlist.js' });
  },
};
