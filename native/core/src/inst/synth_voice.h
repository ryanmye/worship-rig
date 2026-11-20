// voice.js Voice + makeEnv + TrackedParam + FmDepth for the synth.js port (T11). A SynthVoice owns its nodes (the
// oscillators and per-voice gains / filters of one note); the instrument-level nodes it is linked to (bend source,
// filter offset + LFO, chorus LFO, bloom / H2 constants, unison drift) arrive as signals in VoiceIn each quantum.
#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

#include "dsp/buffer_source.h"
#include "dsp/gain.h"
#include "dsp/oscillator.h"
#include "inst/synth_dsp.h"
#include "time/param.h"

namespace rig::inst {

inline constexpr double kInf = std::numeric_limits<double>::infinity();

/** Signals of the shared (instrument-level) nodes for one quantum. Null = not used by the patch. */
struct VoiceIn {
  std::int64_t frame0 = 0;
  double sr = 48000;
  std::size_t n = kQuantum;
  const float *bend = nullptr;  // bendCS offset (cents) into every inst.osc detune
  float filterDet = 0;          // linkFilter: filterCS + filter LFO gain, first frame (k-rate detune)
  const float *chorusPos = nullptr, *chorusNeg = nullptr;  // glass-pad chorus LFO gains
  const float *bloom = nullptr;                            // glass-pad bloomCS
  const float *h2 = nullptr;                               // sub-bass h2CS
  const float *uniPos = nullptr, *uniNeg = nullptr;        // drone-osc unison drift
};

/** makeEnv inputs (adsr) */
struct EnvSpec {
  double a = 0.002, d = 0, s = 1, r = 0.2, dTau = 0;
};

/** voice.js TrackedParam: an oscillator frequency only moved by exponential glides. */
struct TrackedParam {
  wa::Param *param = nullptr;
  double v0 = 0, v1 = 0, t0 = 0, t1 = 0, mult = 1;
  void init(wa::Param *p, double value, double m) {
    param = p;
    v0 = v1 = value;
    t0 = t1 = 0;
    mult = m;
  }
  double valueAt(double t) const;
  void glide(double value, double t, double dur);
};

/** voice.js FmDepth: modulator deviation index(t) * fm with a Nyquist cap (bell, soft-keys). */
struct FmDepth {
  wa::Param *param = nullptr;
  double i0 = 0, floor = 0, tau = kInf, fm = 0, cap = kInf, t0 = 0;
  bool hasG = false;
  double gt = 0, gt1 = 0, gfrom = 0, gto = 0;
  void init(wa::Param *p, double i0_, double floor_, double tau_, double fm_, double cap_, double t0_);
  double index(double t) const;
  double valueAt(double t) const;
  void schedule(double t, double from, double dur);
  void retune(double fm_, double cap_, double t, double dur);
};

/** One source of a voice and its earliest stop (voice.js `_stopSource`: the earliest stop() wins). */
struct VoiceSrc {
  wa::Oscillator *osc = nullptr;
  wa::BufferSource *buf = nullptr;
  double stopAt = kInf;
  WaveKind kind = WaveKind::None;  // the oscillator's table (re-pointed by SynthInstrument::setWaves)
  std::uint8_t rot = 0;
};

class SynthVoice {
 public:
  static constexpr unsigned kMaxSrc = 8, kMaxPitched = 6;
  static constexpr int kTailQuanta = 8;  // rendered after the last source finished (filter tails), then torn down

  SynthVoice(int note, double t, double outGain) : outG(outGain), note_(note), startedAt_(t) {}
  virtual ~SynthVoice() = default;
  SynthVoice(const SynthVoice &) = delete;
  SynthVoice &operator=(const SynthVoice &) = delete;

  /** Render one quantum and ADD it into the instrument bus (r is null for a mono patch). */
  virtual void render(const VoiceIn &in, float *l, float *r) = 0;

  // ---- voice.js Voice ----
  void addSource(wa::Oscillator *o, double when, WaveKind kind, unsigned rot);
  void addSource(wa::BufferSource *b, double when, double offset);
  /** Re-point every oscillator to the same table of `bank` (a new sample rate). */
  void setWaves(const WaveBank &bank);
  /** _stopSource for one registered source (index into srcs). */
  void stopSource(unsigned i, double t);
  /** _scheduleStop */
  void scheduleStop(double t);
  /** Every source has finished (onended of the last one). */
  bool sourcesFinished() const;
  /** makeEnv on envG.gain at t; returns nothing (attackEnd kept). */
  void makeEnv(const EnvSpec &e, double t);
  /** env.release(rt, r): rampTo 0 with tau r/6.9; returns the kill time rt + 1.3 r. */
  double envRelease(double rt, double r);
  /** voice.fadeOut(t, fade): out gain to 0 (tau fade/6.9), sources stop at t + 1.3 fade. */
  void fadeOut(double t, double fadeSec);

  /** Count down the teardown after the sources finished: true = destroy now. */
  bool tick() {
    if (!sourcesFinished()) return false;
    if (tail_ < 0) tail_ = kTailQuanta;
    return tail_-- == 0;
  }

  int note() const { return note_; }
  void setNote(int n) { note_ = n; }
  double startedAt() const { return startedAt_; }
  double freq = 0;  // v.data.f

  wa::Gain envG{0.0};
  wa::Gain outG;
  TrackedParam pitched[kMaxPitched];
  unsigned nPitched = 0;
  void addPitched(wa::Param &p, double value, double mult) { pitched[nPitched++].init(&p, value, mult); }

 protected:
  /** The voice tail shared by every patch: envG -> v.out -> += bus. */
  void envOut(const VoiceIn &in, float *l, float *r, unsigned nch);

  int note_;
  double startedAt_;
  double stopAt_ = kInf;
  VoiceSrc srcs_[kMaxSrc];
  unsigned nSrc_ = 0;
  int tail_ = -1;
  alignas(16) float sumL_[kQuantum], sumR_[kQuantum];  // the voice's mixing bus ("sum") + chain buffer
};

}  // namespace rig::inst
