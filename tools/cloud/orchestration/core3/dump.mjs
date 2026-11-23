import { FACTORY_SONGS } from '/home/claude/worship-rig/app/js/presets.js';
const out = FACTORY_SONGS.map((s) => ({ id: s.id, patch: s.patch }));
console.log(JSON.stringify(out));
