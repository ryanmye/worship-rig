// T05 internals of the lofi (kind "lofi", fx/lofi.h). Used by fx/lofi.cpp, fx/lofi_register.cpp and
// tests/test_lofi.cpp.
//
// Ports fx.js Lofi (fx.js:1372-1563) node for node:
//   io.in -> dry (param 0) ---------------------------------------------------------------------------> io.out
//   io.in -> [connected while engaged] wetIn x.25 -> drive x1 -> sat WaveShaper (tanh, 4x) -> quant WaveShaper
//            (none; no curve at 16 bits) -> tape DelayNode (max 1 s; 5 ms + wow LFO .35 Hz x wowDepth + flutter LFO
//            5 Hz x flutDepth, a-rate) -> HPF -> LPF -> makeup x4 -> wet (param 1) ----------------------> io.out
//   crackle loop (6 s stereo AudioBuffer, rngFor(seed, 'crackle')) -> BPF 2500 Hz Q .8 -> crackle gain -> wet
// While the wet chain is disconnected (amount 0, 40 ms after a disengage) nothing of it renders, exactly as an
// unpulled Web Audio subgraph: its LFO phases, filter and delay states stay frozen; dry = 1 exactly.
//
// Control side: Lofi.apply's curve choice and the patch go to the audio thread as one LofiState (LofiOp::Apply,
// Owned payload; the curves are shared, immutable, cached per key like fx.js CURVES).
#pragma once
#include <cstdint>
#include <memory>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/buffer_source.h"
#include "dsp/oscillator.h"
#include "dsp/periodic_wave.h"
#include "dsp/waveshaper.h"
#include "fx/delay_node.h"
#include "fx/lofi.h"
#include "graph/unit.h"
#include "model/buffer_cache_api.h"
#include "model/patch.h"
#include "time/param.h"

namespace rig {
class Model;
}

namespace rig::fx {

/** Extra param indices beyond LofiParam (for T14's tape bend: _tape automates tape.delayTime and lpf.Q). */
inline constexpr std::uint32_t kLofiTapeTime = 5, kLofiLpfQ = 6;

inline constexpr double kLofiPre = 0.25;  // LOFI_PRE

/** One lofi curve (fx.js tanhCurve / quantCurve), immutable. */
struct LofiCurve {
  std::vector<float> v;
};
/** Lofi._keys: drive key (dB, .25 steps) and bits (10..16). */
struct LofiKeys {
  double dk;
  int bits;
};
LofiKeys lofiKeys(const LofiPatch &p);
/** Lofi._curve: cached (process-wide, control thread; a few dozen keys at most). */
std::shared_ptr<const LofiCurve> lofiTanhCurve(double driveDb);
std::shared_ptr<const LofiCurve> lofiQuantCurve(int bits);

/** Payload of LofiOp::Apply: the resolved lofi state Lofi.apply(when) acts on. */
struct LofiState final : Owned {
  LofiPatch p;
  std::shared_ptr<const LofiCurve> sat, quant;  // quant null = no quantiser (16 bits)
  bool held = false;        // Lofi.holds.size > 0 (T14 tape bend keeps the wet chain engaged at amount 0)
  bool tapeActive = false;  // Lofi.tapeActive (T14): wow/flutter/LPF moves are skipped while the tape bend owns them
  double when = 0;
  static LofiState *make(const LofiPatch &p, bool held = false, bool tapeActive = false);
};

class LofiUnit final : public Unit {
 public:
  /** Lofi constructor (crackle buffer from rngFor(seed, 'crackle')) + Lofi.apply(0) of `initial` (owned). */
  LofiUnit(double sampleRate, std::uint32_t seed, LofiState *initial);
  ~LofiUnit() override;

  void process(const RenderContext &ctx, UnitIO &io) override;
  void apply(const Command &c) override;
  wa::Param *param(std::uint32_t index) override;
  std::uint32_t liveVoices() const override { return engaged_ || wetConnected_ ? 1u : 0u; }

  bool engaged() const { return engaged_; }
  bool wetConnected() const { return wetConnected_; }
  double engageDelay() const { return engageDelay_; }
  const SampleBuffer &crackleBuffer() const { return crackleBuf_; }

 private:
  void applyState(LofiState *s, double when);  // takes ownership; the previous state goes back as garbage
  void engage(bool on, double when);
  double dryAt(double t) const;
  void runTimer(std::int64_t frame0);
  void renderWet(std::int64_t frame0, const Bus &in, float *const wet[2]);

  double sr_;
  LofiState *state_ = nullptr;
  Owned *garbage_[8] = {};
  unsigned garbageN_ = 0;
  // nodes
  wa::Param dry_{1.0}, wet_{0.0};
  std::unique_ptr<wa::WaveShaper> sat_, quant_;
  DelayNodeKernel tape_;
  wa::Param tapeTime_{0.005, 0.0f, 1.0f};
  std::unique_ptr<wa::PeriodicWave> sine_;
  std::unique_ptr<wa::Oscillator> wowLfo_, flutLfo_;
  wa::Param wowDepth_{0.0}, flutDepth_{0.0};
  wa::Param lpfFreq_{18000.0}, lpfQ_{0.0}, hpfFreq_{20.0}, hpfQ_{0.0};
  wa::Biquad lpf_[2], hpf_[2], crackleBpf_[2];
  wa::Param crackleGain_{0.0};
  std::vector<float> crackleData_[2];
  SampleBuffer crackleBuf_;
  wa::BufferSource crackle_;
  bool crackleOn_ = false;
  // Lofi bookkeeping
  bool engaged_ = false, wetConnected_ = false;
  struct Xf {
    double t0 = 0, dur = 0, from = 1, to = 1;
  } xf_;
  std::uint32_t seq_ = 0;
  double engageDelay_;
  struct {
    bool armed = false;
    double t = 0;
    std::int64_t quantum = 0;
    std::uint32_t seq = 0;
  } disc_;
  double lastQuantumTime_ = 0;
};

/** Control side (fx/lofi_register.cpp, service "lofi"): Lofi.apply(when) for the current patch, and the T14 tape-bend
 *  hooks (Lofi.hold('tape', on, when), Lofi.tapeActive). No-ops while no T05 lofi is attached. */
void lofiApply(Model &m, double when);
void lofiHold(Model &m, bool on, double when);
void lofiSetTapeActive(Model &m, bool on);

}  // namespace rig::fx
