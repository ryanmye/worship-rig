// T05 internals of the chorus (kind "chorus", fx/chorus.h). Used by fx/chorus.cpp, fx/chorus_register.cpp and
// tests/test_chorus.cpp.
//
// Ports fx.js Chorus (fx.js:1337-1370) node for node:
//   io.in -> input GainNode (channelCount 1, explicit: speakers down-mix 0.5 (L + R)) -> for voice i in {0, 1}:
//     DelayNode (max 50 ms, delayTime 7 ms + LFO_i x depth_i, a-rate) -> merger input i (0 = L, 1 = R)
//   merger -> ret (returnGain, param 0) -> io.out
// LFO_i = OscillatorNode over PeriodicWave(real [0, sin ph_i], imag [0, cos ph_i], unnormalised) = sin(wt + ph_i),
// ph_0 = rngFor(seed, 'chorus').next() * 2 pi, ph_1 = ph_0 + pi / 2; rates r and 1.07 r (r clamped .15..1.5, tau
// 50 ms); depth gain 0.002 * depth s (initial 0.001, tau 50 ms).
#pragma once
#include <cstdint>
#include <memory>

#include "dsp/oscillator.h"
#include "dsp/periodic_wave.h"
#include "fx/chorus.h"
#include "fx/delay_node.h"
#include "graph/unit.h"
#include "time/param.h"

namespace rig {
struct ChorusPatch;
}

namespace rig::fx {

/** Chorus module opcodes (T05 range 0x0540..0x057F; ChorusOp::Reserved = 0x0540 stays unused). `when` in f.e. */
enum class ChorusUnitOp : std::uint16_t {
  SetRate = static_cast<std::uint16_t>(kOpBaseT05) + 0x41,  // a = rate (Hz, unclamped row value)
  SetDepth,                                                 // a = depth 0..1
};

class ChorusUnit final : public Unit {
 public:
  static constexpr double kMaxDelay = 0.05, kBaseDelay = 0.007;

  /** Chorus constructor (rngFor(seed, 'chorus'), PeriodicWaves, lfo.start(0)) + the _applyFx(init) moves at t 0. */
  ChorusUnit(double sampleRate, std::uint32_t seed, const ChorusPatch &p);
  ~ChorusUnit() override;

  void process(const RenderContext &ctx, UnitIO &io) override;
  void apply(const Command &c) override;
  wa::Param *param(std::uint32_t index) override { return index == kChorusReturnGain ? &ret_ : nullptr; }
  std::uint32_t liveVoices() const override { return quiet_ < 8 ? 1u : 0u; }

  void setRate(double hz, double when);
  void setDepth(double x, double when);
  double startPhase() const { return phase0_; }

 private:
  struct Voice {
    std::unique_ptr<wa::PeriodicWave> wave;
    std::unique_ptr<wa::Oscillator> lfo;
    wa::Param depth{0.001};
    wa::Param dTime{kBaseDelay, 0.0f, static_cast<float>(kMaxDelay)};
    DelayNodeKernel d;
  };
  double sr_;
  double phase0_ = 0;
  Voice v_[2];
  wa::Param ret_{1.0};
  double lastQuantumTime_ = 0;
  unsigned quiet_ = 8;
};

}  // namespace rig::fx
