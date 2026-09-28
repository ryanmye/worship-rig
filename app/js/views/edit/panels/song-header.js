// OWNER: song agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the song header
// (LIVE badge, name, KEY chip, BPM + Tap, Notes, "⋯ Song" menu, "☰ Songs" at < 1250 px).
import { stubMount } from './_stub.js';

export default {
  id: 'song-header',
  region: 'head',
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, { id: 'song-header', label: 'Song header', file: 'panels/song-header.js' });
  },
};
