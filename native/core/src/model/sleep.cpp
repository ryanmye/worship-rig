// Audio sleep / wake queueing (lowres2; T14 W3A): model/sleep.h. JS reference: app/js/engine/audio.js sleepState,
// sleepBlockers, sleep, wake, _rampLead, _outGainAt, _outRamp, _sleepHold (1478-1640). Also the Model's 1.1 members
// sleep / wake / sleepState / sleepBlockersJson (moved here from the T13 skeleton in model.cpp).
#include "model/sleep.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>

#include "bridge/json_out.h"
#include "click/click_service.h"
#include "drone/drone_core.h"
#include "drone/drone_service.h"
#include "mix/master_chain.h"
#include "model/graph_build.h"
#include "model/model.h"
#include "model/perform_internal.h"
#include "model/song.h"
#include "num/js_math.h"
#include "num/js_number.h"
#include "rig/rig_engine.h"
#include "time/automation.h"

namespace rig {

Sleep::Sleep(Model &m, Perform &p) : m_(m), p_(p) {}

bool Sleep::offline() const {
  const rig_config *cfg = m_.env().config;
  return !testRealtime_ && (!cfg || cfg->mode == RIG_MODE_OFFLINE);
}

double Sleep::lead() const {
  return std::min(0.04, std::max(0.01, 2 * m_.sink().outputLatency()));
}

double Sleep::outGainAt(double t) const {
  const Ramp &r = ramp_;
  if (!r.any) return 1;
  if (t <= r.t) return r.from;
  if (t >= r.t + r.dur) return r.to;
  return r.from + ((r.to - r.from) * (t - r.t)) / r.dur;
}

void Sleep::outRamp(double from, double to, double t, double dur) {
  // fx.js linFrom(fx.out.gain, from, to, t, dur) on the master chain's `out` (absent: nothing renders anyway)
  if (!m_.attachedKind(UnitSlot::MasterChain).empty()) {
    Perform::ParamOut out(p_, UnitSlot::MasterChain, kMasterOut);
    wa::linFrom(out, from, to, t, dur);
  }
  ramp_ = Ramp{t, dur, from, to, true};
}

const char *Sleep::state() const {
  switch (state_) {
    case State::Sleeping:
      return "sleeping";
    case State::Asleep:
      return "asleep";
    case State::Waking:
      return "waking";
    default:
      return "awake";
  }
}

bool Sleep::sleep(double ramp) {
  if (offline() || state_ != State::Awake) return false;
  const double r = std::isfinite(ramp) && ramp >= 0 ? ramp : kSleepRamp;
  const std::uint32_t seq = ++seq_;
  const double t = m_.now() + lead();
  outRamp(outGainAt(t), 0, t, r);
  state_ = State::Sleeping;
  m_.sink().sleepChanged(true, -1, -1);  // `sleep {state:'sleeping'}` (the engine's state event)
  m_.sink().at(t + r + 0.005, [this, seq](double) {
    if (seq != seq_ || state_ != State::Sleeping) return;  // a wake came first
    state_ = State::Asleep;
    ++sleeps_;
    m_.sink().sleepChanged(false, -1, -1);  // ctx.suspend(): the engine stops rendering, time pauses
  });
  return true;
}

bool Sleep::wake(double ramp) {
  if (state_ == State::Awake || state_ == State::Waking) return false;  // idempotent (JS: the shared promise)
  const auto p0 = std::chrono::steady_clock::now();
  ++seq_;
  state_ = State::Waking;
  // ctx.resume() is immediate natively. Ahead of the render position, so the ramp never starts in the past.
  const double now = m_.now(), t = now + lead();
  std::vector<SleepCall> q;
  q.swap(queue_);
  const bool notes = std::any_of(q.begin(), q.end(), [](const SleepCall &c) { return c.kind == SleepCall::NoteOn; });
  const double dur = std::isfinite(ramp) && ramp >= 0 ? ramp : notes ? kWakeNoteRamp : kWakeRamp;
  outRamp(outGainAt(t), 1, t, dur);
  state_ = State::Awake;
  ++wakes_;
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - p0).count();
  last_ = Last{true, js::round(ms * 10) / 10, dur, t, js::round((t - now) * 10000) / 10, q.size()};
  for (const SleepCall &c : q) replay(c, t);  // in order, at the ramp's start
  m_.sink().sleepChanged(true, last_.ms, static_cast<int>(q.size()));
  return true;
}

void Sleep::replay(const SleepCall &c, double t) {
  switch (c.kind) {
    case SleepCall::NoteOn:
      p_.noteOnTouch(c.note, c.vel, t, c.hasTouch ? &c.touch : nullptr);
      break;
    case SleepCall::NoteOff:
      p_.noteOff(c.note, t);
      break;
    case SleepCall::Sustain:
      p_.sustain(c.down, t);
      break;
  }
}

bool Sleep::hold(const SleepCall &c) {
  if (state_ == State::Awake || offline()) return false;
  queue_.push_back(c);
  wake(NAN);
  return true;
}

std::string Sleep::blockersJson() const {
  // JS: !ctx || offline || !fx. W3A review: a realtime engine before `audio start` has no master chain (no fx) yet
  if (offline() || m_.attachedKind(UnitSlot::MasterChain).empty()) return "[\"no-audio\"]";
  JsonOut j;
  j.beginArray();
  // 'voices': held / sounding and pedaled notes, the live voices of every slot and retiring channel, a mono line
  std::size_t v = p_.sounding_.size() + p_.pedaled_.size();
  const SongGraph &sg = m_.songGraph();
  for (int i = 0; i < kMaxSlots; ++i)
    if (const Channel *c = sg.liveChannel(i); c && c->shell) v += c->shell->publishedVoices();
  for (std::size_t k = 0; k < kRetiring; ++k)
    if (const Channel &c = sg.retiring(static_cast<int>(k)); c.live && c.shell) v += c.shell->publishedVoices();
  for (const auto &kv : p_.mono_) v += kv.second.cur ? 1 : 0;
  if (v > 0) j.elemStr("voices");
  if (auto *cs = dynamic_cast<ClickServiceImpl *>(m_.service<ClickService>()); cs && cs->metronome().running())
    j.elemStr("click");
  if (p_.pedal_) j.elemStr("pedal");  // lowres2-critic #4: a held pedal is input in progress
  if (auto *ds = dynamic_cast<drone::DroneServiceImpl *>(m_.service<DroneService>()))
    if (const drone::DroneCore *d = ds->core()) {
      // sounding (unless a frozen loop at drone.gain 0 with no layer), or still ringing out. Native has no
      // control-thread view of the drone voices: layers that outlive `sounding` and busy pad players stand in.
      const bool quietFrozen = d->frozen() && !(d->getParam("gain") > 0) && d->layerCount() == 0;
      const bool sounding = d->sounding() && d->mode() != "off" && !quietFrozen;
      const bool ringing = (!d->sounding() && d->layerCount() > 0) || d->activeEls() > 0;
      if (sounding || ringing) j.elemStr("drone");
    }
  j.endArray();
  return j.take();
}

void Sleep::statsFields(std::string &out) const {
  out += ",\"audioSleep\":\"" + std::string(state()) + "\",\"lastWake\":";
  if (!last_.any) {
    out += "null";
    return;
  }
  JsonOut j;
  auto n = [](double v) { return js::numberToString(v); };  // JS number formatting (0.06, not 0.0599..)
  j.begin().kvRaw("ms", n(last_.ms)).kv("queued", static_cast<std::uint32_t>(last_.queued));
  j.kvRaw("ramp", n(last_.ramp)).kvRaw("at", n(last_.at)).kvRaw("leadMs", n(last_.leadMs)).end();
  out += j.take();
}

// ---- Model contract 1.1 members ------------------------------------------------------------------------------------

bool Model::sleep(double ramp) {
  return perf_->sleeper().sleep(ramp);
}
bool Model::wake(double ramp) {
  return perf_->sleeper().wake(ramp);
}
const char *Model::sleepState() const {
  return perf_->sleeper().state();
}
std::string Model::sleepBlockersJson() const {
  return perf_->sleeper().blockersJson();
}

}  // namespace rig
