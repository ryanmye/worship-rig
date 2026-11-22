// "sampler" service (T12, control thread): builds `inst.sampler` units from the sample registry and the buffer
// cache of the "cache" service (T06), keeps their cache references, delivers samples decoded after the commit, and
// applies each sampler's widthDefault to its strip at every commit (audio.js _effWidth: width x widthDefault).
//
// Why a service: a unit factory only gets UnitEnv + UnitSpec. The service registers the address of its Model's
// UnitEnv (Model::env(), the object attachUnit passes to every factory) so the factory finds the Model, and through
// it the cache service's SampleRegistry and BufferCache.
#pragma once
#include <cstdint>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "api/registry.h"
#include "inst/sampler.h"
#include "model/services.h"

namespace rig {

namespace samples {
class CacheServiceImpl;
struct SamplerDef;
}  // namespace samples

/** Shared by the service and every zone table: releases cache references while the cache is alive (units can
 *  outlive the Model's services at engine teardown: Graph::~Graph deletes the units last). Control thread only. */
class SamplerLeases {
 public:
  explicit SamplerLeases(BufferCacheApi *cache) : cache_(cache) {}
  void release(const SampleBuffer *b) {
    if (cache_ && b) cache_->release(b, 0);  // the graph no longer reads a table that is being destroyed
  }
  void detach() { cache_ = nullptr; }
  BufferCacheApi *cache() const { return cache_; }

 private:
  BufferCacheApi *cache_;
};

class SamplerService final : public Service {
 public:
  static constexpr const char *kName = "sampler";
  explicit SamplerService(Model &m);
  ~SamplerService() override;

  /** The service of the Model whose env() this is (factory side), or null. */
  static SamplerService *forEnv(const UnitEnv *env);

  /** Unit factory body for kind inst.sampler. */
  Unit *build(const UnitEnv &env, const UnitSpec &spec);

  // Service
  void onCommit(const PatchSpec &patch, double when) override;
  std::string statsFields() override;

  /** The resolved manifest entry of a sampler id (null: unknown, or no cache service). */
  const samples::SamplerDef *def(const std::string &id);

 private:
  struct Load;
  samples::CacheServiceImpl *cacheService();
  SamplerZones *makeTable(Load &ld, bool final);
  void finish(const std::shared_ptr<Load> &ld);

  Model &m_;
  std::shared_ptr<SamplerLeases> leases_;
  std::vector<std::shared_ptr<Load>> loads_;  // decodes still in flight (realtime)
  // CORE2A: loads that finished before their unit was attached (a prepared unit is attached at commit: a table sent
  // to its slot before then reached the old unit, was refused by instSeq, and the new sampler kept its partial
  // table for good). They are sent at the next commit, at the commit's time, after its AttachUnit commands.
  std::vector<std::shared_ptr<Load>> unattached_;
  std::uint64_t commits_ = 0;
  std::uint64_t built_ = 0, lateTables_ = 0;
};

}  // namespace rig
