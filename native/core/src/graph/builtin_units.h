// Builtin skeleton units (registered at kBuiltinPriority by graph/builtin_register.cpp; replaced by modules):
//   "strip"     fader -> SlotEq -> pan (no wheel/width/sends): keeps the 18 eq-* goldens exact until T02 lands
//   "inst.test" the T00 test voice (sine | saw, ADSR) for the unit tests
//   "master"    master volume only (no EQ, glue, catcher, clip) until T03 lands
// Orchestrator-owned. Modules must not depend on these classes.
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

class BuiltinStrip final : public Unit {
 public:
  BuiltinStrip(const SlotEqSpec &eq, double pan, double sampleRate);
  void process(const RenderContext &ctx, UnitIO &io) override;
  void apply(const Command &c) override;
  wa::Param *param(std::uint32_t index) override;
  void setSampleRate(double sr) override;
  std::uint32_t liveVoices() const override { return tail_ > 0 ? 1u : 0u; }

 private:
  SlotEqSpec eqSpec_;
  SlotEq eq_;
  double sr_;
  wa::Param fader_{0.0}, pan_{0.0};
  int tail_ = 0;  // quanta left to render with silent input (EQ ring-out)
  SlotEqPayload *pending_ = nullptr;
};

class TestInstrument final : public Instrument {
 public:
  static constexpr std::size_t kVoices = 16;
  TestInstrument(const SlotSpec &spec, double sampleRate);
  void process(const RenderContext &ctx, UnitIO &io) override;
  void setSampleRate(double sr) override { sr_ = sr; }
  std::uint32_t liveVoices() const override;

  void noteOn(int note, int vel, float velGain, std::int64_t frame) override;
  void noteOff(int note, std::int64_t frame, bool forced) override;
  void allNotesOff(std::int64_t frame) override;
  void kill() override;
  unsigned outputChannels() const override { return 1; }

 private:
  SlotSpec spec_;
  double sr_;
  std::array<TestVoice, kVoices> voices_;
  std::uint32_t nextVoice_ = 0;
};

class BuiltinMaster final : public Unit {
 public:
  explicit BuiltinMaster(double volume) : volume_(volume) {}
  void process(const RenderContext &ctx, UnitIO &io) override;
  wa::Param *param(std::uint32_t index) override;

 private:
  wa::Param volume_;
};

Unit *makeBuiltinStrip(const UnitEnv &env, const UnitSpec &spec);
Unit *makeTestInstrument(const UnitEnv &env, const UnitSpec &spec);
Unit *makeBuiltinMaster(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
