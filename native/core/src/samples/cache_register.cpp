// rig_register_samples_cache: the "cache" service (T06). Units read the cache through UnitEnv::cache.
#include "api/registry.h"
#include "model/model.h"
#include "samples/cache_service.h"

namespace {
rig::Service *makeCache(rig::Model &m) { return new rig::samples::CacheServiceImpl(m); }
}  // namespace

void rig_register_samples_cache(rig::Registry &r) { r.addService(rig::CacheService::kName, &makeCache); }
