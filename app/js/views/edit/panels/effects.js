// OWNER: effects agent (views/edit/CONTRACT.md §6). Stub from hv2-edit-setup: replace mount() with the Effects tab
// (Space / Echo / Chorus lines, Vibe menu, "How much of each sound goes in", Fine-tune).
import { SPACE_PRESETS, matchPreset } from '../../../shared/fx-presets.js';
import { stubMount } from './_stub.js';

export default {
  id: 'effects',
  icon: 'room',
  mount(el, ctx, opts) {
    return stubMount(el, ctx, opts, {
      id: 'effects', label: 'Effects panel', file: 'panels/effects.js', icon: 'room',
      title: () => {
        const sp = matchPreset(SPACE_PRESETS, ctx.valueOf);
        return ['The room is ', { text: sp ? `a ${sp.name}` : 'custom', control: '.ev2-stub' }];
      },
    });
  },
};
