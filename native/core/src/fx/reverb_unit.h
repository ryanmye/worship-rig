// T04 internals of the reverb (kind "reverb", fx/reverb.h): the immutable stereo kernel of one IR key, the attachable
// convolver "unit" (fx.js Reverb unit: two predelay lines + ConvolverNode + out gain) and the render object.
// Used by fx/reverb.cpp, fx/reverb_service.cpp and the tests; nothing else needs it.
//
// Render chain per quantum (contract 3.4; fx.js:579-1122):
//   io.in -> HPF 180 Hz -> LPF 9 kHz (Butterworth, Q = 20 log10(SQRT1_2) dB) -> for each occupied slot:
//     [connected ? input : silence] -> predelay line A x pg[0] + line B x pg[1] -> convolver -> x out gain
//   sum of the slots -> x returnGain (param 0) -> x wheel (param 1) -> io.out
// Up to kSlots units render at once (the active one and up to three still fading out after quick size changes;
// JS keeps every fading unit connected too). A slot whose input has been silent for longer than its predelay buffer
// plus its convolver tail is skipped (its state is all zeros then; output unchanged), which is the native form of
// Chromium's tail-time node disabling and of the JS FX idle sleep.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/convolver.h"
#include "fx/reverb.h"
#include "graph/unit.h"
#include "time/param.h"

namespace rig::fx {

inline constexpr unsigned kReverbSlots = 4;
inline constexpr double kReverbFade = 0.8;     // Reverb.fade (unit crossfade, s)
inline constexpr double kPredelayFade = 0.5;   // Reverb.pdFade (s)
inline constexpr double kPredelayMax = 0.5;    // DelayNode maxDelayTime of the predelay lines (s)
inline constexpr double kIdleAfterFade = 0.05;  // the outgoing unit is disconnected fade + 0.05 s after the swap

/** The convolver kernels of one IR key (both channels); immutable, shared (control-side refcount). */
struct ReverbKernel {
  std::string key;
  double sampleRate = 0;
  std::size_t length = 0;
  std::unique_ptr<wa::ConvolverKernel> ch[2];
  std::size_t bytes() const { return ch[0] ? ch[0]->bytes() + ch[1]->bytes() : 0; }

  /** IR (fx/ir_gen) + kernel spectra for (size, damp) at `sampleRate`. Control thread / IR worker. */
  static std::shared_ptr<const ReverbKernel> build(double sampleRate, std::uint32_t engineSeed, double size,
                                                   double damp);
  /** From given IR channels (tests, frozen drone). */
  static std::shared_ptr<const ReverbKernel> fromIr(std::string key, double sampleRate, const float *l,
                                                    const float *r, std::size_t length);
};

/** One DelayNode with Chromium's a-rate kernel (delay.cc + cpu/x86/delay_sse2.cc, emulated in scalar float), stereo
 *  (the two channel kernels share their write index). Buffer length 128 + ceil(0.5 s x rate) as Chromium. */
class PredelayLine {
 public:
  PredelayLine() = default;
  void allocate(double sampleRate);  // control side
  void clear();
  /** out[c][i] = in delayed by delayTimes[i] seconds (a-rate values, already clamped to 0..0.5). */
  void process(const float *const in[2], float *const out[2], const float *delayTimes);
  std::size_t length() const { return len_; }

 private:
  std::vector<float> buf_[2];
  std::size_t len_ = 0, w_ = 0;
  float sr_ = 0;
};

/** Payload of ReverbOp::AttachKernel: a running convolver unit (kernel + state + its two predelay lines) and where
 *  and how to start it. Allocated on the control side (convolver state is ~8 MB for the 8 s space), handed back as
 *  Garbage when replaced or released. */
struct ConvUnit final : Owned {
  std::shared_ptr<const ReverbKernel> kernel;
  std::unique_ptr<wa::Convolver> conv[2];
  PredelayLine line[2];
  // attach request
  unsigned slot = 0;
  double when = 0;       // fade start (engine s); the unit is connected (fed) from the command's quantum on
  double fade = 0;       // 0: out gain set to 1 at `when` (engine start / first build)
  double predelay = 0.02;
  int fadeOutSlot = -1;  // the unit that was active: equal-power fade 1 -> 0 at `when`, disconnected at idle

  ConvUnit(std::shared_ptr<const ReverbKernel> k, double sampleRate);
  std::size_t bytes() const;
};

/** AttachKernel (fx/reverb.h): p.ptr = ConvUnit (kSubOwnedPayload). SetPredelay: aux = slot, a = seconds,
 *  b = when, c = 0 crossfade to the idle line (Reverb._pdTo) / 1 set both lines now (Reverb._setUnitPd on a
 *  silent unit). */

class ReverbUnit final : public Unit {
 public:
  ReverbUnit(double sampleRate, double returnGain);
  ~ReverbUnit() override;

  void process(const RenderContext &ctx, UnitIO &io) override;
  void apply(const Command &c) override;
  wa::Param *param(std::uint32_t index) override;
  void setSampleRate(double sr) override;
  std::uint32_t liveVoices() const override;

  /** Control side, before the unit is attached: the first unit, active at once (Reverb.init). */
  void installInitial(ConvUnit *u);
  /** Test/bench introspection. */
  const ConvUnit *slotUnit(unsigned s) const { return slots_[s].unit; }
  unsigned activeSlot() const { return active_; }
  bool slotRendering(unsigned s) const { return slots_[s].unit && !slots_[s].skipping; }

 private:
  struct Slot {
    ConvUnit *unit = nullptr;
    wa::Param delayTime[2]{wa::Param(0.02, 0.0f, 0.5f), wa::Param(0.02, 0.0f, 0.5f)};
    wa::Param pg[2]{wa::Param(1.0), wa::Param(0.0)};
    wa::Param out{wa::Param(0.0)};
    unsigned cur = 0;  // the predelay line carrying the signal
    bool connected = false, skipping = true;
    std::int64_t disconnectFrame = -1;  // frame from which the input is cut (fading unit gone idle)
    std::size_t silentFrames = 0;
  };
  void start(unsigned s, double when, double fade, double predelay, int fadeOutSlot);
  void setUnitPd(Slot &sl, double p);
  void pdTo(Slot &sl, double p, double when);
  void giveBackLater(Owned *p);
  void renderSlot(const RenderContext &ctx, Slot &sl, const float *const feed[2], float *const acc[2]);

  double sr_;
  wa::Biquad hpf_[2], lpf_[2];
  wa::Param ret_, wheel_{wa::Param(1.0)};
  Slot slots_[kReverbSlots];
  unsigned active_ = 0;
  double nextTime_ = 0;  // engine time of the next quantum to render (commands apply before it)
  alignas(16) float zeros_[kQ] = {};
  Owned *garbage_[16] = {};
  unsigned garbageN_ = 0;
};

/** The registry factory (fx/reverb.h makeReverb) builds through the engine's ReverbPool when one exists. */
Unit *makeStandaloneReverb(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig::fx
