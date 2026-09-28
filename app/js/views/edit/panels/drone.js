// OWNER: drone+bottom agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the Drone
// panel.
import { keyName } from '../../../shared/music.js';
import { stubMount } from './_stub.js';

export default {
  id: 'drone',
  icon: 'drone',
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, {
      id: 'drone', label: 'Drone panel', file: 'panels/drone.js', icon: 'drone',
      title: (s) => [
        { text: 'DRONE', role: true }, ' holds ', { text: keyName(s.hearIn, s.minor), control: '.ev2-stub' },
        s.drone.mode === 'off' ? ' (off)' : '',
      ],
    });
  },
};
