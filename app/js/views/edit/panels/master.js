// OWNER: master agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the Master tab
// (master volume, Tape, Tone EQ, Glue, Wheels & pedal).
import { formatValue } from '../../../shared/params.js';
import { stubMount } from './_stub.js';

export default {
  id: 'master',
  icon: 'master',
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, {
      id: 'master', label: 'Master panel', file: 'panels/master.js', icon: 'master',
      title: () => [{ text: 'MASTER', role: true }, ' is at ',
        { text: formatValue('master.volume', ctx.valueOf('master.volume')), control: '.ev2-stub' }],
    });
  },
};
