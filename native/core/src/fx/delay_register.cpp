// rig_register_fx_delay: kind "delay" (fx/delay.h), the "delay" service (tempo -> sync time, commit -> applyAll,
// rate change -> rebuild) and the set handler for fx.delay.{time,sync,feedback,pingpong,tone,returnGain}
// (contract 2.3; audio.js setParam 'delay', setTempo, _applyFx).
#include "api/registry.h"
#include "fx/delay_unit.h"
#include "model/model.h"
#include "model/patch.h"
#include "model/perform.h"  // INTERFACE-CHANGE(W3A) T14 review F1: Perform::delayFeedback() (Delay.effectiveFb)
#include "params/params.h"

namespace rig::fx {
namespace {

bool attached(const Model &m) {
  return m.attachedKind(UnitSlot::Delay) == kKindDelay && m.attachedIsModule(UnitSlot::Delay);
}

void sendOp(Model &m, DelayOp op, double when, double a = 0, double b = 0, double c = 0, std::uint32_t aux = 0) {
  Command cmd{};
  cmd.op = opOf(op);
  cmd.aux = aux;
  cmd.f.a = a;
  cmd.f.b = b;
  cmd.f.c = c;
  cmd.f.e = m.timeFor(when);
  // W3B (fx-row-sweep): fx.js runs Delay.updateTime / _switchTo / setFeedback at CALL time with `when` for the
  // automation, so a later call already sees the line switch an earlier call made (and its timers read the latest
  // p.feedback). The unit gets the op now and schedules at f.e (DelayUnit::apply), as the lofi state.
  m.sendUnitOp(UnitSlot::Delay, cmd, -1.0);
}

/** Delay.applyAll(when) + rampTo(ret, returnGain) (JS: applyAll includes the return gain). */
void applyAll(Model &m, double when) {
  const DelayPatch &p = m.patch().delay;
  // INTERFACE-CHANGE(W3A) T14 review F1: fx.js applyAll sends effectiveFb() = clamp(washFb ?? feedback, 0, .9)
  sendOp(m, DelayOp::ApplyAll, when, delayEffectiveTime(p, m.song().tempo), m.perform().delayFeedback(), p.tone,
         p.pingpong ? 1 : 0);
  m.moveParam(UnitSlot::Delay, kDelayReturnGain, p.returnGain, when, 0.0);
}

class DelayService final : public Service {
 public:
  static constexpr const char *kName = "delay";
  explicit DelayService(Model &m) : m_(m) {}

  void onSongState(const SongState &s) override {
    // audio.js setTempo: delay.tempo = bpm; if (p.sync !== 'off') updateTime(now)
    const double tempo = s.tempo;
    if (tempo == tempo_) return;
    tempo_ = tempo;
    const DelayPatch &p = m_.patch().delay;
    if (!attached(m_) || p.sync == 0) return;
    sendOp(m_, DelayOp::SetTime, -1, delayEffectiveTime(p, tempo));
  }
  void onCommit(const PatchSpec &, double when) override {
    // audio.js commit -> _applyFx(fx, t): Object.assign(delay.p, fx.delay); delay.applyAll(t)
    tempo_ = m_.song().tempo;
    if (attached(m_)) applyAll(m_, when);
  }
  void onRateChanged(double) override {
    // the kernels are sized for the old rate: a fresh unit from the current patch (echo tails are dropped)
    if (attached(m_)) m_.attachUnit(UnitSlot::Delay, kKindDelay, -1);
  }

 private:
  Model &m_;
  double tempo_ = 0;
};

Service *makeService(Model &m) {
  return new DelayService(m);
}

bool onSet(Model &m, const SetRequest &req) {
  if (!req.row) return false;
  if (!attached(m)) return true;  // stored in the patch (Model::set); applied when the unit is built
  const std::string_view path(req.row->path);
  const DelayPatch &p = m.patch().delay;
  if (path == "fx.delay.returnGain") {
    m.moveParam(UnitSlot::Delay, kDelayReturnGain, p.returnGain, req.when, 0.0);
  } else if (path == "fx.delay.feedback") {
    // INTERFACE-CHANGE(W3A) T14 review F1: audio.js setParam records washFb, then Delay.setParam sends effectiveFb
    sendOp(m, DelayOp::SetFeedback, req.when, m.perform().delayFeedback(), 0.0);
  } else if (path == "fx.delay.time" || path == "fx.delay.sync") {
    sendOp(m, DelayOp::SetTime, req.when, delayEffectiveTime(p, m.song().tempo));
  } else if (path == "fx.delay.pingpong" || path == "fx.delay.tone") {
    applyAll(m, req.when);
  } else {
    return false;
  }
  return true;
}

}  // namespace

void sendDelayPanic(Model &m, double when) {
  if (attached(m)) sendOp(m, DelayOp::Panic, when);
}

}  // namespace rig::fx

void rig_register_fx_delay(rig::Registry &r) {
  r.addUnit(rig::kKindDelay, &rig::makeDelay);
  r.addService(rig::fx::DelayService::kName, &rig::fx::makeService);
  r.addSetHandler("fx.delay.", &rig::fx::onSet);
}
