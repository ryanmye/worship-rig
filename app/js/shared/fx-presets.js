/**
 * Named FX "spaces" and echo presets — plain param sets applied through the
 * normal parameter grammar (store.set / engine.setParam). No engine code needed.
 *
 * A preset is { id, name, blurb, params: { 'fx.reverb.size': .., ... } }.
 * The UI shows the preset name when the song's current values match one
 * (within tolerance), otherwise "Custom". Applying a preset only touches the
 * paths it lists, so a space preset never resets your delay and vice versa.
 */

/** Room/space presets — reverb only. */
export const SPACE_PRESETS = [
  { id: 'dry', name: 'Dry', blurb: 'No reverb. For a wet PA or when the sound guy adds his own.',
    params: { 'fx.reverb.returnGain': 0 } },
  { id: 'room', name: 'Room', blurb: 'Small, quick. Keys sit close; good for rehearsal rooms and monitors.',
    params: { 'fx.reverb.size': 0.18, 'fx.reverb.damp': 0.6, 'fx.reverb.predelay': 0.01, 'fx.reverb.returnGain': 0.7 } },
  { id: 'stage', name: 'Stage', blurb: 'Medium hall with a little pre-delay so piano attacks stay clear. The Sunday default.',
    params: { 'fx.reverb.size': 0.42, 'fx.reverb.damp': 0.5, 'fx.reverb.predelay': 0.025, 'fx.reverb.returnGain': 1.0 } },
  { id: 'hall', name: 'Hall', blurb: 'Big concert hall. Pads bloom, piano gets lush; back the level off if it muddies.',
    params: { 'fx.reverb.size': 0.65, 'fx.reverb.damp': 0.45, 'fx.reverb.predelay': 0.035, 'fx.reverb.returnGain': 1.15 } },
  { id: 'cathedral', name: 'Cathedral', blurb: 'Huge, dark, long tail. Prayer moments, organ, ambient.',
    params: { 'fx.reverb.size': 0.9, 'fx.reverb.damp': 0.35, 'fx.reverb.predelay': 0.05, 'fx.reverb.returnGain': 1.3 } },
  { id: 'wash', name: 'Ambient Wash', blurb: 'Maximum size, bright, loud return. The pad disappears into it — use with a pad-only song.',
    params: { 'fx.reverb.size': 1.0, 'fx.reverb.damp': 0.25, 'fx.reverb.predelay': 0.06, 'fx.reverb.returnGain': 1.6 } },
];

/** Echo presets — delay only. */
export const ECHO_PRESETS = [
  { id: 'none', name: 'No Echo', blurb: 'Delay off.',
    params: { 'fx.delay.returnGain': 0 } },
  { id: 'slapback', name: 'Slapback', blurb: 'One quick repeat. Gospel/rock organ and EP.',
    params: { 'fx.delay.sync': 'off', 'fx.delay.time': 0.11, 'fx.delay.feedback': 0.08, 'fx.delay.pingpong': false, 'fx.delay.tone': 0.55, 'fx.delay.returnGain': 0.7 } },
  { id: 'quarter', name: 'Quarter Note', blurb: 'Tempo-synced quarter notes, a few repeats. Pads and plucks.',
    params: { 'fx.delay.sync': '1/4', 'fx.delay.feedback': 0.3, 'fx.delay.pingpong': false, 'fx.delay.tone': 0.5, 'fx.delay.returnGain': 0.8 } },
  { id: 'dotted', name: 'Dotted Eighth', blurb: 'The modern-worship delay: dotted eighths ping-ponging. Set the song tempo first.',
    params: { 'fx.delay.sync': '1/8d', 'fx.delay.feedback': 0.38, 'fx.delay.pingpong': true, 'fx.delay.tone': 0.45, 'fx.delay.returnGain': 0.9 } },
  { id: 'ambient-echo', name: 'Ambient Trails', blurb: 'Long, dark, feeding back into the reverb. Ambient and prayer.',
    params: { 'fx.delay.sync': '1/4', 'fx.delay.feedback': 0.6, 'fx.delay.pingpong': true, 'fx.delay.tone': 0.3, 'fx.delay.returnGain': 0.75 } },
];

/** Whole-vibe presets — set several sections at once (space + echo + lofi + master EQ/comp if present). */
export const VIBE_PRESETS = [
  { id: 'sunday', name: 'Sunday', blurb: 'Stage space, no echo, clean.',
    params: { ...pick('stage'), ...pickEcho('none'), 'fx.lofi.amount': 0, 'fx.chorus.returnGain': 0.6 } },
  { id: 'set', name: 'Full Set', blurb: 'Stage space plus dotted-eighth echo — the modern worship band sound.',
    params: { ...pick('stage'), ...pickEcho('dotted'), 'fx.lofi.amount': 0 } },
  { id: 'prayer', name: 'Prayer', blurb: 'Cathedral space, ambient trails.',
    params: { ...pick('cathedral'), ...pickEcho('ambient-echo'), 'fx.lofi.amount': 0 } },
  { id: 'jam', name: 'Jam', blurb: 'Room space, slapback — tight and dry for playing with a band in a small space.',
    params: { ...pick('room'), ...pickEcho('slapback'), 'fx.lofi.amount': 0 } },
  { id: 'lofi', name: 'Lofi Tape', blurb: 'Room space, tape wobble and crackle.',
    params: { ...pick('room'), ...pickEcho('none'), 'fx.lofi.amount': 0.55, 'fx.lofi.wow': 0.5, 'fx.lofi.flutter': 0.3, 'fx.lofi.crackle': 0.5, 'fx.lofi.tone': 0.6, 'fx.lofi.saturation': 0.4 } },
  { id: 'ambient', name: 'Ambient', blurb: 'Ambient wash, long trails, chorus up.',
    params: { ...pick('wash'), ...pickEcho('ambient-echo'), 'fx.lofi.amount': 0, 'fx.chorus.returnGain': 1.0 } },
];

function pick(id) { return SPACE_PRESETS.find(p => p.id === id).params; }
function pickEcho(id) { return ECHO_PRESETS.find(p => p.id === id).params; }

/**
 * Find which preset the current values match. `getValue(path)` reads the
 * song's current value. Returns the preset or null ("Custom").
 */
export function matchPreset(presets, getValue, tol = 0.02) {
  outer: for (const p of presets) {
    for (const [path, v] of Object.entries(p.params)) {
      const cur = getValue(path);
      if (typeof v === 'number') { if (typeof cur !== 'number' || Math.abs(cur - v) > tol) continue outer; }
      else if (cur !== v) continue outer;
    }
    return p;
  }
  return null;
}

/** Apply a preset through a setter (store.set or engine.setParam). */
export function applyPreset(preset, set) {
  for (const [path, v] of Object.entries(preset.params)) set(path, v);
}
