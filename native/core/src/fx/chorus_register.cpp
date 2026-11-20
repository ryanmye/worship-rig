// rig_register_fx_chorus: kind "chorus" (fx/chorus.h), the "chorus" service (commit -> rate/depth/return moves,
// rate change -> rebuild) and the set handler for fx.chorus.{rate,depth,returnGain} (contract 2.3; audio.js
// setParam 'chorus', _applyFx).
#include "api/registry.h"
#include "fx/chorus_unit.h"
#include "model/model.h"
#include "model/patch.h"
#include "params/params.h"

namespace rig::fx {
namespace {

bool attached(const Model &m) {
  return m.attachedKind(UnitSlot::Chorus) == kKindChorus && m.attachedIsModule(UnitSlot::Chorus);
}

void sendOp(Model &m, ChorusUnitOp op, double value, double when) {
  Command c{};
  c.op = opOf(op);
  c.f.a = value;
  c.f.e = m.timeFor(when);
  m.sendUnitOp(UnitSlot::Chorus, c, when);
}

class ChorusService final : public Service {
 public:
  explicit ChorusService(Model &m) : m_(m) {}
  void onCommit(const PatchSpec &p, double when) override {
    if (!attached(m_)) return;
    sendOp(m_, ChorusUnitOp::SetRate, p.chorus.rate, when);
    sendOp(m_, ChorusUnitOp::SetDepth, p.chorus.depth, when);
    m_.moveParam(UnitSlot::Chorus, kChorusReturnGain, p.chorus.returnGain, when, 0.0);
  }
  void onRateChanged(double) override {
    if (attached(m_)) m_.attachUnit(UnitSlot::Chorus, kKindChorus, -1);  // PeriodicWave tables are per rate
  }

 private:
  Model &m_;
};

Service *makeService(Model &m) {
  return new ChorusService(m);
}

bool onSet(Model &m, const SetRequest &req) {
  if (!req.row) return false;
  if (!attached(m)) return true;  // stored in the patch; applied when the unit is built
  const std::string_view path(req.row->path);
  const ChorusPatch &p = m.patch().chorus;
  if (path == "fx.chorus.rate") {
    sendOp(m, ChorusUnitOp::SetRate, p.rate, req.when);
  } else if (path == "fx.chorus.depth") {
    sendOp(m, ChorusUnitOp::SetDepth, p.depth, req.when);
  } else if (path == "fx.chorus.returnGain") {
    m.moveParam(UnitSlot::Chorus, kChorusReturnGain, p.returnGain, req.when, 0.0);
  } else {
    return false;
  }
  return true;
}

}  // namespace
}  // namespace rig::fx

void rig_register_fx_chorus(rig::Registry &r) {
  r.addUnit(rig::kKindChorus, &rig::makeChorus);
  r.addService("chorus", &rig::fx::makeService);
  r.addSetHandler("fx.chorus.", &rig::fx::onSet);
}
