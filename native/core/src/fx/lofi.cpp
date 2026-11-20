// T05: lofi render unit (kind "lofi"; fx/lofi.h, fx/lofi_unit.h). Ports fx.js Lofi (fx.js:1372-1563): WaveShapers
// are wa::WaveShaper (T03, Chromium port incl. the 4x Up/DownSampler), LFOs wa::Oscillator (T11a), the crackle loop
// wa::BufferSource (T11a), the tape DelayNode fx::DelayNodeKernel (Chromium 157.0.8103.78 delay.cc /
// delay_sse2.cc, BSD-3, third_party/chromium/LICENSE), BiquadFilterNodes wa::Biquad with per-sample coefficients
// while automating. Curves and the crackle buffer use rig::js math (what fx.js computes in JavaScript).
#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>

#include "api/registry.h"
#include "fx/lofi_unit.h"
#include "num/js_math.h"
#include "num/prng.h"
#include "time/automation.h"

namespace rig::fx {
namespace {

constexpr std::size_t Q = kQ;
constexpr double kTauFx = wa::kTau;

double butterQ() {
  return static_cast<float>(20 * js::log10(js::kSqrt1_2));
}

std::mutex gCurveMu;
std::map<std::pair<char, double>, std::shared_ptr<const LofiCurve>> gCurves;  // fx.js CURVES

std::shared_ptr<const LofiCurve> cached(char kind, double key) {
  std::lock_guard<std::mutex> lk(gCurveMu);
  auto &slot = gCurves[{kind, key}];
  if (slot) return slot;
  auto c = std::make_shared<LofiCurve>();
  if (kind == 't') {  // tanhCurve(driveDb): tanh(g x)/g in the x4 domain, 4096 points
    const int n = 4096;
    c->v.resize(n);
    const double g = js::pow(10, key / 20);
    for (int i = 0; i < n; ++i) {
      const double x = ((i / static_cast<double>(n - 1)) * 2 - 1) / kLofiPre;
      c->v[static_cast<std::size_t>(i)] = static_cast<float>((key <= 0.01 ? x : js::tanh(g * x) / g) * kLofiPre);
    }
  } else {  // quantCurve(bits): round(x 2^(bits-1)) / 2^(bits-1), 32768 points
    const int n = 32768;
    c->v.resize(n);
    const double steps = js::pow(2, key - 1);
    for (int i = 0; i < n; ++i) {
      const double x = ((i / static_cast<double>(n - 1)) * 2 - 1) / kLofiPre;
      c->v[static_cast<std::size_t>(i)] = static_cast<float>((js::round(x * steps) / steps) * kLofiPre);
    }
  }
  slot = c;
  return slot;
}

}  // namespace

LofiKeys lofiKeys(const LofiPatch &p) {
  const double a = p.amount;
  const double driveDb = 9 * std::min(1.0, a * 2 * p.saturation);
  const double bits = std::max(10.0, js::round(16 - 5 * std::min(1.0, a * (0.5 + p.bits))));
  return {js::round(driveDb * 4) / 4, static_cast<int>(bits)};
}

std::shared_ptr<const LofiCurve> lofiTanhCurve(double driveDb) {
  return cached('t', driveDb);
}
std::shared_ptr<const LofiCurve> lofiQuantCurve(int bits) {
  return cached('q', bits);
}

LofiState *LofiState::make(const LofiPatch &p, bool held, bool tapeActive) {
  auto *s = new LofiState;
  s->p = p;
  const LofiKeys k = lofiKeys(p);
  s->sat = lofiTanhCurve(k.dk);
  if (k.bits < 16) s->quant = lofiQuantCurve(k.bits);
  s->held = held;
  s->tapeActive = tapeActive;
  return s;
}

// ---- unit ---------------------------------------------------------------------------------------------------------

LofiUnit::LofiUnit(double sampleRate, std::uint32_t seed, LofiState *initial)
    : sr_(sampleRate),
      lpfFreq_(18000.0, 0.0f, static_cast<float>(sampleRate / 2)),
      lpfQ_(butterQ()),
      hpfFreq_(20.0, 0.0f, static_cast<float>(sampleRate / 2)),
      hpfQ_(butterQ()),
      engageDelay_(0.0075 + 320 / sampleRate) {
  sat_ = std::make_unique<wa::WaveShaper>(nullptr, 0, wa::WaveShaper::Oversample::X4, 2);
  quant_ = std::make_unique<wa::WaveShaper>(nullptr, 0, wa::WaveShaper::Oversample::None, 2);
  tape_.allocate(1.0, sr_, 2);
  sine_.reset(wa::PeriodicWave::basic(wa::PeriodicWave::Basic::Sine, sr_));
  wowLfo_ = std::make_unique<wa::Oscillator>(sine_.get(), 0.35);
  flutLfo_ = std::make_unique<wa::Oscillator>(sine_.get(), 5.0);
  wowLfo_->start(0);
  flutLfo_->start(0);
  for (auto &f : crackleBpf_) f.set(wa::BiquadType::Bandpass, 2500.0f, 0.8f, 0.0, sr_);
  // crackle: sparse random impulses in a 6 s seeded loop (Float32Array d[p + j] += a e^(-.8 j): double sum, float)
  Rng rng = rngFor(seed, "crackle");
  const std::size_t len = static_cast<std::size_t>(std::floor(sr_ * 6));
  for (unsigned c = 0; c < 2; ++c) {
    std::vector<float> &d = crackleData_[c];
    d.assign(len, 0.0f);
    const int n = 60 + static_cast<int>(std::floor(rng.next() * 30));
    for (int i = 0; i < n; ++i) {
      const std::size_t p = static_cast<std::size_t>(std::floor(rng.next() * static_cast<double>(len - 8)));
      const double mag = 0.3 + rng.next() * 0.7;
      const double a = mag * (rng.next() < 0.5 ? -1 : 1);
      for (int j = 0; j < 6; ++j) d[p + static_cast<std::size_t>(j)] =
          static_cast<float>(static_cast<double>(d[p + static_cast<std::size_t>(j)]) + a * js::exp(-j * 0.8));
    }
  }
  crackleBuf_.channels = 2;
  crackleBuf_.frames = len;
  crackleBuf_.sampleRate = sr_;
  crackleBuf_.f32[0] = crackleData_[0].data();
  crackleBuf_.f32[1] = crackleData_[1].data();
  crackleBuf_.bytes = 2 * len * sizeof(float);
  crackle_.setBuffer(&crackleBuf_);
  // _applyFx(init): Object.assign(lofi.p, fx.lofi); lofi.apply(0)
  if (initial) applyState(initial, 0);
}

LofiUnit::~LofiUnit() {
  delete state_;
  for (unsigned i = 0; i < garbageN_; ++i) delete garbage_[i];
}

double LofiUnit::dryAt(double t) const {
  if (t <= xf_.t0) return xf_.from;
  if (!(xf_.dur > 0) || t >= xf_.t0 + xf_.dur) return xf_.to;
  return xf_.from + ((xf_.to - xf_.from) * (t - xf_.t0)) / xf_.dur;
}

void LofiUnit::applyState(LofiState *s, double when) {
  LofiState *old = state_;
  state_ = s;
  const LofiPatch &p = s->p;
  // _updateCurves: the curve objects are cached per key, so a pointer change is a key change
  if (!old || old->sat != s->sat) sat_->setCurve(s->sat ? s->sat->v.data() : nullptr, s->sat ? s->sat->v.size() : 0);
  if (!old || old->quant != s->quant)
    quant_->setCurve(s->quant ? s->quant->v.data() : nullptr, s->quant ? s->quant->v.size() : 0);
  if (old) {
    if (garbageN_ < std::size(garbage_)) garbage_[garbageN_++] = old;  // handed back from process()
    // else: leaked (counted nowhere; at most 8 applies per quantum are buffered)
  }
  const double a = p.amount;
  if (s->holdOnly) {  // JS hold() calls _engage only: re-issuing the ramps would restart their setTarget curves
    engage(a > 0 || s->held, when);
    return;
  }
  if (!s->tapeActive) {
    wa::rampTo(wowDepth_, 0.002 * a * p.wow, when, 0.05);
    wa::rampTo(flutDepth_, 0.00003 * a * p.flutter, when, 0.05);
    const double lpHz = 18000 * js::pow(3500.0 / 18000, a * (0.4 + 0.6 * (1 - p.tone)));
    wa::rampTo(lpfFreq_, lpHz, when, kTauFx);
  }
  const double hpHz = 20 * js::pow(6, a * (0.5 + 0.5 * (1 - p.tone)));
  wa::rampTo(hpfFreq_, hpHz, when, kTauFx);
  const double crDb = -60 + 22 * std::min(1.0, p.crackle);
  const double cg = a > 0 && p.crackle > 0 ? js::pow(10, crDb / 20) * std::min(1.0, a * 1.5) * 4 : 0;
  wa::rampTo(crackleGain_, cg, when, 0.05);
  engage(a > 0 || s->held, when);
}

void LofiUnit::engage(bool on, double when) {
  if (on == engaged_) return;
  engaged_ = on;
  const std::uint32_t seq = ++seq_;
  if (on) {
    wetConnected_ = true;
    if (!crackleOn_) {
      crackle_ = wa::BufferSource(&crackleBuf_);
      crackle_.setLoop(true, 0, 0);
      crackle_.start(when);
      crackleOn_ = true;
    }
    // 30 ms crossfade (linear: dry and wet are correlated), started after the wet path's latency
    const double w = when + engageDelay_;
    const double from = dryAt(w);
    wa::linFrom(dry_, from, 0, w, 0.03);
    wa::linFrom(wet_, 1 - from, 1, w, 0.03);
    xf_ = {w, 0.03, from, 0};
  } else {
    const double from = dryAt(when);
    wa::linFrom(dry_, from, 1, when, 0.03);  // linear ramp ends exactly at 1.0 -> bit-exact afterwards
    wa::linFrom(wet_, 1 - from, 0, when, 0.03);
    xf_ = {when, 0.03, from, 1};
    disc_.armed = true;
    disc_.t = when + 0.04;
    disc_.quantum = static_cast<std::int64_t>(std::ceil(disc_.t * sr_ / 128.0 - 1e-6));
    disc_.seq = seq;
  }
}

void LofiUnit::runTimer(std::int64_t frame0) {
  if (!disc_.armed || disc_.quantum > frame0 / static_cast<std::int64_t>(Q)) return;
  disc_.armed = false;
  if (disc_.seq != seq_ || engaged_) return;
  wetConnected_ = false;  // input.disconnect(wetIn), wet.disconnect(output); the crackle source is stopped
  crackleOn_ = false;
}

void LofiUnit::renderWet(std::int64_t frame0, const Bus &in, float *const wet[2]) {
  alignas(16) float x[2][Q], y[2][Q], a[Q], b[Q], dt[Q], w1[Q], w2[Q];
  const float *src[2] = {in.ch[0], in.channels == 1 ? in.ch[0] : in.ch[1]};
  // wetIn x.25 -> drive x1 (constant GainNodes)
  for (int c = 0; c < 2; ++c)
    for (std::size_t i = 0; i < Q; ++i) x[c][i] = (src[c][i] * static_cast<float>(kLofiPre)) * 1.0f;
  float *xs[2] = {x[0], x[1]};
  sat_->process(xs, 2, Q);
  quant_->process(xs, 2, Q);
  // tape DelayNode: 5 ms timeline + wow + flutter connections (a-rate), clipped to [0, 1]
  wowLfo_->process(frame0, sr_, w1, Q);
  wowDepth_.processARate(frame0, sr_, a, Q);
  for (std::size_t i = 0; i < Q; ++i) w1[i] *= a[i];
  flutLfo_->process(frame0, sr_, w2, Q);
  flutDepth_.processARate(frame0, sr_, a, Q);
  for (std::size_t i = 0; i < Q; ++i) w2[i] *= a[i];
  tapeTime_.processARate(frame0, sr_, dt, Q);
  const float *conns[2] = {w1, w2};
  sumAndClip(dt, conns, 2, 0.005f, 0.0f, 1.0f, Q);
  {
    const float *s2[2] = {x[0], x[1]};
    float *d2[2] = {y[0], y[1]};
    tape_.process(s2, d2, 2, dt);
  }
  // HPF -> LPF
  const bool hpMoving = hpfFreq_.hasSampleAccurateValues(frame0, sr_) || hpfQ_.hasSampleAccurateValues(frame0, sr_);
  hpfFreq_.processARate(frame0, sr_, a, Q);
  hpfQ_.processARate(frame0, sr_, b, Q);
  for (int c = 0; c < 2; ++c) biquadQuantum(hpf_[c], wa::BiquadType::Highpass, a, b, hpMoving, sr_, y[c], y[c]);
  const bool lpMoving = lpfFreq_.hasSampleAccurateValues(frame0, sr_) || lpfQ_.hasSampleAccurateValues(frame0, sr_);
  lpfFreq_.processARate(frame0, sr_, a, Q);
  lpfQ_.processARate(frame0, sr_, b, Q);
  for (int c = 0; c < 2; ++c) biquadQuantum(lpf_[c], wa::BiquadType::Lowpass, a, b, lpMoving, sr_, y[c], y[c]);
  // crackle -> BPF -> crackle gain
  float *cr[2] = {x[0], x[1]};
  crackle_.process(frame0, sr_, cr, Q);
  for (int c = 0; c < 2; ++c) crackleBpf_[c].process(x[c], x[c], Q);
  crackleGain_.processARate(frame0, sr_, a, Q);
  // makeup x4 + crackle into wet
  wet_.processARate(frame0, sr_, b, Q);
  for (int c = 0; c < 2; ++c)
    for (std::size_t i = 0; i < Q; ++i) wet[c][i] = (y[c][i] * 4.0f + x[c][i] * a[i]) * b[i];
}

void LofiUnit::process(const RenderContext &ctx, UnitIO &io) {
  for (unsigned i = 0; i < garbageN_; ++i) giveBack(ctx, garbage_[i]);
  garbageN_ = 0;
  runTimer(ctx.frame0);
  Bus &out = *io.out;
  const Bus *in = io.in;
  alignas(16) float d[Q];
  dry_.processARate(ctx.frame0, sr_, d, Q);
  if (!in) {
    out.clear(2);
  } else {
    out.channels = in->channels;
    for (unsigned c = 0; c < in->channels; ++c)
      for (std::size_t i = 0; i < Q; ++i) out.ch[c][i] = in->ch[c][i] * d[i];
  }
  if (wetConnected_ && in) {
    alignas(16) float w[2][Q];
    float *wp[2] = {w[0], w[1]};
    renderWet(ctx.frame0, *in, wp);
    if (out.channels == 1) {
      std::copy(out.ch[0], out.ch[0] + Q, out.ch[1]);
      out.channels = 2;
    }
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < Q; ++i) out.ch[c][i] += w[c][i];
  }
  lastQuantumTime_ = static_cast<double>(ctx.frame0 + static_cast<std::int64_t>(Q)) / sr_;
}

void LofiUnit::apply(const Command &c) {
  if (static_cast<LofiOp>(static_cast<std::uint16_t>(c.op)) != LofiOp::Apply || !c.p.ptr) return;
  auto *s = dynamic_cast<LofiState *>(static_cast<Owned *>(c.p.ptr));
  if (!s) return;
  applyState(s, std::max(s->when, lastQuantumTime_));
}

wa::Param *LofiUnit::param(std::uint32_t index) {
  switch (index) {
    case kLofiDry:
      return &dry_;
    case kLofiWet:
      return &wet_;
    case kLofiLpfHz:
      return &lpfFreq_;
    case kLofiHpfHz:
      return &hpfFreq_;
    case kLofiCrackleGain:
      return &crackleGain_;
    case kLofiTapeTime:
      return &tapeTime_;
    case kLofiLpfQ:
      return &lpfQ_;
    default:
      return nullptr;
  }
}

}  // namespace rig::fx

namespace rig {

Unit *makeLofi(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch) return nullptr;
  return new fx::LofiUnit(env.sampleRate, env.seed, fx::LofiState::make(spec.patch->lofi));
}

}  // namespace rig
