// Registers the `rec` sink unit and the "rec" service (T08, M17).
#include "api/registry.h"
#include "model/model.h"
#include "rec/rec.h"

namespace {

rig::Unit *makeRec(const rig::UnitEnv &env, const rig::UnitSpec &) {
  rig::RecShared *s = rig::RecServiceImpl::sharedFor(env.config);
  return s ? new rig::RecUnit(s) : nullptr;
}

rig::Service *makeRecService(rig::Model &m) {
  return new rig::RecServiceImpl(m);
}

}  // namespace

void rig_register_rec_rec(rig::Registry &r) {
  r.addUnit(rig::kKindRec, &makeRec);
  r.addService(rig::RecService::kName, &makeRecService);
}
