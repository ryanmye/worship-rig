// Registers the `meter` sink unit and the "meter" service (T08, M16).
#include "api/registry.h"
#include "meter/meter.h"
#include "model/model.h"

namespace {

rig::Unit *makeMeter(const rig::UnitEnv &env, const rig::UnitSpec &) {
  rig::MeterShared *s = rig::MeterServiceImpl::sharedFor(env.config);
  if (!s) return nullptr;
  s->attached.store(true, std::memory_order_relaxed);
  return new rig::MeterUnit(s);
}

rig::Service *makeMeterService(rig::Model &m) {
  return new rig::MeterServiceImpl(m);
}

}  // namespace

void rig_register_meter_meter(rig::Registry &r) {
  r.addUnit(rig::kKindMeter, &makeMeter);
  r.addService(rig::MeterService::kName, &makeMeterService);
}
