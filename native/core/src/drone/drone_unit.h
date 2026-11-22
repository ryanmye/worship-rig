// DroneUnit: kind "drone" (drone/drone.h), the render half of app/js/engine/drone.js (T16). The control half (the
// state machine, timers, voicing, files, freeze) is drone/drone_core.h; it drives this unit with DroneOp commands
// that are, one for one, the AudioParam / instrument / media calls drone.js makes (contract 3.9):
//
//   inst slot i (drone-osc, armed) x instGain[i] ─┐
//                                                 ├→ synthBus (droneTrim) → HPF 80 → synthMode ┐
//   pad player j (decoded pad file) x padGain[j] ─→ filesMode ────────────────────────────────┴→ widthIn
//   widthIn → [L' = A·L + B·R, R' = A·R + B·L] ┐
//   frozen loop k (looping buffer) x loopGain[k] ┴→ [L', R', fzL, fzR] x level x wheel x bend
//     → io.out = [L' + fzL, R' + fzR];  io.sends[reverb] += [L', R'] x sendGate   (the loop carries its own reverb)
//
// Every gain is a Chromium GainNode (wa::Gain), the HPF a BiquadFilterNode (wa::BiquadFilter), the pads and loops
// AudioBufferSourceNodes (wa::BufferSource). An instrument slot that is not armed is not rendered (Chromium does not
// pull a node with no path to the destination: its sources' phases stand still, as drone.js idle instruments do).
// Audio thread: allocation-free; payloads come in as rig::Owned and go back through Unit::giveBack.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/buffer_source.h"
#include "dsp/gain.h"
#include "drone/drone.h"
#include "graph/unit.h"
#include "inst/synth.h"
#include "model/buffer_cache_api.h"
#include "time/param.h"

namespace rig::drone {

inline constexpr unsigned kMaxInst = 24;  // drone-osc instruments (layers, follow voices, idle A/B, fading ones)
inline constexpr unsigned kMaxPads = 6;   // drone.js POOL_MAX
inline constexpr unsigned kMaxLoops = 4;  // frozen loop + the ones fading out of a swap

/** Param indices (Unit::param, DroneOp::Param). 0..3 are drone.h DroneParam (frozen). */
enum : std::uint32_t {
  kParamWheel = 4,
  kParamBend = 5,
  kParamSynthBus = 6,
  kParamSynthMode = 7,
  kParamFilesMode = 8,
  kParamInstGain0 = 32,  // + slot
  kParamPadGain0 = 64,   // + pad
  kParamLoopGain0 = 80,  // + loop
  kParamEnd = 84
};

/** DroneOp::Param aux: which AudioParam method. */
enum class ParamCall : std::uint32_t { Set, Linear, Exp, Target, CancelHold, CancelScheduled };

/** A drone-osc instrument travelling to the unit (control thread builds it; deleted there when it comes back). */
struct InstBox final : Owned {
  std::unique_ptr<inst::SynthInstrument> inst;
};

/** Decoded, engine-rate audio (pad file or frozen loop). Immutable once shared. */
struct AudioBuf {
  std::vector<float> data[2];
  SampleBuffer sb;
  /** Wrap `data` (1 or 2 channels, equal length) into `sb`. */
  void seal(double sampleRate);
  double seconds() const { return sb.sampleRate > 0 ? static_cast<double>(sb.frames) / sb.sampleRate : 0; }
};

/** A reference to an AudioBuf held by a player; the last reference is dropped on the control thread. */
struct BufRef final : Owned {
  std::shared_ptr<const AudioBuf> buf;
};

/** The drone.js constructor's state: GainNode values and the automation it schedules at time 0. */
struct DroneInit {
  double level = 0.5011872336272722;  // new GainNode(ctx, {gain: Math.pow(10, -6 / 20)})
  double width = 0.7;                 // _applyWidth(0): rampTo(wLL/wRR, (1+w)/2, 0, .02), rampTo(wLR/wRL, (1-w)/2, ..)
  double trimGain = 1;                // setTrim(db): setNow(synthBus.gain, 10^(db/20), 0)
};

class DroneUnit final : public Unit {
 public:
  /** Control thread; the time-0 automation of `init` is scheduled here (before the unit is attached). */
  DroneUnit(double sampleRate, const DroneInit &init);
  ~DroneUnit() override;

  void process(const RenderContext &ctx, UnitIO &io) override;
  void apply(const Command &c) override;
  wa::Param *param(std::uint32_t index) override;
  void setSampleRate(double sr) override;
  std::uint32_t liveVoices() const override;

  // ---- introspection (tests, stats) ----
  bool hasInst(unsigned slot) const { return slot < kMaxInst && inst_[slot].box; }
  bool armed(unsigned slot) const { return slot < kMaxInst && inst_[slot].armed; }
  const inst::SynthInstrument *instrument(unsigned slot) const {
    return hasInst(slot) ? inst_[slot].box->inst.get() : nullptr;
  }
  bool padPlaying(unsigned pad) const { return pad < kMaxPads && pads_[pad].ref; }
  bool loopPlaying(unsigned loop) const { return loop < kMaxLoops && loops_[loop].ref; }

 private:
  struct InstSlot {
    InstBox *box = nullptr;
    wa::Gain gain{0.0};
    bool armed = false;
  };
  struct Player {
    BufRef *ref = nullptr;
    wa::BufferSource src;
    wa::Gain gain{0.0};
  };
  /** RenderContext handed to the instruments: Garbage goes on, their VoiceEnded (slot = Drone) stays here. */
  class Events final : public EventSink {
   public:
    EventSink *next = nullptr;
    bool push(const AudioEvent &e) override;
  };

  std::int64_t frameOf(double t) const;
  void later(Owned *p);  // hand back at the next process()
  void stopPlayer(Player &p);
  void renderPlayer(Player &p, std::int64_t f0, double sr, float *l, float *r, bool &any);

  double sr_;
  std::int64_t nextFrame_ = 0;  // first frame of the next quantum (context time of the param insertions)
  InstSlot inst_[kMaxInst];
  Player pads_[kMaxPads], loops_[kMaxLoops];
  wa::Gain synthBus_, synthMode_{1.0}, filesMode_{0.0}, widthA_, widthB_, level_, wheel_{1.0}, bend_{1.0},
      sendGate_{0.4};
  wa::BiquadFilter hpf_;
  Events events_;
  static constexpr unsigned kMaxGarbage = 64;
  Owned *garbage_[kMaxGarbage] = {};
  unsigned garbageN_ = 0;
  alignas(16) float a_[2][kQ], b_[2][kQ], c_[4][kQ], g_[kQ];
};

/** Registry factory (kind "drone"): built from the engine's drone service state (drone/drone_service.h). */
Unit *makeDroneUnit(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig::drone
