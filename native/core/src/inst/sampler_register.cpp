// rig_register_inst_sampler: unit kind "inst.sampler" (inst/sampler.h) and the "sampler" service
// (inst/sampler_service.h) that builds it from the cache service's sample registry.
#include "api/registry.h"
#include "inst/sampler.h"
#include "inst/sampler_service.h"
#include "model/model.h"

namespace {

rig::Unit *makeSampler(const rig::UnitEnv &env, const rig::UnitSpec &spec) {
  rig::SamplerService *s = rig::SamplerService::forEnv(&env);
  return s ? s->build(env, spec) : nullptr;
}

rig::Service *makeService(rig::Model &m) {
  return new rig::SamplerService(m);
}

}  // namespace

void rig_register_inst_sampler(rig::Registry &r) {
  r.addUnit(rig::kKindSampler, &makeSampler);
  r.addService(rig::SamplerService::kName, &makeService);
}
