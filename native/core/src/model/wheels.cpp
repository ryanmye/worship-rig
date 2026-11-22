// Wheels, swell, bend (T14; contract 2.6): audio.js setWheel / _setWheel / _glideWheel (pickup, virtual glide in
// 25 ms steps), swell (50 ms steps, 60 ms dip), the FX / drone / master half of _applyWheels with macro.wash,
// pitchBend / _applyBend (pitch, morph, drone-swell, tape) and the tape stop of _tape / _tapeAt / _tapeSeg, plus the
// routing / commit hooks (_neutralBend, _syncPedalSwell). JS reference: app/js/engine/audio.js 1774-2115.
#include <algorithm>
#include <cmath>
#include <optional>
#include <string>

#include "bridge/json_out.h"
#include "fx/delay.h"
#include "fx/lofi.h"
#include "fx/lofi_unit.h"
#include "fx/reverb.h"
#include "fx/reverb_service.h"
#include "mix/master_chain.h"
#include "model/model.h"
#include "model/perform.h"
#include "model/perform_internal.h"
#include "model/song.h"
#include "num/js_math.h"
#include "num/js_number.h"
#include "rig/rig_engine.h"
#include "time/automation.h"

namespace rig {

using perf::clamp01;
using perf::lerp;

namespace {
constexpr double kWheelGlideStep = 0.025;  // audio.js WHEEL_GLIDE_STEP

/** shared/touch-curve.js pedalCurve (LOG_DECADES 2). */
double pedalCurve(double x, bool log) {
  if (!log) return x;
  const double c = x > 1 ? 1 : x > 0 ? x : 0;
  return (js::pow(10.0, 2.0 * c) - 1) / (js::pow(10.0, 2.0) - 1);
}

/** audio.js _macro(name, R) over the given routing and the current wheel values. */
std::optional<double> macroOf(const Routing &R, const WheelValues &w, std::string_view name) {
  std::optional<double> x;
  if (R.mod.target == name) x = lerp(R.mod.min, R.mod.max, w.mod);
  if (R.expr.target == name) x = x.value_or(1) * lerp(R.expr.min, R.expr.max, pedalCurve(w.expr, R.expr.logCurve));
  if (R.volTarget == name) x = x.value_or(1) * w.vol;
  return x;
}

bool attached(const Model &m, UnitSlot u, const char *kind) {
  return m.attachedKind(u) == kind;
}

bool sameFb(double a, double b) {
  return (std::isnan(a) && std::isnan(b)) || a == b;
}
}  // namespace

// ---- wheels ------------------------------------------------------------------------------------------------------

bool Perform::setWheel(std::string_view source, double value, double when, double glide) {
  noteInput(when);
  if (source == "virtual" && glide > 0) {
    glideWheel(value, tOf(when), glide);
    return true;
  }
  return setWheelAt(source, value, tOf(when), false);
}

void Perform::glideWheel(double to, double t, double dur) {
  // v11-scenes: the virtual wheel walks to `to` in 25 ms steps on the audio clock; a wheel write, a hardware takeover
  // or a swell ends it
  glide_ = WheelGlide{m_.songGraph().wheel().mod, clamp01(to), t, dur};
  swellActive_ = 0;
  glideActive_ = ++glideSeq_;
  glideStep(glideActive_, t);
}

void Perform::glideStep(std::uint32_t seq, double tt) {
  if (glideActive_ != seq) return;
  const double x = std::min(1.0, (tt - glide_.t0) / glide_.dur);
  setWheelAt("virtual", lerp(glide_.from, glide_.to, x), tt, true);
  if (x >= 1) glideActive_ = 0;
  else m_.sink().at(tt + kWheelGlideStep, [this, seq](double t2) { glideStep(seq, t2); });
}

bool Perform::setWheelAt(std::string_view source, double value01, double t, bool fromSwell) {
  const double v = clamp01(value01);
  WheelValues &w = m_.songGraph().wheel();
  if (source == "virtual") {
    if (!fromSwell) {
      swellActive_ = 0;
      glideActive_ = 0;
    }
    w.mod = v;
    modVirtual_ = true;
    pickup_ = true;
    pickupHasLast_ = false;
  } else if (source == "mod") {
    if (modVirtual_) {  // pickup: hardware takes over only once it reaches / crosses the virtual value
      const double cur = w.mod;
      const bool crossed = std::fabs(v - cur) <= 0.03 || (pickupHasLast_ && (pickupLast_ - cur) * (v - cur) <= 0);
      pickupLast_ = v;
      pickupHasLast_ = true;
      if (!crossed) {
        JsonOut j;
        j.begin().kv("v", 1).kv("ev", "wheel").kv("source", "mod").kvRaw("value", js::numberToString(cur));
        j.kvRaw("hardware", js::numberToString(v));
        j.kvBool("pickup", true).end();
        m_.emit(j.take());
        return false;
      }
      modVirtual_ = false;
      swellActive_ = 0;
      glideActive_ = 0;
    }
    w.mod = v;
  } else if (source == "expr") {
    w.expr = v;
  } else if (source == "vol") {
    w.vol = v;
  } else {
    return false;
  }
  m_.songGraph().coalesce("wheels", t, [this](double tt) { applyWheels(tt, wa::kDefaultTc); });
  emitWheel(source, source == "virtual" ? v : source == "expr" ? w.expr : source == "vol" ? w.vol : w.mod);
  return true;
}

void Perform::emitWheel(std::string_view source, double value) {
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "wheel").kv("source", source).kvRaw("value", js::numberToString(value)).end();
  m_.emit(j.take());
}

std::string Perform::wheelValuesJson() const {
  const WheelValues &w = const_cast<Model &>(m_).songGraph().wheel();
  JsonOut j;
  j.begin().kvRaw("mod", js::numberToString(w.mod)).kvRaw("expr", js::numberToString(w.expr));
  j.kvRaw("vol", js::numberToString(w.vol)).kv("owner", modVirtual_ ? "virtual" : "hw");
  j.kvBool("swelling", swellActive_ != 0).end();
  return j.take();
}

// ---- swell (audio.js swell) --------------------------------------------------------------------------------------

bool Perform::swell(int start, double when) {
  noteInput(when);
  const double t = tOf(when);
  const bool up = start < 0 ? !(swellActive_ && swell_.up) : start != 0;
  const std::uint32_t seq = ++swellSeq_;
  glideActive_ = 0;  // v11-scenes: the swell takes the wheel from a scene glide
  const WheelValues &w = m_.songGraph().wheel();
  if (up) {
    const double pre = swellActive_ ? swell_.pre : w.mod;
    swell_ = Swell{true, pre, 0, 1, t, m_.songGraph().routing().swellSeconds};
    swellActive_ = seq;
    setWheelAt("virtual", w.mod, t, true);  // take ownership (pickup for hardware)
  } else {
    if (!swellActive_) return false;
    const double pre = swell_.pre;
    swell_ = Swell{false, pre, w.mod, pre, t, 4};
    swellActive_ = seq;
  }
  swellStep(seq, t, t);
  return true;
}

void Perform::swellStep(std::uint32_t seq, double tt, double tStart) {
  if (swellActive_ != seq) return;
  const Swell sw = swell_;
  const double x = std::min(1.0, (tt - sw.t0) / sw.dur);
  // an up-swell starts with a 60 ms dip to 0 so the pad builds from silence without a click
  double v;
  if (sw.up) v = tt - sw.t0 < 0.06 && sw.t0 == tStart ? lerp(sw.pre, 0, (tt - sw.t0) / 0.06) : lerp(sw.from, sw.to, x);
  else v = lerp(sw.from, sw.to, x);
  setWheelAt("virtual", v, tt, true);
  if (x >= 1) {
    if (!sw.up) swellActive_ = 0;
    return;
  }
  m_.sink().at(tt + 0.05, [this, seq, tStart](double t2) { swellStep(seq, t2, tStart); });
}

// ---- _applyWheels ------------------------------------------------------------------------------------------------

void Perform::applyWheels(double t, double tc) {
  m_.songGraph().applyWheels(t, tc);  // T13: the strips' wheel gains and the morph of the live channels
  applyFxWheels(t, tc);
}

void Perform::applyFxWheels(double t, double tc) {
  const SongGraph &sg = m_.songGraph();
  const std::optional<double> I = sg.macro("macro.intensity"), W = sg.macro("macro.wash");
  if (auto *d = dynamic_cast<PerformDrone *>(m_.service("drone"))) d->droneWheel(sg.factorFor("drone.gain"), t, tc);
  double rv = sg.factorFor("fx.reverb.returnGain");
  if (I) rv *= lerp(0.8, 1.15, *I);
  if (W) rv *= lerp(1, 1.6, *W);
  if (attached(m_, UnitSlot::Reverb, kKindReverb)) {
    ParamOut p(*this, UnitSlot::Reverb, kReverbWheel);
    wa::rampTo(p, rv, t, tc);
  }
  if (!m_.attachedKind(UnitSlot::MasterChain).empty()) {
    ParamOut p(*this, UnitSlot::MasterChain, kMasterWheel);
    wa::rampTo(p, sg.factorFor("master.volume"), t, tc);
  }
  // wash: delay feedback (tau 50 ms, only when the override changes) + reverb size (a new IR bucket only)
  const PatchSpec &P = m_.patch();
  const double fb = W ? lerp(P.delay.feedback, 0.75, *W) : NAN;
  if (!sameFb(fb, washFb_)) {
    washFb_ = fb;
    if (attached(m_, UnitSlot::Delay, kKindDelay)) {
      Command c{};
      c.op = opOf(DelayOp::SetFeedback);  // Delay.effectiveFb(): washFb ?? p.feedback, clamped 0..0.9
      c.f.a = std::min(0.9, std::max(0.0, std::isnan(fb) ? P.delay.feedback : fb));
      c.f.b = 0.05;
      c.f.e = t;
      c.frame = frameOf(t);
      c.target = static_cast<std::uint32_t>(UnitSlot::Delay);
      send(c);
    }
  }
  if (attached(m_, UnitSlot::Reverb, kKindReverb))
    if (auto *rp = dynamic_cast<fx::ReverbPool *>(m_.service<ReverbService>())) {
      const double eff = W ? lerp(P.reverb.size, 0.9, *W) : P.reverb.size;
      if (rp->irKeyFor(eff, P.reverb.damp) != rp->targetKey()) rp->request(eff, P.reverb.damp, t);
    }
}

double Perform::stageReverbSize(const Routing &r, double size) const {
  const std::optional<double> W = macroOf(r, const_cast<Model &>(m_).songGraph().wheel(), "macro.wash");
  return W ? lerp(size, 0.9, *W) : size;  // audio.js _stageReverbSize
}

// ---- routing / commit hooks --------------------------------------------------------------------------------------

void Perform::syncPedalSwell(double t) {
  // v11-touch "hold pedal = sustain + drone swell" (routing swell.pedal)
  const bool want = pedal_ && m_.songGraph().routing().swellPedal;
  auto *d = dynamic_cast<PerformDrone *>(m_.service("drone"));
  if (want == pedalSwell_ || !d) return;
  pedalSwell_ = want;
  d->dronePedalSwell(want, t);
}

void Perform::afterRouting(const yyjson_val *, const std::string &oldBendMode, double when) {
  const double t = tOf(when);
  if (oldBendMode != m_.songGraph().routing().bendMode) neutralBend(oldBendMode, t);
  applyFxWheels(t, 0.03);  // SongGraph::setRouting ramped the strips (tau 30 ms)
  syncPedalSwell(t);
}

void Perform::afterCommit(const std::string &oldBendMode, double when) {
  const double t = tOf(when);
  if (oldBendMode != m_.songGraph().routing().bendMode) neutralBend(oldBendMode, t);
  applyFxWheels(t, 0.03);  // SongGraph::commit ramped the strips (tau 30 ms)
  if (auto *d = dynamic_cast<PerformDrone *>(m_.service("drone"))) d->droneSongChanged(t);
  syncPedalSwell(t);
}

void Perform::bendEnabled(int slot, double when) {
  // audio.js _setSlotParam: bendEnabled true in pitch mode -> inst.setBend(bend * range, t)
  const Routing &R = m_.songGraph().routing();
  const Channel *c = m_.songGraph().liveChannel(slot);
  if (R.bendMode != "pitch" || !c || !c->hasInst) return;
  Command b{};
  b.op = Op::Bend;
  b.f.a = bend_ * R.bendRange;
  b.frame = frameOf(tOf(when));
  b.target = static_cast<std::uint32_t>(instSlot(static_cast<std::size_t>(slot)));
  send(b);
}

void Perform::onRateChanged() {
  // T05 R6: the lofi unit is rebuilt for the new rate without the tape hold (its state starts from the patch)
  if (tapeHeld_) fx::lofiHold(m_, true, -1);
}

// ---- bend --------------------------------------------------------------------------------------------------------

void Perform::pitchBend(double x, double when) {
  noteInput(when);
  const double t = tOf(when);
  bend_ = std::isfinite(x) ? std::max(-1.0, std::min(1.0, x)) : 0.0;
  m_.songGraph().coalesce("bend", t, [this](double tt) { applyBend(tt, m_.songGraph().routing().bendMode); });
}

void Perform::neutralBend(const std::string &oldMode, double t) {
  const double b = bend_;  // audio.js _neutralBend: leave the old mode neutral
  bend_ = 0;
  applyBend(t, oldMode);
  bend_ = b;
}

void Perform::applyBend(double t, const std::string &mode) {
  const SongGraph &sg = m_.songGraph();
  if (mode == "pitch") {
    const double semis = bend_ * sg.routing().bendRange;
    auto bendTo = [&](UnitSlot u) {
      Command c{};
      c.op = Op::Bend;
      c.f.a = semis;
      c.frame = frameOf(t);
      c.target = static_cast<std::uint32_t>(u);
      send(c);
    };
    for (int i = 0; i < kMaxSlots; ++i) {  // slots, then the retiring channels (each with its own cfg)
      const Channel *c = sg.liveChannel(i);
      if (c && c->hasInst && m_.patch().slots[i].bendEnabled) bendTo(instSlot(static_cast<std::size_t>(i)));
    }
    for (std::size_t j = 0; j < kRetiring; ++j) {
      const Channel &c = sg.retiring(static_cast<int>(j));
      if (c.live && c.hasInst && c.cfg.bendEnabled) bendTo(retireInstSlot(j));
    }
  } else if (mode == "morph") {
    m_.songGraph().applyWheels(t, wa::kDefaultTc);  // _applyMorph (strip wheel factors are unchanged: no-op)
  } else if (mode == "drone-swell") {
    if (auto *d = dynamic_cast<PerformDrone *>(m_.service("drone"))) d->droneBendSwell(bend_, t);
  } else if (mode == "tape") {
    tape(bend_, t);
  }
}

void Perform::tape(double x, double t) {
  if (!attached(m_, UnitSlot::Lofi, kKindLofi)) {
    warnOnce("Tape bend needs the lofi chain (disabled in this engine).");
    return;
  }
  // realtime: slightly ahead so the ramp's anchor is never in the audio thread's past (baseLatency + 10 ms, <= 50 ms)
  const rig_config *cfg = m_.env().config;
  if (cfg && cfg->mode != RIG_MODE_OFFLINE) t = std::max(t, m_.now() + 0.02);
  if (x == tapeX_) return;
  tapeX_ = x;
  // bend events never land before an earlier one: the delay-time timeline stays monotonic
  if (!tapeSegs_.empty() && t < tapeSegs_.back().t0) t = tapeSegs_.back().t0;
  const std::uint32_t seq = ++tapeSeq_;
  ParamOut delayTime(*this, UnitSlot::Lofi, fx::kLofiTapeTime), lpfHz(*this, UnitSlot::Lofi, kLofiLpfHz),
      lpfQ(*this, UnitSlot::Lofi, fx::kLofiLpfQ);
  if (x < 0) {
    // tape stop: a delay line whose delay time grows makes the pitch fall by (1 - slope); the LPF closes with depth
    fx::lofiHold(m_, true, t);
    tapeHeld_ = true;
    fx::lofiSetTapeActive(m_, true);
    const double depth = -x, slope = 0.5 * depth, cur = tapeAt(t);
    const double dur = std::max(0.1, (0.95 - cur) / std::max(0.01, slope));
    wa::linFrom(delayTime, cur, 0.95, t, dur);  // linear growth of the delay time = constant pitch drop
    tapeSeg(t, dur, cur, 0.95);
    wa::rampTo(lpfHz, 18000 * js::pow(0.08, depth), t, 0.15);
    wa::rampTo(lpfQ, 0.707, t, 0.05);
  } else if (x > 0) {
    // push up: resonant low-pass sweep down; the delay time holds where it is (no pitch jump)
    fx::lofiHold(m_, true, t);
    tapeHeld_ = true;
    fx::lofiSetTapeActive(m_, true);
    const double cur = tapeAt(t);
    wa::linFrom(delayTime, cur, cur, t, 0.01);
    tapeSeg(t, 0, cur, cur);
    wa::rampTo(lpfHz, 18000 * js::pow(0.04, x), t, 0.05);
    wa::rampTo(lpfQ, 0.707 + 5 * x, t, 0.05);
  } else {
    // recover over 1 s, then drop the hold (lofi bypass again if amount is 0)
    const double cur = tapeAt(t);
    wa::linFrom(delayTime, cur, 0.005, t, 1);
    tapeSeg(t, 1, cur, 0.005);
    wa::rampTo(lpfQ, 0.707, t, 0.2);
    fx::lofiSetTapeActive(m_, false);
    fx::lofiApply(m_, t);
    m_.sink().at(t + 1.05, [this, seq](double tt) {
      if (seq != tapeSeq_) return;
      fx::lofiHold(m_, false, tt);
      tapeHeld_ = false;
    });
  }
}

double Perform::tapeAt(double t) const {
  // the tape delay time at t, on the scheduled segments exactly as the param timeline will (5 ms idle)
  const TapeSeg *g = nullptr;
  for (const TapeSeg &x : tapeSegs_)
    if (x.t0 <= t) g = &x;
  if (!g) return tapeSegs_.empty() ? 0.005 : tapeSegs_.front().from;
  if (!(g->dur > 0) || t >= g->t0 + g->dur) return g->to;
  return g->from + ((g->to - g->from) * (t - g->t0)) / g->dur;
}

void Perform::tapeSeg(double t0, double dur, double from, double to) {
  // a new segment from t0 (cancel-and-hold semantics: later segments are dropped); the last 8 are kept
  tapeSegs_.erase(std::remove_if(tapeSegs_.begin(), tapeSegs_.end(), [t0](const TapeSeg &x) { return !(x.t0 < t0); }),
                  tapeSegs_.end());
  tapeSegs_.push_back({t0, dur, from, to});
  if (tapeSegs_.size() > 8) tapeSegs_.erase(tapeSegs_.begin(), tapeSegs_.end() - 8);
}

double performBendMorph(const Model &m) {
  return m.songGraph().routing().bendMode == "morph" ? std::fabs(m.perform().bend()) : 0.0;
}

}  // namespace rig
