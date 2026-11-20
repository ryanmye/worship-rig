// voice.js Voice (sources, stop bookkeeping, envelope, fades), TrackedParam and FmDepth (inst/synth_voice.h).
#include "inst/synth_voice.h"

#include <algorithm>
#include <cstring>

#include "dsp/oscillator_schedule.h"
#include "num/js_math.h"
#include "time/automation.h"

namespace rig::inst {

// ---- TrackedParam ----------------------------------------------------------------------------------------------

double TrackedParam::valueAt(double t) const {
  if (t >= t1 || t1 <= t0) return v1;
  if (t <= t0) return v0;
  return v0 * js::pow(v1 / v0, (t - t0) / (t1 - t0));
}

void TrackedParam::glide(double value, double t, double dur) {
  const double cur = valueAt(t);
  wa::setNow(*param, cur, t);
  if (dur > 0)
    wa::glideTo(*param, value, t, dur, cur);
  else
    wa::setNow(*param, value, t);
  v0 = cur;
  v1 = value;
  t0 = t;
  t1 = t + std::max(0.0, dur);
}

// ---- FmDepth ---------------------------------------------------------------------------------------------------

void FmDepth::init(wa::Param *p, double i0_, double floor_, double tau_, double fm_, double cap_, double t0_) {
  param = p;
  i0 = i0_;
  floor = floor_;
  tau = tau_;
  fm = fm_;
  cap = cap_;
  t0 = t0_;
  hasG = false;
  schedule(t0, NAN, 0);
}

double FmDepth::index(double t) const {
  if (!(tau < kInf)) return i0;
  return floor + (i0 - floor) * js::exp(-std::max(0.0, t - t0) / tau);
}

double FmDepth::valueAt(double t) const {
  if (hasG && t < gt1) return t <= gt ? gfrom : gfrom + ((gto - gfrom) * (t - gt)) / (gt1 - gt);
  return std::min(index(t), cap) * fm;
}

void FmDepth::schedule(double t, double from, double dur) {
  wa::Param &p = *param;
  const double t1 = t + std::max(0.0, dur);
  const double iT = index(t1);
  const double v1 = std::min(iT, cap) * fm;
  if (dur > 0 && std::isfinite(from)) {
    if (from > 1e-3 && v1 > 1e-3)
      wa::glideTo(p, v1, t, dur, from);  // ∝ fm, which glides exponentially
    else
      wa::linearTo(p, v1, t, dur, from);
    hasG = true;
    gt = t;
    gt1 = t1;
    gfrom = from;
    gto = v1;
  } else {
    wa::setNow(p, v1, t);
    hasG = false;
  }
  if (!(tau < kInf) || !(iT > floor)) return;
  const double target = std::min(floor, cap) * fm;
  if (iT <= cap) {
    wa::rampTo(p, target, t1, tau);
  } else if (cap > floor) {  // held at the cap until the nominal decay crosses it, then the same exponential
    const double tc = t0 + tau * js::log((i0 - floor) / (cap - floor));
    wa::rampTo(p, target, std::max(t1, tc), tau);
  }
}

void FmDepth::retune(double fm_, double cap_, double t, double dur) {
  const double from = valueAt(t);
  fm = fm_;
  cap = cap_;
  schedule(t, from, dur);
}

// ---- Voice -----------------------------------------------------------------------------------------------------

void SynthVoice::setWaves(const WaveBank &bank) {
  for (unsigned i = 0; i < nSrc_; ++i)
    if (srcs_[i].osc && srcs_[i].kind != WaveKind::None) srcs_[i].osc->setWave(bank.wave(srcs_[i].kind, srcs_[i].rot));
}

void SynthVoice::addSource(wa::Oscillator *o, double when, WaveKind kind, unsigned rot) {
  VoiceSrc &s = srcs_[nSrc_++];
  s.osc = o;
  s.kind = kind;
  s.rot = static_cast<std::uint8_t>(rot);
  s.startT = when;
  o->start(when);
  if (std::isfinite(stopAt_)) stopSource(nSrc_ - 1, stopAt_);
}

void SynthVoice::addSource(wa::BufferSource *b, double when, double offset) {
  VoiceSrc &s = srcs_[nSrc_++];
  s.buf = b;
  s.startT = when;
  b->start(when, offset);
  if (std::isfinite(stopAt_)) stopSource(nSrc_ - 1, stopAt_);
}

void SynthVoice::stopSource(unsigned i, double t) {
  VoiceSrc &s = srcs_[i];
  if (!(t < s.stopAt)) return;
  s.stopAt = t;
  const double at = std::max(t, startedAt_);
  if (s.osc) s.osc->stop(at);
  if (s.buf) s.buf->stop(at);
}

void SynthVoice::scheduleStop(double t) {
  if (!(t < stopAt_)) return;
  stopAt_ = t;
  for (unsigned i = 0; i < nSrc_; ++i) stopSource(i, t);
}

bool SynthVoice::srcActive(unsigned i, std::int64_t f0, double sr, std::size_t n) const {
  if (i >= nSrc_ || f0 < 0) return false;
  const VoiceSrc &s = srcs_[i];
  const auto q0 = static_cast<std::uint64_t>(f0), q1 = q0 + n;
  if (wa::sched::timeToSampleFrame(s.startT, sr, wa::sched::Rounding::Up) >= q1) return false;
  if (std::isfinite(s.stopAt)) {
    const double end = std::max(s.stopAt, startedAt_);
    if (wa::sched::timeToSampleFrame(end, sr, wa::sched::Rounding::Up) <= q0) return false;
  }
  return true;
}

bool SynthVoice::sourcesFinished() const {
  for (unsigned i = 0; i < nSrc_; ++i) {
    const VoiceSrc &s = srcs_[i];
    if (s.osc && !s.osc->finished()) return false;
    if (s.buf && !s.buf->ended()) return false;
  }
  return true;
}

void SynthVoice::makeEnv(const EnvSpec &e, double t) {
  wa::Param &g = envG.gain();
  const double a = std::max(0.002, e.a);
  const double s = std::max(0.0, std::min(1.0, e.s));
  wa::setNow(g, 0, t);  // anchor: the ramp must start at `t`, not at the previous event
  wa::linearTo(g, 1, t, a, 0);
  const double dTau = e.dTau > 0 ? e.dTau : std::max(0.001, e.d > 0 ? e.d : 0.001) / 3;
  if (s < 1) wa::rampTo(g, 1 * s, t + a, dTau);
}

double SynthVoice::envRelease(double rt, double r) {
  const double rr = std::max(0.005, std::isfinite(r) ? r : 0.0);
  wa::rampTo(envG.gain(), 0, rt, wa::releaseTau(rr));
  return wa::stopAfterRelease(rt, rr);
}

void SynthVoice::fadeOut(double t, double fadeSec) {
  const double f = std::max(0.003, fadeSec);
  wa::rampTo(outG.gain(), 0, t, wa::releaseTau(f));
  scheduleStop(wa::stopAfterRelease(t, f));
}

void SynthVoice::envOut(const VoiceIn &in, float *l, float *r, unsigned nch) {
  float *ch[2] = {sumL_, sumR_};
  envG.process(ch, ch, nch, in.n, in.frame0, in.sr);
  outG.process(ch, ch, nch, in.n, in.frame0, in.sr);
  for (std::size_t i = 0; i < in.n; ++i) l[i] += sumL_[i];
  if (nch == 2 && r)
    for (std::size_t i = 0; i < in.n; ++i) r[i] += sumR_[i];
}

}  // namespace rig::inst
