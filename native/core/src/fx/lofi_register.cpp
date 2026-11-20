// rig_register_fx_lofi: kind "lofi" (fx/lofi.h), the "lofi" service (commit -> Lofi.apply, tape-bend hold state for
// T14, rate change -> rebuild) and the set handler for fx.lofi.{amount,wow,flutter,crackle,bits,tone,saturation}
// (contract 2.3: one coalescing key `fx.lofi`, Lofi.apply).
#include "api/registry.h"
#include "fx/lofi_unit.h"
#include "model/model.h"
#include "model/patch.h"
#include "params/params.h"

namespace rig::fx {
namespace {

bool attached(const Model &m) {
  return m.attachedKind(UnitSlot::Lofi) == kKindLofi && m.attachedIsModule(UnitSlot::Lofi);
}

class LofiService final : public Service {
 public:
  static constexpr const char *kName = "lofi";
  explicit LofiService(Model &m) : m_(m) {}
  void onCommit(const PatchSpec &, double when) override { send(when); }
  void onRateChanged(double) override {
    if (attached(m_)) m_.attachUnit(UnitSlot::Lofi, kKindLofi, -1);  // crackle buffer and delay sized per rate
  }
  void send(double when) {
    if (!attached(m_)) return;
    LofiState *s = LofiState::make(m_.patch().lofi, held_, tapeActive_);
    s->when = m_.timeFor(when);
    m_.sendOwned(UnitSlot::Lofi, opOf(LofiOp::Apply), s, when);
  }
  bool held_ = false, tapeActive_ = false;

 private:
  Model &m_;
};

Service *makeService(Model &m) {
  return new LofiService(m);
}

LofiService *svc(Model &m) {
  return dynamic_cast<LofiService *>(m.service(LofiService::kName));
}

bool onSet(Model &m, const SetRequest &req) {
  if (!req.row) return false;
  if (LofiService *s = svc(m)) s->send(req.when);  // stored in the patch already; not attached = applied at build
  return true;
}

}  // namespace

void lofiApply(Model &m, double when) {
  if (LofiService *s = svc(m)) s->send(when);
}
void lofiHold(Model &m, bool on, double when) {
  if (LofiService *s = svc(m)) {
    s->held_ = on;
    s->send(when);
  }
}
void lofiSetTapeActive(Model &m, bool on) {
  if (LofiService *s = svc(m)) s->tapeActive_ = on;
}

}  // namespace rig::fx

void rig_register_fx_lofi(rig::Registry &r) {
  r.addUnit(rig::kKindLofi, &rig::makeLofi);
  r.addService("lofi", &rig::fx::makeService);
  r.addSetHandler("fx.lofi.", &rig::fx::onSet);
}
