// UI component primitives (SPEC §13). Every component is a function returning { el, set(value), destroy() }
// and takes its callback(s) in the options object. Shared by views/perform.js (ui-core) and views/edit.js +
// views/settings.js (ui-edit).
//
//   fader({ label, path, color, min, max, curve:'lin'|'log'|'taper', unit, step, default, format, vertical, value, onChange,
//           relative?, resetOnDoubleClick? })   relative drag + no dblclick reset = Perform; defaults = Edit behaviour
//       + input, get(), setIndicator(value|null), setDisabled(b), setLabel(s), setMuted(b)
//   knob(...)                      same API, compact horizontal variant
//   toggle({ label, value, onChange, tag?, onLabel?, offLabel? })            + get(), setDisabled(b)
//   segmented({ options:[{value,label}], value, label, onChange })         + get(), setOptions(opts), setDisabled(b, value?)
//   select({ options:[{value,label,group?}], value, label, onChange })     + input, get(), setOptions(opts), setDisabled(b)
//   stepper({ min, max, step, value, label, format, wrap, onChange })      + get(), setDisabled(b)
//   keyGrid({ onSelect(pc), label })  .set({pc, minor})                     + setDisabled(b)
//   miniKeyboard({ low, high, from:21, to:108, onRange({low,high}) })  .set({low, high})
//   pianoKeyboard({ from:36, to:96, onNoteOn(note, vel), onNoteOff(note) })  .set(heldSet)  + releaseAll()
//   meter({ engine } | { analysers: () => [anL, anR] }, vertical?, compact?)  (rAF; set() unused)
//   chordReadout({ label })  .set(chord|null)
//   wheelStrip({ onSwell(), onWheel(v) })  .set({ value, swelling, target, pickup, hardware, bendMode, bend })
//   setlistStrip({ onSelect(id, index), onReorder(from, to) })  .set({ songs:[{id,name,key}], currentId, currentIndex, loadingId, reorderable })
//
// H-v2 building blocks (design/H-v2/implementation.md step 1):
//   onTile({ label, color, on, sub?, onToggle(on) })       ON/OFF tile = the mute
//       + get(), setLabel(s), setSub(s), setChanged(b), setDisabled(b)
//   stepChip({ label, steps:[{value,label}], value, onChange, color, owner?, loaded?, cycle?, format?, lit?,
//              amount?, hint?, footnote?, fine?, mount? })   2 steps = a tap cycles; more = opens stepPanel in the strip
//       + get(), setLoaded(v), setChanged(b|null), setHint(s), setDisabled(b), open({focus}), close(), isOpen
//   stepPanel({ title, owner?, hint?, steps, value, loaded?, color?, footnote?, fine?, onPick, onFine?, onClose? })
//   headerChipRow({ label, options:[{id,label,hint,own?}], more?, value, onSelect(id), changed?, icon? })
//       + get(), setChanged(b), setDisabled(b), setOptions(opts, more?)
//       presets: SPACE_CHIPS, SPACE_MORE, ECHO_CHIPS, SONG_OWN
//   holdButton({ label|content, ms:600, requireHold:bool|()=>bool, onActivate, onHoldStart?, onHoldCancel?,
//                holdText?, hintText? })   + holding, progress, setContent(c), setRequireHold(b), setDisabled(b),
//                                            refresh(), cancel()
//   quickSheet({ anchor?, onTempo, onSwell, onTouch, onPedalReversed, onRestartAudio, onAllSettings, onClose, state })
//       .set({ songName, tempo, swell, touch, pedal, pedalReversed, sound, latencyMs, locked, echoSynced })
//       + open({focus}), close(), isOpen, tap(now?)
//   eqKeyboard({ store, engine, slotIndex, controller?, toast?, compact?, rta? }) / eqMiniCurve({ store, slotIndex,
//       onOpen? })   the keyboard Tone EQ and its sparkline (CONTRACT_CHANGES "## eq-ui")
//   levelMeter({ read: () => ({peak, rms})|null, label? })   thin slot level bar (rAF only while on screen; polish-1)
//   openOverlay({ el, onClose, swallow, closeOnOutside, passThrough, group }) → close(reason)
//       Esc / outside-tap rules shared by the step panels, the "…" menu and the Quick sheet
//
// Helpers: h(tag, attrs, ...children), setText, disposer(), rafCoalesce(fn), blurAfterPointer(el), posToValue/valueToPos.
export { fader, knob, posToValue, valueToPos } from './fader.js';
export { toggle, segmented, select, stepper } from './buttons.js';
export { keyGrid, miniKeyboard, pianoKeyboard, keyLayout, isBlack } from './keys.js';
export { meter, dbToMeter } from './meter.js';
export { levelMeter } from './levelMeter.js';
export { chordReadout, wheelStrip } from './readouts.js';
export { setlistStrip } from './setlist.js';
export { h, setText, setAttr, disposer, rafCoalesce, blurAfterPointer, nextId, relativeDrag } from './util.js';
export { INSTRUMENT_GROUPS, groupOf, groupInstruments, stageName } from './instrument-groups.js';
export { onTile } from './onTile.js';
export { stepChip, AMOUNT_STEPS, OCTAVE_STEPS, SUSTAIN_STEPS, formatAmount, formatOctave } from './stepChip.js';
export { stepPanel, sameStep } from './stepPanel.js';
export { headerChipRow, SPACE_CHIPS, SPACE_MORE, ECHO_CHIPS, SONG_OWN } from './headerChipRow.js';
export { holdButton } from './holdButton.js';
export { quickSheet, TOUCH_OPTIONS, tapBpm } from './quickSheet.js';
export { openOverlay, openOverlayCount, PASS_THROUGH } from './overlay.js';
export { eqKeyboard, eqMiniCurve } from './eq-keyboard.js';
