// Instrument: the unit in an instrument slot (UnitSlot::Inst0..3, RetireInst0..15). FROZEN by T00b.
// Implemented by T11 (synth.js port, kind "inst.synth"), T12 ("inst.sampler"), T15 ("inst.synth-extra",
// "inst.organ"); the builtin test voice is "inst.test" (graph/builtin_units.cpp). The Model picks the kind as
// "inst." + patch slot `instrument.type`, so a new instrument type is a new registration, nothing else.
//
// The graph routes the core perform opcodes (runtime/command.h NoteOn, NoteOff, Sustain, Bend, LegatoTo, InstParam,
// ReleaseVoice, AllNotesOff, Panic) to Instrument::apply, which decodes them into the virtuals below
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
  /** Output channel count (1 or 2): decides the strip's pan law (contract 3.1). */
  virtual unsigned outputChannels() const = 0;

 protected:
  virtual void applyModule(const Command &c) { (void)c; }
};

}  // namespace rig
