// Instrument: the unit in an instrument slot (UnitSlot::Inst0..3, RetireInst0..15). FROZEN by T00b.
// Implemented by T11 (synth.js port, kind "inst.synth"), T12 ("inst.sampler"), T15 ("inst.synth-extra",
// "inst.organ"); the builtin test voice is "inst.test" (graph/builtin_units.cpp). The Model picks the kind as
// "inst." + patch slot `instrument.type`, so a new instrument type is a new registration, nothing else.
//
// The graph routes the core perform opcodes (runtime/command.h NoteOn, NoteOff, Sustain, Bend, LegatoTo, InstParam,
// ReleaseVoice, AllNotesOff, Panic, FadeNote) to Instrument::apply, which decodes them into the virtuals below
// (graph/instrument_apply.cpp). Frames are time-grid frames: the voice must start at exactly `frame` (sub-quantum
// offsets are the instrument's job, ARCHITECTURE 3.3). Note numbers arrive SOUNDING (transpose/octave applied by
// the Model) and velocity arrives as the touch-curved gain.
#pragma once
#include <cstdint>

#include "graph/unit.h"

namespace rig {

/** Voice id handed back in VoiceEnded / used by ReleaseVoice: slot-local, stable while the voice lives. */
using VoiceId = std::uint32_t;

class Instrument : public Unit {
 public:
  /** Decodes core perform opcodes; module opcodes (its task's range) go to applyModule. Do not override. */
  void apply(const Command &c) final;

  /** `velGain` 0..1 after the touch curve (contract 2.4); `vel` the raw 1..127 for velocity layers. */
  virtual void noteOn(int note, int vel, float velGain, std::int64_t frame) = 0;
  /** `forced`: release even if the instrument holds notes itself (the pedal lives in the Model). */
  virtual void noteOff(int note, std::int64_t frame, bool forced) = 0;
  /** 30 ms fade of every voice (contract allNotesOff). */
  virtual void allNotesOff(std::int64_t frame) = 0;
  /** Hard stop, no fade (Panic, unit retired at once). */
  virtual void kill() = 0;
  virtual void sustain(bool down, std::int64_t frame) {
    (void)down;
    (void)frame;
  }
  /** Pitch bend in semitones (contract 2.6 `inst.setBend`), applied from `frame`. */
  virtual void setBend(double semis, std::int64_t frame) {
    (void)semis;
    (void)frame;
  }
  /** Mono legato (contract 2.5): retune the sounding voice from `from` to `to` over `glide` seconds. */
  virtual void legatoTo(int from, int to, std::int64_t frame, double glide) {
    (void)from;
    (void)to;
    (void)frame;
    (void)glide;
  }
  /** Instrument param by index (the instrument's own table; the Model maps `slots.<i>.params.<key>`). */
  virtual void setParam(std::uint32_t index, double value, double time, double glide) {
    (void)index;
    (void)value;
    (void)time;
    (void)glide;
  }
  /** Release one voice with a fade (pedalHold timer, steal, retire). */
  virtual void releaseVoice(VoiceId id, std::int64_t frame, double fadeSec) {
    (void)id;
    (void)frame;
    (void)fadeSec;
  }
  // INTERFACE-CHANGE(T14) O-W3-1 (DECISIONS "Orchestrator decisions for wave 3"; T12 review O3): fade every HELD
  // voice playing sounding note `note` over `seconds` from `frame` (the instrument's own fadeOut, as a steal: the
  // voice stops counting at once). The Model holds the pedal, so a pedaled note is still Held in the instrument:
  // audio.js re-strike of a pedaled note (30 ms), `slots.<i>.pedalHold` (25 % of the hold) and the mono crossfade
  // (30 ms) address exactly that voice. Op::FadeNote (aux = note, f.a = seconds). Default no-op.
  virtual void fadeNote(int note, std::int64_t frame, double seconds) {
    (void)note;
    (void)frame;
    (void)seconds;
  }
  /** Output channel count (1 or 2): decides the strip's pan law (contract 3.1). */
  virtual unsigned outputChannels() const = 0;
  // INTERFACE-CHANGE(T00c) D1: per-slot polyphony cap (DECISIONS D1: 32 | 64 | 128, default 64). The Model calls it
  // at attach and on change (Op::VoiceCap, audio thread, before any note of the attach). The instrument steals
  // (oldest released first, then oldest held; its own policy) once more than `cap` voices would sound. Default
  // no-op: an instrument that never allocates past its own fixed pool may ignore it.
  virtual void setVoiceCap(unsigned cap) { (void)cap; }

  // INTERFACE-CHANGE(D4): engine-wide voice limit (DECISIONS D4). The Graph enforces it after each note-on: while the
  // voices counted by every instrument (slots and retiring channels) exceed the limit, it asks each one for its
  // oldest candidate and steals the globally oldest with releaseVoice(id, frame, kStealFade) (the instrument's own
  // 20 ms steal fade). Released voices go first (by release time), then held ones (by start time). Defaults: an
  // instrument that does not report its voices is neither counted nor stolen from.
  /** Voices counted against the caps: held + released (fading steal victims do not count). Audio thread, O(1). */
  virtual unsigned playingVoices() const { return 0; }
  /** The instrument's oldest steal candidate for a note-on at `frame`: `released` = its earliest released voice
   *  (the instrument's own release policy, as its per-slot steal), else its oldest playing voice. `at` = release /
   *  start time in engine seconds (comparable across instruments). False = no candidate. */
  virtual bool oldestVoice(bool released, std::int64_t frame, double &at, VoiceId &id) {
    (void)released;
    (void)frame;
    (void)at;
    (void)id;
    return false;
  }
  /** The Graph's view of an instrument slot's unit (graph/unit.h Unit::asInstrument). */
  Instrument *asInstrument() final { return this; }

 protected:
  virtual void applyModule(const Command &c) { (void)c; }
};

}  // namespace rig
