// Builtin skeleton unit (registered at kBuiltinPriority by graph/builtin_register.cpp):
//   "inst.test" the T00 test voice (sine | saw, ADSR) for the unit tests.
// T00c removed the builtin "strip" (fader -> SlotEq -> pan) and "master" (volume only): T02's SlotChannel and T03's
// MasterChain replace them. Orchestrator-owned. Modules must not depend on these classes (SlotEqPayload excepted).
#pragma once
#include <array>

#include "dsp/test_voice.h"
#include "graph/unit.h"
#include "inst/instrument.h"
#include "mix/slot_eq.h"
#include "mix/slot_spec.h"
#include "time/param.h"

namespace rig {

struct UnitEnv;
struct UnitSpec;

/** Payload of StripOp::SetEq (mix/slot_channel.h) for the builtin strip and T02's SlotChannel. */
struct SlotEqPayload : Owned {
  SlotEqSpec spec;
};

/** D1 (T00c): a fixed pool of 128 voices (no allocation on the audio thread) with the per-slot cap set by
 *  Op::VoiceCap (default 64). At the cap, a note-on steals the oldest released voice, else the oldest held one
 *  (the 1.x policy, DECISIONS D1); a free voice is always taken first. The reference allocator for T11/T12. */
class TestInstrument final : public Instrument {
 public:
  static constexpr std::size_t kVoices = 128;
  static constexpr unsigned kDefaultCap = 64;
  TestInstrument(const SlotSpec &spec, double sampleRate);
  void process(const RenderContext &ctx, UnitIO &io) override;
  void setSampleRate(double sr) override { sr_ = sr; }
  std::uint32_t liveVoices() const override;

  void noteOn(int note, int vel, float velGain, std::int64_t frame) override;
  void noteOff(int note, std::int64_t frame, bool forced) override;
  void allNotesOff(std::int64_t frame) override;
  void kill() override;
  void setVoiceCap(unsigned cap) override { cap_ = cap < 1 ? 1u : cap > kVoices ? unsigned{kVoices} : cap; }
  unsigned voiceCap() const { return cap_; }
  std::uint32_t stolen() const { return stolen_; }
  unsigned outputChannels() const override { return 1; }

 private:
  SlotSpec spec_;
  double sr_;
  std::array<TestVoice, kVoices> voices_;
  std::array<std::uint64_t, kVoices> order_{};  // note-on order (oldest = smallest)
  std::uint64_t nextOrder_ = 1;
  unsigned cap_ = kDefaultCap;
  std::uint32_t stolen_ = 0;
};

Unit *makeTestInstrument(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
