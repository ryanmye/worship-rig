// Panel modules the shell registers (views/edit/CONTRACT.md §2). Owned by the shell/integrator: panel agents edit
// only their own file, never this list.
import slot from './slot.js';
import drone from './drone.js';
import effects from './effects.js';
import master from './master.js';
import song from './song.js';
import songHeader from './song-header.js';
import setlist from './setlist.js';
import bottom from './bottom.js';

export default [slot, drone, effects, master, song, songHeader, setlist, bottom];
