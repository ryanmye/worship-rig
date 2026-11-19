#include "dsp/test_voice.h"

#include <cmath>

#include "time/automation.h"

namespace rig {

void TestVoice::start(const SlotSpec &spec, int note, int vel, std::int64_t frame, double sr) {
  active_ = true;
  released_ = false;
  kind_ = spec.inst;
  note_ = note;
  amp_ = static_cast<float>(vel) / 127.0f;
  inc_ = 440.0 * std::pow(2.0, (note - 69) / 12.0) / sr;
  start_ = frame;
  endFrame_ = INT64_MAX;
  env_ = wa::Param(0.0);
  const double t0 = static_cast<double>(frame) / sr;
  const double ta = t0 + spec.attack;
  env_.setValueAtTime(0.0, t0);
  env_.linearRampToValueAtTime(1.0, ta);
  env_.setTargetAtTime(spec.sustain, ta, spec.decay);
  env_.setValueAtTime(spec.sustain, ta + wa::kRampSettleTc * spec.decay);  // pinned end
}

void TestVoice::release(const SlotSpec &spec, std::int64_t frame, double sr) {
  if (!active_ || released_) return;
  released_ = true;
  const double t = static_cast<double>(frame) / sr;
  wa::rampTo(env_, 0.0, t, spec.release);
  endFrame_ = frame + static_cast<std::int64_t>(std::ceil(wa::kRampSettleTc * spec.release * sr)) + 1;
}

bool TestVoice::render(float *out, std::int64_t q0, std::size_t n, double sr) {
  if (!active_) return false;
  const std::int64_t first = start_ > q0 ? start_ : q0;
  const std::int64_t last = q0 + static_cast<std::int64_t>(n);
  if (first >= last) return true;  // starts in a later quantum
  const std::size_t off = static_cast<std::size_t>(first - q0);
  const std::size_t cnt = static_cast<std::size_t>(last - first);
  float env[128];
  env_.processARate(first, sr, env, cnt);
  const double twoPi = 6.283185307179586;
  for (std::size_t i = 0; i < cnt; ++i) {
    const double ph = static_cast<double>(first - start_ + static_cast<std::int64_t>(i)) * inc_;
    const double frac = ph - std::floor(ph);
    const double s = kind_ == InstKind::TestSaw ? 2.0 * frac - 1.0 : std::sin(twoPi * frac);
    out[off + i] += static_cast<float>(s) * amp_ * env[i];
  }
  if (released_ && last >= endFrame_) active_ = false;
  return active_;
}

}  // namespace rig
