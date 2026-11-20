// T05: echo render unit (kind "delay"; fx/delay.h, fx/delay_unit.h). Ports fx.js Delay/DelayLine (fx.js:1124-1335)
// on fixed objects: GainNodes as a-rate wa::Params, DelayNodes as fx::DelayNodeKernel (Chromium 157.0.8103.78
// delay.cc / delay_sse2.cc port, BSD-3, third_party/chromium/LICENSE), the tone BiquadFilterNode as wa::Biquad with
// Chromium's per-sample coefficients while its frequency automates (biquad_dsp_kernel.cc), the AudioTimer callbacks
// as audio-side timers with the offline quantum semantics.
#include <algorithm>
#include <cmath>
#include <cstring>

#include "api/registry.h"
#include "fx/delay_unit.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "time/automation.h"

namespace rig::fx {
namespace {

constexpr std::size_t Q = kQ;
constexpr double kTauFx = wa::kTau;  // fx.js TAU (15 ms)

/** BUTTER2_Q = 20 * Math.log10(Math.SQRT1_2) as the float the BiquadFilterNode's Q param holds. */
double butterQ() {
  return static_cast<float>(20 * js::log10(js::kSqrt1_2));
}

bool allZero(const float *p, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i)
    if (p[i] != 0.0f) return false;
  return true;
}

}  // namespace

double delayEffectiveTime(const DelayPatch &p, double tempo) {
  if (p.sync != 0 && tempo > 0) {
    const double beat = 60 / tempo;
    const double mult = p.sync == 1 ? 1 : p.sync == 2 ? 0.75 : 0.5;  // 1/4 | 1/8d | 1/8
    return std::min(1.9, std::max(0.02, beat * mult));
  }
  return std::min(1.9, std::max(0.02, p.time));
}

double delayToneHz(double tone) {
  return 1200 * js::pow(10, std::min(1.0, std::max(0.0, tone)));
}

// ---- DelayLine (fx.js:1132-1208) ----------------------------------------------------------------------------------

void DelayUnit::Line::setFeedback(double fb, bool pp, double when, double tc) {
  const double f = std::min(0.9, std::max(0.0, fb));
  wa::rampTo(fbLL, pp ? 0 : f, when, tc);
  wa::rampTo(fbRR, pp ? 0 : f, when, tc);
  wa::rampTo(fbLR, pp ? f : 0, when, tc);
  wa::rampTo(fbRL, pp ? f : 0, when, tc);
}

void DelayUnit::Line::setPingpong(bool pp, double when) {
  wa::rampTo(inLL, pp ? 0.5 : 1, when, kTauFx);
  wa::rampTo(inRL, pp ? 0.5 : 0, when, kTauFx);
  wa::rampTo(inRR, pp ? 0 : 1, when, kTauFx);
}

void DelayUnit::Line::setTimeNow(double t, double when, double q) {
  time = t;
  tg = {when, 0, t, t, true};
  wa::setNow(dTime, t - q, when);
}

double DelayUnit::Line::timeAt(double when) const {
  if (!tg.set) return time;
  if (!(tg.dur > 0) || when >= tg.t0 + tg.dur) return tg.to;
  if (when <= tg.t0) return tg.from;
  return tg.from + ((tg.to - tg.from) * (when - tg.t0)) / tg.dur;
}

void DelayUnit::Line::glideTime(double t, double when, double q) {
  const double from = timeAt(when);
  time = t;
  const double dur = std::max(0.5, 20 * std::abs(t - from));
  tg = {when, dur, from, t, true};
  wa::linFrom(dTime, from - q, t - q, when, dur);
}

// ---- Delay (fx.js:1210-1335) --------------------------------------------------------------------------------------

DelayUnit::DelayUnit(double sampleRate, const DelayPatch &p, double tempo)
    : sr_(sampleRate), q_(128 / sampleRate), ret_(1.0) {
  const double qv = butterQ();
  for (Line &l : lines_) {
    l.lpFreq = wa::Param(5000.0, 0.0f, static_cast<float>(sr_ / 2));  // BiquadFilterNode.frequency: 0..nyquist
    l.pre.allocate(kPreMax, sr_, 2);
    l.d.allocate(kMaxTime, sr_, 2);
    l.dTime.setValue(0.375 - q_);
    for (auto &f : l.lp) f.set(wa::BiquadType::Lowpass, 5000.0f, qv, 0.0, sr_);
  }
  // Delay constructor: line A active
  wa::setNow(lines_[0].gate, 1, 0);
  wa::setNow(lines_[0].out, 1, 0);
  lines_[0].state = State::Active;
  // _applyFx(init) at t 0: Object.assign(p, fx.delay); applyAll(0) (+ rampTo(ret, returnGain))
  applyAll(delayEffectiveTime(p, tempo), p.feedback, p.tone, p.pingpong, 0);
  wa::rampTo(ret_, p.returnGain, 0, kTauFx);
}

const char *DelayUnit::lineState(unsigned i) const {
  switch (lines_[i].state) {
    case State::Idle:
      return "idle";
    case State::Active:
      return "active";
    case State::Ringing:
      return "ringing";
    default:
      return "flushing";
  }
}

void DelayUnit::applyAll(double time, double fb, double tone, bool pp, double when) {
  effTime_ = time;
  fb_ = std::min(0.9, std::max(0.0, fb));
  tone_ = tone;
  pp_ = pp;
  const double hz = delayToneHz(tone_);
  for (Line &l : lines_) {
    l.setPingpong(pp_, when);
    wa::rampTo(l.lpFreq, hz, when, kTauFx);
  }
  lines_[active_].setFeedback(fb_, pp_, when, kTauFx);
  updateTime(time, when);
}

void DelayUnit::setFeedback(double fb, double when, double tc) {
  fb_ = std::min(0.9, std::max(0.0, fb));
  lines_[active_].setFeedback(fb_, pp_, when, tc > 0 ? tc : kTauFx);
}

void DelayUnit::updateTime(double t, double when) {
  effTime_ = t;
  Line &a = lines_[active_];
  const double cur = a.time;
  if (std::abs(t - cur) / cur <= 0.05) {
    if (t != cur) a.glideTime(t, when, q_);
    return;
  }
  switchTo(t, when);
}

void DelayUnit::switchTo(double t, double when) {
  const unsigned oi = active_ ^ 1u;
  Line &other = lines_[oi];
  const bool ready = other.state == State::Idle && other.idleAt <= when;
  if (!ready) {
    // flush the other line (fast fade, zero feedback, wait one delay period so its buffer is empty), then retry
    if (other.state != State::Flushing) {
      other.state = State::Flushing;
      wa::rampTo(other.out, 0, when, 0.006);
      wa::rampTo(other.gate, 0, when, 0.003);
      other.setFeedback(0, pp_, when, 0.005);
      other.idleAt = when + other.time + 0.06;
    }
    addTimer(other.idleAt, TimerKind::SwitchRetry, oi, ++switchSeq_);
    return;
  }
  Line &old = lines_[active_];
  other.setTimeNow(t, when, q_);
  other.setFeedback(fb_ * fbScale_, pp_, when, 0.005);
  wa::rampTo(other.gate, 1, when, 0.005);
  wa::setNow(other.out, 1, when);
  other.state = State::Active;
  const unsigned oldI = active_;
  active_ = oi;
  // old line: close its input, let its echoes ring out with their original time, then retire it
  wa::rampTo(old.gate, 0, when, 0.005);
  const double fb = std::max(0.01, fb_);
  const double tail = std::min(8.0, old.time * std::ceil(js::log(0.001) / js::log(fb)) + 0.1);
  old.state = State::Ringing;
  old.idleAt = when + tail;
  addTimer(when + tail, TimerKind::RingEnd, oldI, ++old.seq);
}

void DelayUnit::panic(double when) {
  const double hold = std::max(0.2, std::max(lines_[0].time, lines_[1].time) + 0.05);
  for (unsigned i = 0; i < 2; ++i) {
    Line &l = lines_[i];
    const double target = i == active_ ? fb_ : 0;
    l.setFeedback(0, pp_, when, 0.005);
    if (target > 0) {
      const double straight = pp_ ? 0 : target, cross = pp_ ? target : 0;
      wa::rampTo(l.fbLL, straight, when + hold, 0.02);
      wa::rampTo(l.fbRR, straight, when + hold, 0.02);
      wa::rampTo(l.fbLR, cross, when + hold, 0.02);
      wa::rampTo(l.fbRL, cross, when + hold, 0.02);
    }
  }
}

// ---- timers (AudioTimer, offline semantics) -----------------------------------------------------------------------

void DelayUnit::addTimer(double t, TimerKind k, unsigned line, std::uint32_t seq) {
  Timer *slot = nullptr;
  // A newer switch retry supersedes the pending one (JS: the stale callback returns on its seq), so a burst of time
  // changes while the other line flushes reuses one slot instead of filling the table and evicting ring/flush timers.
  if (k == TimerKind::SwitchRetry)
    for (Timer &tm : timers_)
      if (tm.kind == TimerKind::SwitchRetry) {
        slot = &tm;
        break;
      }
  if (!slot)
    for (Timer &tm : timers_)
      if (tm.kind == TimerKind::None) {
        slot = &tm;
        break;
      }
  if (!slot) {  // full (cannot happen: at most one switch retry and two timers per line are live): drop the oldest
    slot = &timers_[0];
    for (Timer &tm : timers_)
      if (tm.order < slot->order) slot = &tm;
  }
  slot->t = t;
  slot->quantum = static_cast<std::int64_t>(std::ceil(t * sr_ / 128.0 - 1e-6));
  slot->kind = k;
  slot->line = line;
  slot->seq = seq;
  slot->order = ++timerOrder_;
}

void DelayUnit::runTimers(std::int64_t frame0) {
  const std::int64_t q = frame0 / static_cast<std::int64_t>(Q);
  const double now = static_cast<double>(frame0) / sr_;
  for (;;) {  // due timers by (quantum, submission); ones a callback adds and that are due run in the same pass
    Timer *best = nullptr;
    for (Timer &tm : timers_)
      if (tm.kind != TimerKind::None && tm.quantum <= q && (!best || tm.order < best->order)) best = &tm;
    if (!best) return;
    const Timer tm = *best;
    best->kind = TimerKind::None;
    const double tt = std::max(tm.t, now);
    Line &l = lines_[tm.line];
    switch (tm.kind) {
      case TimerKind::SwitchRetry:
        if (tm.seq != switchSeq_) break;
        l.state = State::Idle;
        switchTo(effTime_, tt);
        break;
      case TimerKind::RingEnd:
        if (l.seq != tm.seq || tm.line == active_) break;
        wa::rampTo(l.out, 0, tt, 0.01);
        l.setFeedback(0, pp_, tt, 0.01);
        l.state = State::Flushing;
        l.idleAt = tt + l.time + 0.1;
        addTimer(l.idleAt, TimerKind::FlushEnd, tm.line, tm.seq);
        break;
      case TimerKind::FlushEnd:
        if (l.seq == tm.seq && tm.line != active_) l.state = State::Idle;
        break;
      case TimerKind::None:
        break;
    }
  }
}

// ---- render -------------------------------------------------------------------------------------------------------

void DelayUnit::renderLine(Line &l, std::int64_t frame0, const float *const in[2], float *const acc[2],
                           bool first) {
  alignas(16) float g[Q], a[Q], b[Q], c[Q], dt[Q];
  alignas(16) float x[2][Q], y[2][Q];
  // gate -> pre (DelayNode, delayTime = Q constant)
  l.gate.processARate(frame0, sr_, g, Q);
  for (int ch = 0; ch < 2; ++ch)
    for (std::size_t i = 0; i < Q; ++i) x[ch][i] = in[ch][i] * g[i];
  const float qf = static_cast<float>(q_);
  for (std::size_t i = 0; i < Q; ++i) dt[i] = qf;
  {
    const float *src[2] = {x[0], x[1]};
    float *dst[2] = {y[0], y[1]};
    l.pre.process(src, dst, 2, dt);
  }
  // in-matrix -> mergeIn; + feedback matrix of the previous quantum's LPF output -> d input (into x)
  l.inLL.processARate(frame0, sr_, a, Q);
  l.inRL.processARate(frame0, sr_, b, Q);
  l.inRR.processARate(frame0, sr_, c, Q);
  for (std::size_t i = 0; i < Q; ++i) {
    x[0][i] = y[0][i] * a[i] + y[1][i] * b[i];
    x[1][i] = y[1][i] * c[i];
  }
  l.fbLL.processARate(frame0, sr_, a, Q);
  l.fbRL.processARate(frame0, sr_, b, Q);
  for (std::size_t i = 0; i < Q; ++i) x[0][i] += l.lpPrev[0][i] * a[i] + l.lpPrev[1][i] * b[i];
  l.fbRR.processARate(frame0, sr_, a, Q);
  l.fbLR.processARate(frame0, sr_, b, Q);
  for (std::size_t i = 0; i < Q; ++i) x[1][i] += l.lpPrev[1][i] * a[i] + l.lpPrev[0][i] * b[i];
  // d (stereo DelayNode, a-rate delayTime)
  l.dTime.processARate(frame0, sr_, dt, Q);
  const bool fedZero = allZero(x[0], Q) && allZero(x[1], Q);
  l.silentFrames = fedZero ? l.silentFrames + Q : 0;
  const bool lpFreqMoving = l.lpFreq.hasSampleAccurateValues(frame0, sr_);
  l.lpFreq.processARate(frame0, sr_, a, Q);
  if (l.silentFrames > l.d.length() && l.lpZero) {
    // the delay buffer holds only zeros and the LPF is at rest: output is exact zero (Chromium renders zeros here)
    l.d.advanceSilent();
    std::memset(l.lpPrev, 0, sizeof l.lpPrev);
  } else {
    {
      const float *src[2] = {x[0], x[1]};
      float *dst[2] = {y[0], y[1]};
      l.d.process(src, dst, 2, dt);
    }
    // tone LPF: per-sample coefficients while the frequency automates, else once per quantum (FinalValue)
    const double qv = butterQ();
    for (int ch = 0; ch < 2; ++ch) {
      if (lpFreqMoving) {
        for (std::size_t i = 0; i < Q; ++i) {
          l.lp[ch].set(wa::BiquadType::Lowpass, a[i], qv, 0.0, sr_);
          l.lp[ch].process(&y[ch][i], &l.lpPrev[ch][i], 1);
        }
      } else {
        l.lp[ch].set(wa::BiquadType::Lowpass, a[0], qv, 0.0, sr_);
        l.lp[ch].process(y[ch], l.lpPrev[ch], Q);
      }
    }
    l.lpZero = allZero(l.lpPrev[0], Q) && allZero(l.lpPrev[1], Q);
    if (l.lpZero && fedZero)
      for (auto &f : l.lp) f.reset();
  }
  // out gain -> ret (sum of the two lines)
  l.out.processARate(frame0, sr_, g, Q);
  for (int ch = 0; ch < 2; ++ch)
    for (std::size_t i = 0; i < Q; ++i) {
      const float v = l.lpPrev[ch][i] * g[i];
      acc[ch][i] = first ? v : acc[ch][i] + v;
    }
}

void DelayUnit::process(const RenderContext &ctx, UnitIO &io) {
  runTimers(ctx.frame0);
  const Bus *inBus = io.in;
  const float *in[2];
  if (inBus) {
    in[0] = inBus->ch[0];
    in[1] = inBus->channels == 1 ? inBus->ch[0] : inBus->ch[1];  // speakers up-mix: mono to both
  } else {
    in[0] = in[1] = zeros_;
  }
  Bus &out = *io.out;
  out.channels = 2;
  float *acc[2] = {out.ch[0], out.ch[1]};
  renderLine(lines_[0], ctx.frame0, in, acc, true);
  renderLine(lines_[1], ctx.frame0, in, acc, false);
  alignas(16) float r[Q], w[Q];
  ret_.processARate(ctx.frame0, sr_, r, Q);
  wheel_.processARate(ctx.frame0, sr_, w, Q);
  bool zero = true;
  for (int ch = 0; ch < 2; ++ch)
    for (std::size_t i = 0; i < Q; ++i) {
      const float v = out.ch[ch][i] * r[i] * w[i];
      out.ch[ch][i] = v;
      zero = zero && v == 0.0f;
    }
  quietQuanta_ = zero ? std::min(quietQuanta_ + 1, kQuietAfter) : 0;
  lastQuantumTime_ = static_cast<double>(ctx.frame0 + static_cast<std::int64_t>(Q)) / sr_;
}

void DelayUnit::apply(const Command &c) {
  const auto op = static_cast<DelayOp>(static_cast<std::uint16_t>(c.op));
  const double when = std::max(c.f.e, lastQuantumTime_);
  switch (op) {
    case DelayOp::SetTime:
      updateTime(c.f.a, when);
      break;
    case DelayOp::SetPingPong:
      applyAll(effTime_, fb_, tone_, c.aux != 0, when);
      break;
    case DelayOp::Panic:
      panic(when);
      break;
    case DelayOp::SetFeedback:
      setFeedback(c.f.a, when, c.f.b);
      break;
    case DelayOp::ApplyAll:
      applyAll(c.f.a, c.f.b, c.f.c, c.aux != 0, when);
      break;
  }
}

wa::Param *DelayUnit::param(std::uint32_t index) {
  switch (index) {
    case kDelayReturnGain:
      return &ret_;
    case kDelayWheel:
      return &wheel_;
    default:
      return nullptr;  // feedback / tone are four gains / two filters per line: DelayOp::SetFeedback / ApplyAll
  }
}

}  // namespace rig::fx

namespace rig {

Unit *makeDelay(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch) return nullptr;
  return new fx::DelayUnit(env.sampleRate, spec.patch->delay, spec.song ? spec.song->tempo : 0.0);
}

}  // namespace rig
