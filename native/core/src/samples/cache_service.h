// "cache" service (M10): preload / estimate / sampleStatus / reloadManifests over BufferCache + SampleRegistry
// (contract 1.2, 6.4 `cache`, `get sampleStatus`), plus the hooks T08/T13 need (see the T06 report).
#pragma once
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "model/services.h"
#include "samples/buffer_cache.h"
#include "samples/manifest.h"

namespace rig {
class Model;
struct PatchSpec;
}  // namespace rig

namespace rig::samples {

class CacheServiceImpl final : public rig::CacheService {
 public:
  explicit CacheServiceImpl(rig::Model &m);
  ~CacheServiceImpl() override;

  // Service
  void onCommit(const rig::PatchSpec &patch, double when) override;
  void onRateChanged(double sampleRate) override;
  void onMemoryPressure(int level) override;
  void onPaths(const rig::EnginePaths &paths) override;
  std::string statsFields() override;
  // CacheService (frozen, synchronous). In realtime mode preload blocks the calling thread until the workers are
  // done (pumping meanwhile): the bridge answers `cache preload` through preloadAsync instead (CORE2A), so the
  // control loop keeps handling input and sending ticks while samples decode.
  std::string preload(const yyjson_val *patches, std::string_view pin) override;
  std::string estimate(const yyjson_val *patches) override;
  std::string sampleStatus(const yyjson_val *patches) override;
  bool reloadManifests() override;
  rig::BufferCacheApi *bufferCache() override { return &cache_; }

  // ---- beyond the frozen interface ------------------------------------------------------------------------
  /** `done(json)` runs on the control thread when every decode finished: {decodedMB, pinnedMB, deferred}. Inline
   *  (offline) it runs before this returns. */
  void preloadAsync(const yyjson_val *patches, std::string_view pin, std::function<void(std::string)> done);
  /** CORE2A: the cache keys the sampler units of `patch` request when they are built (SamplerService::build: every
   *  sample of a known sampler slot at its instrument's own decode cap). Call before the patch is prepared. */
  std::vector<std::string> samplerLoadKeys(const rig::PatchSpec &patch) const;
  /** CORE2A: `done` runs on the control thread once none of `keys` is still decoding (BufferCache::whenSettled). */
  void whenSettled(const std::vector<std::string> &keys, std::function<void()> done) {
    cache_.whenSettled(keys, std::move(done));
  }
  /** Control loop: integrate finished decodes and advance preloads. Returns how many results were integrated. */
  std::size_t pump();
  /** Set by the shell/engine: runs on a worker when a decode finished (wake the control thread to pump()). */
  void setWake(std::function<void()> wake) { cache_.setWake(std::move(wake)); }
  /** Epoch source of the graph (graph/epoch.h): evicted buffers are freed only after the graph passed it. */
  void setEpochSource(std::function<std::uint64_t()> fn) { cache_.setEpochSource(std::move(fn)); }
  /** Cache keys (both decode caps) of these patches' sampler samples: the BufferCache::protect set of a switch. */
  std::vector<std::string> protectKeys(const std::vector<const rig::PatchSpec *> &patches) const;
  /** prepare(): protect = playing + incoming song. nullptr entries are skipped. */
  void protectSwitch(const rig::PatchSpec *playing, const rig::PatchSpec *incoming);
  /** Low-resource mode: pins = current song only (old pins remembered), unpinned buffers trimmed; off restores. */
  void setLowResource(bool on);
  /** Decode pinned samples that were evicted for a switch's headroom (or deferred), while they fit. When the pass
   *  requested any decode, it ends with a `load {phase:'samples'}` for the pinned songs' samplers (O-AW-4). */
  void rewarmPins();
  /** O-AW-4 (ENGINE_CONTRACT 6.5 `load`, review S-cue-go S3): the distinct sampler instrument ids of `patches`, in
   *  slot order. */
  std::vector<std::string> samplerIds(const std::vector<rig::PatchSpec> &patches) const;
  /** O-AW-4: emit `load {phase:'samples', loaded:{<id>: bool}}` for these sampler ids. true = every sample of the
   *  instrument is decoded or failed: the rule of `get sampleStatus` `loaded` for a one-slot patch. Nothing for an
   *  empty list. Control thread only (Model::emit); reads the cache, changes nothing (no LRU touch, no lock). */
  void emitSamples(const std::vector<std::string> &ids);
  /** T00c pin policy: the keys of `keys` (request order, deduplicated; a key that does not fit is skipped and later
   *  smaller ones may still fit) whose estimated bytes fit the pin budget (85 % of the hard cap; with `add`, on top
   *  of the estimate of what is pinned already, decoded or not). Counts and warns about the rest. */
  std::vector<std::string> withinPinBudget(const std::vector<std::string> &keys, bool add);

  /** samples.pcmOverride test hook (SETUP_REVIEW 13): decoded PCM dumped from the golden Chromium
   *  (tools/golden/decode-dump/dump.mjs) replaces the native decoder wherever a dump exists, so exact-tier sampler
   *  fixtures test the sampler, not the decoder. `dir` holds raw<rate>/<key>.wav; also read from the environment
   *  variable RIG_SAMPLES_PCM_OVERRIDE when the engine has RIG_FLAG_TEST_API. Empty dir = off. */
  void setPcmOverride(const std::string &dir);

  BufferCache &cache() { return cache_; }
  SampleRegistry &registry() { return registry_; }
  const SampleRegistry &registry() const { return registry_; }

  struct JobList {
    std::vector<std::string> keys;
    std::vector<SampleJob> jobs;
    std::vector<std::string> jobKeys;
  };
  /** JS `_sampleJobs`: keys and decode jobs of the sampler slots of these patches. */
  JobList sampleJobs(const std::vector<rig::PatchSpec> &patches) const;

 private:
  struct PreloadOp;
  void advance(const std::shared_ptr<PreloadOp> &op);
  void rewarmFrom(std::size_t i);
  std::vector<rig::PatchSpec> parsePatches(const yyjson_val *patches) const;
  std::vector<std::string> currentKeys() const;
  void doPin(const std::vector<std::string> &keys, const std::string &pin);
  /** {loaded, failed} of one patch, as `get sampleStatus` answers it (loaded = every sample held or failed). */
  std::pair<bool, bool> statusOf(const rig::PatchSpec &patch) const;
  void warnMsg(const std::string &m, const char *code);
  void build(const rig::EnginePaths &p);

  rig::Model &model_;
  SampleRegistry registry_;
  std::unique_ptr<JobRunner> runner_;
  BufferCache cache_;
  rig::EnginePaths paths_;
  std::string loadedApp_;
  std::vector<std::shared_ptr<PreloadOp>> ops_;
  std::vector<std::pair<std::string, SampleJob>> pinJobs_;
  std::vector<std::string> pinIds_;  // O-AW-4: sampler ids of the pinned songs (pinJobs_'s instruments), for rewarm
  std::vector<std::string> lowResSavedPins_;
  bool lowRes_ = false, rewarming_ = false, rewarmInSync_ = false;
  std::size_t rewarmDone_ = 0;
  std::size_t rewarmRequested_ = 0;  // O-AW-4: decodes the current rewarm pass requested (0 = no samples event)
  int pinsDropped_ = 0;  // T00c pin budget
};

}  // namespace rig::samples
