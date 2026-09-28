// OWNER: song agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the Song panel
// (Easy Transpose, tempo, notes) that the header's KEY / BPM / Notes chips open.
import { keyName } from '../../../shared/music.js';
import { stubMount } from './_stub.js';

export default {
  id: 'song',
  icon: 'song',
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, {
      id: 'song', label: 'Song panel', file: 'panels/song.js', icon: 'song',
      title: (s) => ['This song is in ', { text: keyName(s.hearIn, s.minor), control: '.ev2-stub' },
        s.tempo ? ` at ${Math.round(s.tempo)} BPM` : ''],
    });
  },
};
