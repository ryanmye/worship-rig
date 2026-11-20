// Sample manifests (M10): port of `normalizeManifest` (app/js/engine/sampler.js) and of the registry's manifest and
// gain-trims loading (app/js/engine/instruments.js). Sample "urls" are file paths here: the cache key is the path of
// the file (`<path>` for the legacy decode cap, `<path>#max=<s>` for a long variant).
#pragma once
#include <functional>
#include <map>
#include <string>
#include <string_view>
#include <vector>

#include "samples/process_sample.h"

struct yyjson_val;

namespace rig::samples {

inline constexpr double kReleaseMin = 0.02, kReleaseMax = 1.5;
inline constexpr double kGainTrimMaxDb = 30;
inline constexpr double kUserReleaseDefault = 0.15;
inline constexpr int kPianoUndampedFrom = 90;

struct SampleRef {
  int midi = 0;
  std::string url;  // file path (cache key base)
};
struct Layer {
  int lo = 0, hi = 127;
  std::vector<SampleRef> samples;  // sorted by midi
};
struct SamplerDef {
  std::string id, name, group;
  std::vector<Layer> layers;  // sorted by lo
  double release = 0.12, gainTrimDb = 0;
  int undampedFrom = -1;  // -1 = off
  double widthDefault = 1;
  double maxSec = 0;  // 0 = the legacy 10 s / 16 s rule
  bool hasDecodeOpts = false;
  DecodeOpts decodeOpts;
  std::string license, attribution;
};

struct NormalizeOptions {
  std::string idPrefix;  // 'user:' for My Samples
  std::string group;     // default group of entries without their own
  double defaultRelease = 0.12;
  bool secondary = false;  // a user manifest (no piano / keys defaults)
  std::function<void(const std::string &)> warn;
};

/** `json` = the parsed manifest (array, {instruments:[...]} or {instruments:{id:{...}}}); relative sample paths
 *  resolve against the directory of `manifestPath`, absolute ones are used as they are. */
std::vector<SamplerDef> normalizeManifest(const yyjson_val *json, const std::string &manifestPath,
                                          const NormalizeOptions &opts);

/** parseNoteName ("C#4", "Db3", "A0"); false outside 0..127 or unparseable. */
bool parseNoteName(std::string_view name, int &midi);

struct GainTrims {
  std::map<std::string, double> synth, organ;
  double droneTrim = 0;
};
/** gain-trims.json; false (and `trims` reset) when unreadable, with `err` set. */
bool loadGainTrims(const std::string &path, GainTrims &trims, std::string *err);

/** Samplers by id: the factory manifest first, user entries (`user:<id>`) from the merged My Samples manifest. */
class SampleRegistry {
 public:
  using Warn = std::function<void(const std::string &)>;
  /** Factory manifest `<appDir>/samples/manifest.json` + gain trims `<appDir>/js/engine/gain-trims.json`. */
  void loadFactory(const std::string &appDir, const Warn &warn);
  enum class UserResult { Loaded, NotServed, Failed };
  /** Replace the `user:` entries by the manifest at `path` ("" / missing file = not served: user entries go; an
   *  unreadable or malformed file keeps the previous entries: round2-engine m1). `dropped` gets every sample path of
   *  the old and new user entries (for BufferCache::invalidate). */
  UserResult reloadUser(const std::string &path, const Warn &warn, std::vector<std::string> &dropped);
  const SamplerDef *find(std::string_view id) const;
  const std::map<std::string, SamplerDef, std::less<>> &all() const { return defs_; }
  const GainTrims &gainTrims() const { return trims_; }
  std::size_t userCount() const;
  /** Number of sampler defs (the `instruments {count}` figure is the catalogue's; this is the sampler share). */
  std::size_t size() const { return defs_.size(); }

 private:
  std::map<std::string, SamplerDef, std::less<>> defs_;
  GainTrims trims_;
};

}  // namespace rig::samples
