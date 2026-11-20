// MasterChain (kind "master", UnitSlot::MasterChain): port of the master section of app/js/engine/fx.js FxGraph
// (contract 3.8): eqIn -> master EQ -> glueDry | glue compressor -> glueWet -> master(volume) -> masterWheel ->
// fadeGain -> stereo(1 - m) + mono(sqrt2 * m * .5(L+R)) -> preComp [+ test inject] -> catcher -> clipPre(.5 / makeup)
// -> clip curve -> out. Each Web Audio node is one step here, in the same float operations and the same order, so a
// render matches Chromium sample by sample (Chromium sums a node's inputs in hash order: 3-input sums can differ in
// the last bit).
//
// Glue (fx.js setGlue): the compressor is processed only while "connected" (from the quantum a SetGlue engages it
// until the quantum of the detach timer at disengage + 40 ms, quantised like AudioTimer.at offline:
// k = ceil(t sr / 128 - 1e-6)); while disconnected its state is frozen, as an unpulled Chromium node's is. The
// dry -> wet crossfade starts 0.3 s after the engage (GLUE_ENGAGE_DELAY) and lasts 30 ms; the wet gain is the makeup
// 10^(-glueRefDb(a)/20) measured on the native kernel (master_chain_tables.h). The catcher's automatic makeup is
// cancelled by clipPre = .5 / compMakeup().
//
// Unit-local test points: tap kTapEqOut (master EQ output), tap kTapMaster (after glue + master volume), inject
// kInjectPreComp (summed into preComp). Real-time safe: no allocation after construction.
#include "mix/master_chain.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "api/registry.h"
#include "dsp/compressor.h"
#include "dsp/waveshaper.h"
#include "graph/test_points.h"
#include "mix/master_chain_tables.h"
#include "mix/master_eq.h"
#include "model/patch.h"
#include "time/automation.h"
#include "time/param.h"

namespace rig {
namespace {

using wa::DynamicsCompressor;

wa::WaveShaper::Oversample clipOversample(const rig_config *cfg) {
  if (cfg && (cfg->flags & RIG_FLAG_CLIP_OVERSAMPLE_4X)) return wa::WaveShaper::Oversample::X4;
  if (cfg && (cfg->flags & RIG_FLAG_CLIP_OVERSAMPLE_2X)) return wa::WaveShaper::Oversample::X2;
  return wa::WaveShaper::Oversample::None;
}

void mulInPlace(Bus &b, const float *g) {
  for (unsigned c = 0; c < b.channels; ++c)
    for (std::size_t i = 0; i < kQ; ++i) b.ch[c][i] *= g[i];
}

class MasterChain final : public Unit {
 public:
  MasterChain(const UnitEnv &env, const UnitSpec &spec)
      : sr_(env.sampleRate),
        eq_(env.sampleRate, spec.patch ? spec.patch->master.eqLow : 0.0, spec.patch ? spec.patch->master.eqMid : 0.0,
            spec.patch ? spec.patch->master.eqHigh : 0.0),
        volume_(spec.patch ? spec.patch->master.volume : 0.5011872336272722),
        glueThreshold_(master::glueSettings(1).threshold, -100.0f, 0.0f),
        glueRatio_(master::glueSettings(1).ratio, 1.0f, 20.0f),
        glue_(env.sampleRate),
        catcher_(env.sampleRate),
        clipPre_(static_cast<float>(0.5 / master::compMakeup())),
        clip_(master::clipCurve(), master::kClipCurveSize, clipOversample(env.config), 2),
        glueAvailable_(!(env.config && (env.config->flags & RIG_FLAG_NO_GLUE))),
        initAmount_(spec.patch ? spec.patch->master.compAmount : 0.0),
        initMono_(spec.song && spec.song->mono) {
    for (std::size_t k = 0; k <= master::kGlueGrid; ++k) glueRef_[k] = master::glueRefTable()[k];
    catcher_.setParams(master::catcherSettings());
  }

  void process(const RenderContext &ctx, UnitIO &io) override {
    sr_ = ctx.sampleRate;
    ensureInit(static_cast<double>(ctx.frame0) / ctx.sampleRate);
    const std::int64_t f0 = ctx.frame0;
    const double sr = ctx.sampleRate;

    // master EQ (k-rate biquads), in place on a copy of eqIn
    Bus &x = x_;
    std::memcpy(x.ch, io.in->ch, sizeof x.ch);
    x.channels = io.in->channels;
    eq_.process(x, f0, sr);
    if (io.tap && io.tapPoint == kTapEqOut) *io.tap = x;

    // glueDry (a-rate gain) -> master input
    float g[kQ];
    Bus &m = m_;
    m = x;
    glueDry_.processARate(f0, sr, g, kQ);
    mulInPlace(m, g);

    // glue compressor -> glueWet (a-rate) -> master input, while connected
    glueWet_.processARate(f0, sr, g, kQ);
    const float thr = glueThreshold_.processKRate(f0, sr), ratio = glueRatio_.processKRate(f0, sr);
    if (glueConnected_ && detachFrame_ >= 0 && f0 >= detachFrame_) {
      glueConnected_ = false;
      detachFrame_ = -1;
    }
    if (glueConnected_) {
      DynamicsCompressor::Params p = master::glueSettings(1);
      p.threshold = thr;
      p.ratio = ratio;
      glue_.setParams(p);
      Bus &w = w_;
      const float *src[2] = {x.ch[0], x.ch[1]};
      float *dst[2] = {w.ch[0], w.ch[1]};
      glue_.process(src, x.channels, dst, kQ);
      w.channels = 2;
      mulInPlace(w, g);
      m.add(w);
    }

    // master volume, [tap fx.master], masterWheel, fadeGain (three GainNodes in series)
    volume_.processARate(f0, sr, g, kQ);
    mulInPlace(m, g);
    if (io.tap && io.tapPoint == kTapMaster) *io.tap = m;
    wheel_.processARate(f0, sr, g, kQ);
    mulInPlace(m, g);
    fade_.processARate(f0, sr, g, kQ);
    mulInPlace(m, g);

    // stereo (1 - m) + mono (sqrt2 m, explicit 1-channel speakers down-mix .5 L + .5 R) -> preComp
    float mm[kQ];
    monoMix_.processARate(f0, sr, mm, kQ);
    bool anyMono = false;
    for (std::size_t i = 0; i < kQ; ++i) anyMono = anyMono || mm[i] != 0.0f;
    Bus &pre = m;  // stereo GainNode at exactly 1 is the identity
    if (anyMono) {
      float mono[kQ];
      for (std::size_t i = 0; i < kQ; ++i) {
        const float d = m.channels == 2 ? 0.5f * m.ch[0][i] + 0.5f * m.ch[1][i] : m.ch[0][i];
        mono[i] = d * (kSqrt2f * mm[i]);
      }
      for (unsigned c = 0; c < m.channels; ++c)
        for (std::size_t i = 0; i < kQ; ++i) pre.ch[c][i] = m.ch[c][i] * (1.0f - mm[i]) + mono[i];
    }
    if (io.inject && io.injectPoint == kInjectPreComp) pre.add(*io.inject);

    // catcher -> clipPre -> clip curve -> out (always 2 channels: the compressor's output)
    Bus &out = *io.out;
    const float *src[2] = {pre.ch[0], pre.ch[1]};
    float *dst[2] = {out.ch[0], out.ch[1]};
    catcher_.process(src, pre.channels, dst, kQ);
    out.channels = 2;
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < kQ; ++i) out.ch[c][i] *= clipPre_;
    clip_.process(dst, 2, kQ);
  }

  void apply(const Command &c) override {
    if (c.op == opOf(MasterOp::SetGlue)) {
      ensureInit(c.f.c);
      setGlue(c.f.a, c.f.b);
    } else if (c.op == opOf(MasterOp::SetMono)) {
      ensureInit(c.f.c);
      setMono(c.f.a != 0.0, c.f.b);
    }
  }

  wa::Param *param(std::uint32_t index) override {
    switch (index) {
      case kMasterVolume:
        return &volume_;
      case kMasterWheel:
        return &wheel_;
      case kMasterFadeGain:
        return &fade_;
      case kMasterEqLow:
      case kMasterEqMid:
      case kMasterEqHigh:
        return eq_.gain(static_cast<int>(index - kMasterEqLow));
      case kMasterMonoMix:
        return &monoMix_;
      case kMasterGlueDry:
        return &glueDry_;
      case kMasterGlueWet:
        return &glueWet_;
      default:
        return nullptr;
    }
  }

  void setSampleRate(double sr) override {
    sr_ = sr;
    eq_.setSampleRate(sr);
    glue_.setSampleRate(sr);
    catcher_.setSampleRate(sr);
  }

 private:
  static constexpr float kSqrt2f = static_cast<float>(master::kSqrt2);

  /** The construction-time setGlue / setMono of fx.js (_build: _applyFx(init), setMono(true, 0)), at the first
   *  quantum or op, whichever comes first (the factory does not know the attach time). */
  void ensureInit(double t) {
    if (inited_) return;
    inited_ = true;
    if (initAmount_ > 0) setGlue(initAmount_, t);
    if (initMono_) setMono(true, t);
  }

  double glueDryAt(double t) const {
    if (t <= xf_.t0) return xf_.from;
    if (!(xf_.dur > 0) || t >= xf_.t0 + xf_.dur) return xf_.to;
    return xf_.from + ((xf_.to - xf_.from) * (t - xf_.t0)) / xf_.dur;
  }

  /** fx.js FxGraph.setGlue(a, when). */
  void setGlue(double a, double when) {
    if (!glueAvailable_) return;
    const double x = std::min(1.0, std::max(0.0, std::isfinite(a) ? a : 0.0));
    if (x > 0) {
      const DynamicsCompressor::Params st = master::glueSettings(x);
      const double mk = rig::js::pow(10.0, -master::glueRefDb(glueRef_, x) / 20.0);
      if (!glueEngaged_) {
        wa::setNow(glueThreshold_, st.threshold, when);
        wa::setNow(glueRatio_, st.ratio, when);
        glueEngaged_ = true;
        detachFrame_ = -1;  // ++_glueSeq: cancels a pending disconnect
        glueConnected_ = true;
        const double w = when + master::kGlueEngageDelay;
        const double from = glueDryAt(w);
        wa::linFrom(glueDry_, from, 0.0, w, master::kGlueXfade);
        wa::linFrom(glueWet_, (1 - from) * mk, mk, w, master::kGlueXfade);
        xf_ = {w, master::kGlueXfade, from, 0.0};
        glueMk_ = mk;
      } else {
        wa::rampTo(glueThreshold_, st.threshold, when, wa::kTau);
        wa::rampTo(glueRatio_, st.ratio, when, wa::kTau);
        const bool busy = when < xf_.t0 + xf_.dur;
        if (busy && when < xf_.t0)
          wa::linFrom(glueWet_, (1 - xf_.from) * mk, mk, xf_.t0, xf_.dur);
        else if (busy)
          wa::linFrom(glueWet_, glueMk_ * (1 - glueDryAt(when)), mk, when,
                      std::max(0.005, xf_.t0 + xf_.dur - when));
        else
          wa::rampTo(glueWet_, mk, when, wa::kTau);
        glueMk_ = mk;
      }
      return;
    }
    if (!glueEngaged_) return;
    glueEngaged_ = false;
    const double from = glueDryAt(when);
    wa::linFrom(glueDry_, from, 1.0, when, master::kGlueXfade);  // ends exactly at 1: bit-exact dry afterwards
    wa::linFrom(glueWet_, (1 - from) * glueMk_, 0.0, when, master::kGlueXfade);
    xf_ = {when, master::kGlueXfade, from, 1.0};
    // env.timer.at(when + 0.04): disconnect from the quantum the offline timer fires in
    const double t = std::max(0.0, when + master::kGlueDetachAfter);
    detachFrame_ = static_cast<std::int64_t>(std::ceil(t * sr_ / static_cast<double>(kQ) - 1e-6)) *
                   static_cast<std::int64_t>(kQ);
  }

  /** fx.js FxGraph.setMono(on, when): 50 ms linear crossfade from the previous target. */
  void setMono(bool on, double when) {
    const double was = monoV_;
    monoV_ = on ? 1.0 : 0.0;
    wa::linFrom(monoMix_, was, monoV_, when, master::kMonoXfade);
  }

  struct Xfade {
    double t0 = 0, dur = 0, from = 1, to = 1;
  };

  double sr_;
  MasterEq eq_;
  wa::Param volume_;
  wa::Param wheel_{1.0}, fade_{1.0}, monoMix_{0.0}, glueDry_{1.0}, glueWet_{0.0};
  wa::Param glueThreshold_, glueRatio_;
  DynamicsCompressor glue_, catcher_;
  float clipPre_;
  wa::WaveShaper clip_;
  bool glueAvailable_;
  double initAmount_;
  bool initMono_;
  bool inited_ = false;
  bool glueEngaged_ = false, glueConnected_ = false;
  double glueMk_ = 1.0;
  Xfade xf_;
  std::int64_t detachFrame_ = -1;
  double monoV_ = 0.0;
  std::array<double, master::kGlueGrid + 1> glueRef_{};
  Bus x_, m_, w_;
};

}  // namespace

Unit *makeMasterChain(const UnitEnv &env, const UnitSpec &spec) {
  return new MasterChain(env, spec);
}

}  // namespace rig
