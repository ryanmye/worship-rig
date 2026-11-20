// "click" service (T07). See click_service.h.
#include "click/click_service.h"

#include <cmath>
#include <limits>

#include "api/engine.h"
#include "click/click.h"
#include "midi/midi_service.h"
#include "model/model.h"
#include "time/automation.h"
#include "yyjson.h"

namespace rig {
namespace {

/** A wa::Param stand-in that turns the automation helpers' calls into Param* commands for one unit param. */
struct CommandParam {
  Model &m;
  std::uint32_t target;
  bool send(Op op, double a, double b, double c) {
    Command cmd{};
    cmd.op = op;
    cmd.frame = kFrameNow;
    cmd.target = target;
    cmd.f.a = a;
    cmd.f.b = b;
    cmd.f.c = c;
    return m.sink().send(cmd);
  }
  bool setValueAtTime(double v, double t) { return send(Op::ParamSet, v, t, 0); }
  bool linearRampToValueAtTime(double v, double t) { return send(Op::ParamLinear, v, t, 0); }
  bool exponentialRampToValueAtTime(double v, double t) { return send(Op::ParamExp, v, t, 0); }
  bool setTargetAtTime(double v, double t, double tau) { return send(Op::ParamTarget, v, t, tau); }
  bool cancelAndHoldAtTime(double t) { return send(Op::ParamCancelHold, 0, t, 0); }
  bool cancelScheduledValues(double) { return false; }  // not used by rampTo
  double intrinsic() const { return std::numeric_limits<double>::quiet_NaN(); }
};

const char *sigOf(const SongState &s) {
  if (s.sigDen == 8) return s.sigNum == 12 ? "12/8" : "6/8";
  switch (s.sigNum) {
    case 3:
      return "3/4";
    case 2:
      return "2/4";
    case 5:
      return "5/4";
    default:
      return "4/4";
  }
}

}  // namespace

ClickServiceImpl::ClickServiceImpl(Model &m) : m_(m), met_(*this) {}

// ---- Metronome::Host ------------------------------------------------------------------------------------------------

double ClickServiceImpl::now() {
  return m_.now();
}

void ClickServiceImpl::at(double t, std::function<void(double)> fn) {
  m_.sink().at(t, std::move(fn));
}

void ClickServiceImpl::scheduleTick(double t, click::TickKind kind) {
  if (tickObs_) tickObs_(t, kind);
  Command c{};
  c.op = opOf(ClickOp::Schedule);
  c.aux = static_cast<std::uint32_t>(kind);
  c.f.a = t;
  m_.sendUnitOp(UnitSlot::Click, c, -1.0);
}

void ClickServiceImpl::clearAfter(double t) {
  if (clearObs_) clearObs_(t);
  Command c{};
  c.op = opOf(ClickOp::ClearAfter);
  c.f.a = t;
  m_.sendUnitOp(UnitSlot::Click, c, -1.0);
}

void ClickServiceImpl::rampLevel(double level, double when) {
  CommandParam p{m_, paramTarget(UnitSlot::Click, kClickLevel)};
  wa::rampTo(p, level, when, click::kLevelTau);
}

void ClickServiceImpl::route(bool aux, bool record) {
  Command c{};
  c.op = Op::ClickRoute;
  c.frame = kFrameNow;
  c.aux = (aux ? 1u : 0u) | (record ? 2u : 0u);
  m_.sink().send(c);
}

unsigned ClickServiceImpl::outputChannels() {
  if (const auto *e = dynamic_cast<const Engine *>(&m_.sink())) return e->outChannels();  // the device's, now
  const rig_config *c = m_.env().config;
  return c && c->output_channels >= 4 ? 4u : 2u;
}

void ClickServiceImpl::emitState(const std::string &stateJson) {
  m_.emit("{\"v\":1,\"ev\":\"click\"," + stateJson.substr(1));
}

void ClickServiceImpl::warn(std::string_view message) {
  m_.warn(message, "unsupported");
}

bool ClickServiceImpl::hasClockSink() {
  return static_cast<bool>(clockObs_) || hasClockPort_;
}

std::string ClickServiceImpl::clockTarget() const {
  if (!hasClockPort_) return {};
  auto *ms = dynamic_cast<midi::MidiServiceImpl *>(m_.service(MidiService::kName));
  if (!ms || ms->table().ports().empty()) return clockPort_ == "auto" ? std::string() : clockPort_;
  const midi::PortTable &t = ms->table();
  if (clockPort_ == "auto") {
    const midi::Port *p = t.firstOutput();
    return p ? p->id : std::string();
  }
  if (const midi::Port *p = t.byId(clockPort_); p && p->present && p->connected && !p->input) return p->id;
  if (const midi::Port *p = t.byName(clockPort_, false)) return p->id;  // midi-clock.js chooses by name
  return {};
}

void ClickServiceImpl::sendClock(const click::ClockMsg *msgs, std::size_t n) {
  if (clockObs_) clockObs_(msgs, n);
  if (!hasClockPort_) return;
  const rig_host *h = midi::hostOf(m_);
  if (!h || !h->midi_send) return;
  const std::string port = clockTarget();
  if (port.empty()) return;  // midi-clock.js: no port, nothing sent
  for (std::size_t i = 0; i < n; ++i) {
    const std::uint8_t b = msgs[i].status;
    h->midi_send(h->user, port.c_str(), &b, 1, midi::hostTimeFor(m_, msgs[i].t));
  }
}

// ---- contract methods ---------------------------------------------------------------------------------------------

bool ClickServiceImpl::attached() const {
  return m_.attachedKind(UnitSlot::Click) == kKindClick;
}

double ClickServiceImpl::engineT(double when) {
  const double n = m_.now();
  return std::isfinite(when) && when > n ? when : n;
}

void ClickServiceImpl::syncAttach() {
  if (seenAttach_ || !attached()) return;
  seenAttach_ = true;
  met_.setTempo(m_.song().tempo);
  met_.setSig(sigOf(m_.song()));
  lastTempo_ = m_.song().tempo;
  lastSigNum_ = m_.song().sigNum;
  lastSigDen_ = m_.song().sigDen;
  met_.configure(cfgHasLevel_ ? cfgLevel_ : std::numeric_limits<double>::quiet_NaN(),
                 cfgHasRecord_ ? &cfgRecord_ : nullptr, cfgOutput_.c_str(), cfgHasOutput_, 0);
}

std::string ClickServiceImpl::start(int countIn, bool quietAfter, double when) {
  syncAttach();
  if (!attached()) {
    m_.warn("clickStart() before start(); ignored.", "not-started");
    return "null";
  }
  const SongState &s = m_.song();
  return met_.start(s.tempo, sigOf(s), countIn, quietAfter, engineT(when));
}

bool ClickServiceImpl::stop(double when) {
  syncAttach();
  return attached() && met_.stop(engineT(when));
}

std::string ClickServiceImpl::configure(const yyjson_val *ccfg, double when) {
  yyjson_val *cfg = const_cast<yyjson_val *>(ccfg);
  double level = std::numeric_limits<double>::quiet_NaN();
  bool rec = false, hasRec = false, hasOut = false;
  std::string out;
  if (yyjson_val *v = yyjson_obj_get(cfg, "level")) {
    if (yyjson_is_num(v)) level = yyjson_get_num(v);
    cfgHasLevel_ = true;
    cfgLevel_ = level;
  }
  if (yyjson_val *v = yyjson_obj_get(cfg, "record"); v && yyjson_is_bool(v)) {
    rec = yyjson_get_bool(v);
    hasRec = true;
    cfgHasRecord_ = true;
    cfgRecord_ = rec;
  }
  if (yyjson_val *v = yyjson_obj_get(cfg, "output")) {
    hasOut = true;
    out = yyjson_is_str(v) ? yyjson_get_str(v) : "";
    cfgHasOutput_ = true;
    cfgOutput_ = out;
  }
  syncAttach();
  if (!attached()) return "null";  // stored; applied when the click unit exists (audio.js start())
  return met_.configure(level, hasRec ? &rec : nullptr, out.c_str(), hasOut, engineT(when));
}

std::string ClickServiceImpl::stateJson() {
  syncAttach();
  return attached() ? met_.stateJson() : "null";
}

void ClickServiceImpl::setClockPort(const char *portId) {
  hasClockPort_ = portId && *portId;
  clockPort_ = hasClockPort_ ? portId : "";
}

void ClickServiceImpl::onSongState(const SongState &s) {
  syncAttach();
  if (s.tempo != lastTempo_) {  // audio.js setTempo -> retime({bpm}); no tempo stops a running click
    lastTempo_ = s.tempo;
    met_.retime(s.tempo, !(s.tempo > 0), {}, false);
  }
  if (s.sigNum != lastSigNum_ || s.sigDen != lastSigDen_) {  // setTimeSig -> retime({sig}) (newBar: see report)
    lastSigNum_ = s.sigNum;
    lastSigDen_ = s.sigDen;
    met_.retime(0, false, sigOf(s), false);
  }
}

void ClickServiceImpl::onAudioEvent(const AudioEvent &e) {
  if (e.kind != EventKind::RateChanged || !attached()) return;
  // The click tables are built at the unit's rate: rebuild the unit, restore its level, re-pump from now (the
  // clicks the old unit had scheduled go back with it).
  if (!m_.attachUnit(UnitSlot::Click, kKindClick, -1.0)) return;
  m_.setParamAt(UnitSlot::Click, kClickLevel, met_.level(), -1.0);
  if (met_.running()) met_.resetHorizon(m_.now());
}

std::string ClickServiceImpl::statsFields() {
  return std::string("\"click\":") + (attached() ? met_.statsJson() : std::string("null"));
}

}  // namespace rig
