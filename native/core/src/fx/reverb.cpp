// Reverb render unit (kind "reverb"; fx/reverb.h, fx/reverb_unit.h). Ports the audible behaviour of fx.js Reverb
// (fx.js:579-1122) on fixed objects: HPF 180 / LPF 9k BiquadFilterNodes (wa::Biquad, Chromium formulas), per unit two
// DelayNodes with Chromium's a-rate delay kernel, GainNodes as a-rate wa::Params, the ConvolverNode as
// wa::Convolver. The predelay kernel is a port of Chromium 157.0.8103.78 third_party/blink/renderer/platform/audio/
// delay.cc and cpu/x86/delay_sse2.cc (Copyright The Chromium Authors, BSD-3, third_party/chromium/LICENSE): the
// golden renders ran the SSE path, whose read position is computed in float, reproduced here in scalar float.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iterator>

#include "api/registry.h"
#include "fx/ir_gen.h"
#include "fx/reverb_service.h"
#include "fx/reverb_unit.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "rig/rig_engine.h"
#include "time/automation.h"

namespace rig::fx {
namespace {

constexpr std::size_t Q = kQ;

/** audio_utilities::TimeToSampleFrame(time, rate, kRoundUp). */
std::size_t timeToSampleFrameUp(double time, double rate) {
  const double frame = std::round(time * rate * 1024.0) / 1024.0;
  return static_cast<std::size_t>(std::ceil(frame));
}

/** BUTTER2_Q = 20 * Math.log10(Math.SQRT1_2), as the float the BiquadFilterNode's Q param holds. */
double butterQ() {
  return static_cast<float>(20 * js::log10(js::kSqrt1_2));
}

bool allZero(const float *p) {
  for (std::size_t i = 0; i < Q; ++i)
    if (p[i] != 0.0f) return false;
  return true;
}

}  // namespace

// ---- kernels and units --------------------------------------------------------------------------------------------

std::shared_ptr<const ReverbKernel> ReverbKernel::build(double sampleRate, std::uint32_t engineSeed, double size,
                                                        double damp) {
  const IrChannels ir = engineIr(sampleRate, engineSeed, size, damp);
  return fromIr(irKey(size, damp, sampleRate), sampleRate, ir.ch[0].data(), ir.ch[1].data(), ir.length());
}

std::shared_ptr<const ReverbKernel> ReverbKernel::fromIr(std::string key, double sampleRate, const float *l,
                                                         const float *r, std::size_t length) {
  auto k = std::make_shared<ReverbKernel>();
  k->key = std::move(key);
  k->sampleRate = sampleRate;
  k->length = length;
  k->ch[0] = std::make_unique<wa::ConvolverKernel>(l, length);  // disableNormalization: true
  k->ch[1] = std::make_unique<wa::ConvolverKernel>(r, length);
  return k;
}

void PredelayLine::allocate(double sampleRate) {
  sr_ = static_cast<float>(sampleRate);
  len_ = Q + timeToSampleFrameUp(kPredelayMax, static_cast<double>(sr_));
  for (auto &b : buf_) b.assign(len_, 0.0f);
  w_ = 0;
}

void PredelayLine::clear() {
  for (auto &b : buf_) std::fill(b.begin(), b.end(), 0.0f);
  w_ = 0;
}

void PredelayLine::process(const float *const in[2], float *const out[2], const float *delayTimes) {
  // Delay::ProcessARate: copy the quantum into the circular buffer first, then read (delay_sse2.cc, 4 lanes of float)
  for (int c = 0; c < 2; ++c) {
    float *b = buf_[c].data();
    const std::size_t first = std::min(Q, len_ - w_);
    std::memcpy(b + w_, in[c], first * sizeof(float));
    if (first < Q) std::memcpy(b, in[c] + first, (Q - first) * sizeof(float));
  }
  const float lenF = static_cast<float>(len_);
  const long len = static_cast<long>(len_);
  for (std::size_t i = 0; i < Q; ++i) {
    long wi = static_cast<long>(w_ + i);
    if (wi >= len) wi -= len;
    const float desired = std::max(delayTimes[i], 0.0f) * sr_;
    float rp = static_cast<float>(wi) + (lenF - desired);
    if (rp >= lenF) rp -= lenF;
    long i1 = static_cast<long>(rp);  // _mm_cvttps_epi32
    if (i1 >= len) i1 -= len;
    long i2 = i1 + 1;
    if (i2 >= len) i2 -= len;
    const float f = rp - static_cast<float>(i1);
    for (int c = 0; c < 2; ++c) {
      const float s1 = buf_[c][static_cast<std::size_t>(i1)], s2 = buf_[c][static_cast<std::size_t>(i2)];
      out[c][i] = s1 + f * (s2 - s1);
    }
  }
  w_ += Q;
  if (w_ >= len_) w_ -= len_;
}

ConvUnit::ConvUnit(std::shared_ptr<const ReverbKernel> k, double sampleRate) : kernel(std::move(k)) {
  for (unsigned c = 0; c < 2; ++c) conv[c] = std::make_unique<wa::Convolver>(*kernel->ch[c], c);
  for (auto &l : line) l.allocate(sampleRate);
}

std::size_t ConvUnit::bytes() const {
  return conv[0]->bytes() + conv[1]->bytes() + 4 * line[0].length() * sizeof(float);
}

// ---- the render unit ----------------------------------------------------------------------------------------------

ReverbUnit::ReverbUnit(double sampleRate, double returnGain) : sr_(sampleRate), ret_(1.0) {
  setSampleRate(sampleRate);
  // FxGraph start: _applyFx(patch.fx, 0) -> rampTo(ret.gain, returnGain, 0) on a GainNode created at 1
  wa::rampTo(ret_, returnGain, 0.0, wa::kTau);
}

ReverbUnit::~ReverbUnit() {
  for (Slot &s : slots_) delete s.unit;
  for (unsigned i = 0; i < garbageN_; ++i) delete garbage_[i];
}

void ReverbUnit::setSampleRate(double sr) {
  sr_ = sr;
  const double q = butterQ();
  for (int c = 0; c < 2; ++c) {
    hpf_[c].set(wa::BiquadType::Highpass, 180.0, q, 0.0, sr);
    lpf_[c].set(wa::BiquadType::Lowpass, 9000.0, q, 0.0, sr);
  }
}

wa::Param *ReverbUnit::param(std::uint32_t index) {
  if (index == kReverbReturnGain) return &ret_;
  if (index == kReverbWheel) return &wheel_;
  return nullptr;
}

std::uint32_t ReverbUnit::liveVoices() const {
  for (const Slot &s : slots_)
    if (s.unit && !s.skipping) return 1;
  return 0;
}

void ReverbUnit::giveBackLater(Owned *p) {
  if (!p) return;
  if (garbageN_ < std::size(garbage_)) garbage_[garbageN_++] = p;
  // else: more than 16 payloads replaced inside one quantum (never sent by the pool): kept until destruction would
  // need storage, so it is leaked rather than freed on the audio thread
}

void ReverbUnit::setUnitPd(Slot &sl, double p) {
  // Reverb._setUnitPd: a silent (disconnected) unit takes the predelay at once on line A
  const double now = nextTime_;
  sl.cur = 0;
  for (auto &d : sl.delayTime) wa::setNow(d, p, now);
  wa::setNow(sl.pg[0], 1, now);
  wa::setNow(sl.pg[1], 0, now);
}

void ReverbUnit::pdTo(Slot &sl, double p, double when) {
  // Reverb._pdTo on a live unit (the pool decided it is due): the idle line takes p, the lines crossfade 0.5 s
  const unsigned nx = 1 - sl.cur;
  wa::setNow(sl.delayTime[nx], p, when);
  wa::equalPowerFade(sl.pg[sl.cur], 1, 0, when, kPredelayFade);
  wa::equalPowerFade(sl.pg[nx], 0, 1, when, kPredelayFade);
  sl.cur = nx;
}

void ReverbUnit::start(unsigned s, double when, double fade, double predelay, int fadeOutSlot) {
  Slot &sl = slots_[s];
  setUnitPd(sl, predelay);  // the unit is silent (out gain 0) until its fade starts
  sl.connected = true;
  sl.disconnectFrame = -1;
  if (fade > 0)
    wa::equalPowerFade(sl.out, 0, 1, when, fade);
  else
    wa::setNow(sl.out, 1, when);
  const unsigned fo = static_cast<unsigned>(fadeOutSlot);
  if (fadeOutSlot >= 0 && fo < kReverbSlots && fo != s && slots_[fo].unit) {
    Slot &o = slots_[fo];
    wa::equalPowerFade(o.out, 1, 0, when, fade);
    // the JS timer at idleAt (AudioTimer: quantum k = ceil(t sr / 128 - 1e-6)) disconnects its input
    const double idleAt = when + fade + kIdleAfterFade;
    o.disconnectFrame = static_cast<std::int64_t>(std::ceil(idleAt * sr_ / static_cast<double>(Q) - 1e-6)) *
                        static_cast<std::int64_t>(Q);
  }
  active_ = s;
}

void ReverbUnit::installInitial(ConvUnit *u) {
  const unsigned s = u->slot < kReverbSlots ? u->slot : 0;
  delete slots_[s].unit;
  slots_[s].unit = u;
  start(s, 0.0, 0.0, u->predelay, -1);  // Reverb.init: setNow(out.gain, 1, 0)
}

void ReverbUnit::apply(const Command &c) {
  const std::uint16_t op = static_cast<std::uint16_t>(c.op);
  if (op == static_cast<std::uint16_t>(ReverbOp::AttachKernel)) {
    auto *u = static_cast<ConvUnit *>(static_cast<Owned *>(c.p.ptr));
    if (!u) return;
    if (u->slot >= kReverbSlots) {
      giveBackLater(u);
      return;
    }
    Slot &sl = slots_[u->slot];
    giveBackLater(sl.unit);
    sl.unit = u;
    sl.silentFrames = static_cast<std::size_t>(-1) / 2;  // fresh state: nothing rings yet
    sl.skipping = true;
    start(u->slot, u->when, u->fade, u->predelay, u->fadeOutSlot);
    return;
  }
  const unsigned s = c.aux;
  if (s >= kReverbSlots) return;
  Slot &sl = slots_[s];
  if (op == static_cast<std::uint16_t>(ReverbOp::Reactivate)) {
    if (sl.unit) start(s, c.f.a, c.f.b, c.f.c, static_cast<int>(c.f.d));
  } else if (op == static_cast<std::uint16_t>(ReverbOp::Release)) {
    giveBackLater(sl.unit);
    sl.unit = nullptr;
    sl.connected = false;
    sl.skipping = true;
    sl.disconnectFrame = -1;
    if (active_ == s) active_ = 0;
  } else if (op == static_cast<std::uint16_t>(ReverbOp::Feed)) {
    sl.connected = c.f.a != 0;
    sl.disconnectFrame = -1;
  } else if (op == static_cast<std::uint16_t>(ReverbOp::SetPredelay)) {
    if (c.f.c != 0)
      setUnitPd(sl, c.f.a);
    else
      pdTo(sl, c.f.a, c.f.b);
  }
}

void ReverbUnit::renderSlot(const RenderContext &ctx, Slot &sl, const float *const feed[2], float *const acc[2]) {
  if (sl.disconnectFrame >= 0 && ctx.frame0 >= sl.disconnectFrame) {
    sl.connected = false;
    sl.disconnectFrame = -1;
  }
  const float *const fin[2] = {sl.connected ? feed[0] : zeros_, sl.connected ? feed[1] : zeros_};
  // the params advance every quantum, also while the DSP is skipped (their timelines stay in step)
  alignas(16) float dt[2][Q], g[2][Q], og[Q];
  for (int l = 0; l < 2; ++l) {
    sl.delayTime[l].processARate(ctx.frame0, ctx.sampleRate, dt[l], Q);
    sl.pg[l].processARate(ctx.frame0, ctx.sampleRate, g[l], Q);
  }
  sl.out.processARate(ctx.frame0, ctx.sampleRate, og, Q);
  const bool silentIn = !sl.connected || (allZero(fin[0]) && allZero(fin[1]));
  sl.silentFrames = silentIn ? std::min(sl.silentFrames + Q, static_cast<std::size_t>(-1) / 2) : 0;
  const ConvUnit &u = *sl.unit;
  const std::size_t quiet = u.line[0].length() + u.conv[0]->tailFrames() + 2 * Q;
  if (sl.silentFrames > quiet) {
    sl.skipping = true;  // delay buffers and convolver state are all zeros: the output is exactly zero
    return;
  }
  sl.skipping = false;
  alignas(16) float d[2][2][Q];  // [line][channel]
  for (int l = 0; l < 2; ++l) {
    float *const o[2] = {d[l][0], d[l][1]};
    sl.unit->line[l].process(fin, o, dt[l]);
  }
  alignas(16) float x[Q], y[Q];
  for (int c = 0; c < 2; ++c) {
    // the two GainNodes summed at the ConvolverNode input (two terms: order-independent)
    for (std::size_t i = 0; i < Q; ++i) x[i] = d[0][c][i] * g[0][i] + d[1][c][i] * g[1][i];
    sl.unit->conv[c]->process(x, y);
    for (std::size_t i = 0; i < Q; ++i) acc[c][i] += y[i] * og[i];
  }
}

void ReverbUnit::process(const RenderContext &ctx, UnitIO &io) {
  for (unsigned i = 0; i < garbageN_; ++i) giveBack(ctx, garbage_[i]);
  garbageN_ = 0;
  alignas(16) float x[2][Q];
  const Bus *in = io.in;
  if (in && in->channels >= 1) {
    std::memcpy(x[0], in->ch[0], sizeof x[0]);
    std::memcpy(x[1], in->ch[in->channels == 2 ? 1 : 0], sizeof x[1]);  // mono: Web Audio up-mix
  } else {
    std::memset(x, 0, sizeof x);
  }
  for (int c = 0; c < 2; ++c) {
    hpf_[c].process(x[c], x[c], Q);
    lpf_[c].process(x[c], x[c], Q);
  }
  Bus &out = *io.out;
  out.channels = 2;
  std::memset(out.ch, 0, sizeof out.ch);
  float *const acc[2] = {out.ch[0], out.ch[1]};
  const float *const feed[2] = {x[0], x[1]};
  for (Slot &sl : slots_)
    if (sl.unit) renderSlot(ctx, sl, feed, acc);
  alignas(16) float rg[Q], wg[Q];
  ret_.processARate(ctx.frame0, ctx.sampleRate, rg, Q);
  wheel_.processARate(ctx.frame0, ctx.sampleRate, wg, Q);
  for (int c = 0; c < 2; ++c)
    for (std::size_t i = 0; i < Q; ++i) out.ch[c][i] = out.ch[c][i] * rg[i] * wg[i];
  nextTime_ = static_cast<double>(ctx.frame0 + static_cast<std::int64_t>(Q)) / ctx.sampleRate;
}

// ---- factory ------------------------------------------------------------------------------------------------------

Unit *makeStandaloneReverb(const UnitEnv &env, const UnitSpec &spec) {
  ReverbPatch rp;
  if (spec.patch) rp = spec.patch->reverb;
  auto *u = new ReverbUnit(env.sampleRate, rp.returnGain);
  auto *cu = new ConvUnit(ReverbKernel::build(env.sampleRate, env.seed, rp.size, rp.damp), env.sampleRate);
  cu->predelay = std::clamp(rp.predelay, 0.0, kPredelayMax);
  u->installInitial(cu);
  return u;
}

}  // namespace rig::fx

namespace rig {

Unit *makeReverb(const UnitEnv &env, const UnitSpec &spec) {
  if (fx::ReverbPool *pool = fx::ReverbPool::forPatch(spec.patch)) return pool->buildUnit(env, spec);
  return fx::makeStandaloneReverb(env, spec);
}

}  // namespace rig
