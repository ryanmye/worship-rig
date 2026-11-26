// The right sidebar's modules, in their default order (D15, D16; UI6-build-plan U3). Each is one self-contained file:
// {id, label, blurb, icon, badge?(state, v) → {live, text, title}|null, mount(el, ctx) → {destroy()}}. To add one
// (Chart in 2.1, Tone), append it here; the sidebar shows it on every device after the ones the player has ordered.
// U-METRO (D23.3): Click (the metronome) came after U3, so a layout saved before it gets it appended, shown.
import drone from './drone.js';
import setlist from './setlist.js';
import notes from './notes.js';
import metronome from './metronome.js';

/** Registry order = the order a device starts with. */
export const SIDEBAR_MODULES = Object.freeze([drone, setlist, notes, metronome]);
