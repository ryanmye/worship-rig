// rig_register_drone_drone: kind "drone" (drone/drone.h, DroneUnit), the "drone" service (DroneServiceImpl:
// DroneService + PerformDrone) and the set handler for drone.{gain,width,brightness,movement,fade} (contract 2.3;
// audio.js setParam 'drone' -> drone.setParam(key, v, t, glide)). T16.
#include <string_view>

#include "api/registry.h"
#include "drone/drone_service.h"
#include "drone/drone_unit.h"
#include "model/model.h"
#include "params/params.h"

namespace rig::drone {
namespace {

Unit *makeUnit(const UnitEnv &env, const UnitSpec &spec) {
  if (DroneServiceImpl *s = DroneServiceImpl::forPatch(spec.patch)) return s->buildUnit(env, spec);
  return new DroneUnit(env.sampleRate, DroneInit{});  // no service (a test registry): a silent, idle drone
}

Service *makeService(Model &m) {
  return new DroneServiceImpl(m);
}

bool onSet(Model &m, const SetRequest &req) {
  if (!req.row) return false;
  auto *s = dynamic_cast<DroneServiceImpl *>(m.service(DroneService::kName));
  if (!s || !s->core()) {
    m.warn(std::string(req.path) + " before start(); ignored.", "drone");
    return false;
  }
  std::string_view key(req.row->path);
  key.remove_prefix(6);  // "drone."
  return s->core()->setParam(key, req.value, req.when, req.glide);
}

}  // namespace

Unit *makeDroneUnit(const UnitEnv &env, const UnitSpec &spec) {
  return makeUnit(env, spec);
}

}  // namespace rig::drone

namespace rig {
Unit *makeDrone(const UnitEnv &env, const UnitSpec &spec) {
  return drone::makeDroneUnit(env, spec);
}
}  // namespace rig

void rig_register_drone_drone(rig::Registry &r) {
  r.addUnit(rig::kKindDrone, &rig::makeDrone);
  r.addService(rig::DroneService::kName, &rig::drone::makeService);
  r.addSetHandler("drone.", &rig::drone::onSet);
}
