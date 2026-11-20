// T05: chorus render unit (kind "chorus"; fx/chorus.h, fx/chorus_unit.h). Ports fx.js Chorus (fx.js:1337-1370):
// the LFOs are wa::Oscillator over wa::PeriodicWave (T11a, Chromium ports), the voices fx::DelayNodeKernel (Chromium
// 157.0.8103.78 delay.cc / delay_sse2.cc, BSD-3, third_party/chromium/LICENSE) with the a-rate delayTime summed
// from its timeline and the depth GainNode output as AudioParamHandler::CalculateFinalValues does.
#include <algorithm>
#include <cmath>

#include "api/registry.h"
#include "fx/chorus_unit.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "num/prng.h"
#include "time/automation.h"

namespace rig::fx {
namespace {
constexpr std::size_t Q = kQ;
constexpr double kLfoTau = 0.05;
}  // namespace

ChorusUnit::ChorusUnit(double sampleRate, std::uint32_t seed, const ChorusPatch &p) : sr_(sampleRate) {
  Rng rng = rngFor(seed, "chorus");
  phase0_ = rng.next() * js::kPi * 2;
  for (unsigned i = 0; i < 2; ++i) {
    Voice &v = v_[i];
    const double ph = phase0_ + (i * js::kPi) / 2;
    // sin(wt + ph) = sin ph cos(wt) + cos ph sin(wt)
    const float real[2] = {0.0f, static_cast<float>(js::sin(ph))};
    const float imag[2] = {0.0f, static_cast<float>(js::cos(ph))};
    v.wave.reset(wa::PeriodicWave::create(real, imag, 2, true, sr_));
    v.lfo = std::make_unique<wa::Oscillator>(v.wave.get(), 0.4);
    v.d.allocate(kMaxDelay, sr_, 1);
    v.lfo->start(0);
  }
  // _applyFx(init) at t 0
  setRate(p.rate, 0);
  setDepth(p.depth, 0);
  wa::rampTo(ret_, p.returnGain, 0);
}

ChorusUnit::~ChorusUnit() = default;

void ChorusUnit::setRate(double hz, double when) {
  const double r = std::min(1.5, std::max(0.15, hz));
  for (unsigned i = 0; i < 2; ++i) wa::rampTo(v_[i].lfo->frequency(), r * (i ? 1.07 : 1), when, kLfoTau);
}

void ChorusUnit::setDepth(double x, double when) {
  for (Voice &v : v_) wa::rampTo(v.depth, 0.002 * std::min(1.0, std::max(0.0, x)), when, kLfoTau);
}

void ChorusUnit::process(const RenderContext &ctx, UnitIO &io) {
  alignas(16) float mono[Q], lfo[Q], g[Q], dt[Q];
  // input GainNode, channelCount 1 explicit: AudioBus speakers down-mix 0.5 * (L + R), then x gain 1
  const Bus *in = io.in;
  if (in && in->channels == 2) {
    for (std::size_t i = 0; i < Q; ++i) mono[i] = (in->ch[0][i] + in->ch[1][i]) * 0.5f;
  } else if (in) {
    for (std::size_t i = 0; i < Q; ++i) mono[i] = in->ch[0][i];
  } else {
    for (std::size_t i = 0; i < Q; ++i) mono[i] = 0.0f;
  }
  Bus &out = *io.out;
  out.channels = 2;
  for (unsigned k = 0; k < 2; ++k) {
    Voice &v = v_[k];
    v.lfo->process(ctx.frame0, sr_, lfo, Q);
    v.depth.processARate(ctx.frame0, sr_, g, Q);
    for (std::size_t i = 0; i < Q; ++i) lfo[i] *= g[i];  // depth GainNode output
    v.dTime.processARate(ctx.frame0, sr_, dt, Q);
    const float *conn[1] = {lfo};
    sumAndClip(dt, conn, 1, static_cast<float>(kBaseDelay), 0.0f, static_cast<float>(kMaxDelay), Q);
    const float *src[1] = {mono};
    float *dst[1] = {out.ch[k]};
    v.d.process(src, dst, 1, dt);
  }
  alignas(16) float r[Q];
  ret_.processARate(ctx.frame0, sr_, r, Q);
  bool zero = true;
  for (int c = 0; c < 2; ++c)
    for (std::size_t i = 0; i < Q; ++i) {
      out.ch[c][i] *= r[i];
      zero = zero && out.ch[c][i] == 0.0f;
    }
  quiet_ = zero ? std::min(quiet_ + 1, 8u) : 0;
  lastQuantumTime_ = static_cast<double>(ctx.frame0 + static_cast<std::int64_t>(Q)) / sr_;
}

void ChorusUnit::apply(const Command &c) {
  const double when = std::max(c.f.e, lastQuantumTime_);
  switch (static_cast<ChorusUnitOp>(static_cast<std::uint16_t>(c.op))) {
    case ChorusUnitOp::SetRate:
      setRate(c.f.a, when);
      break;
    case ChorusUnitOp::SetDepth:
      setDepth(c.f.a, when);
      break;
  }
}

}  // namespace rig::fx

namespace rig {

Unit *makeChorus(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch) return nullptr;
  return new fx::ChorusUnit(env.sampleRate, env.seed, spec.patch->chorus);
}

}  // namespace rig
