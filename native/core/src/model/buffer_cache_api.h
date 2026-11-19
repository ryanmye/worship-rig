// BufferCache API: what instruments, the click and the drone need from the decoded-sample cache. FROZEN by T00b.
// T06 implements it (src/samples/, class BufferCache : public BufferCacheApi, registered as the "cache" service which
// also derives CacheService); UnitEnv::cache points at it once registered (null before: samplers stay silent).
// Contract 1.2 / ARCHITECTURE M10: LRU under a byte cap, low-water 85 %, pins add/replace/auto, protect during a song
// switch, referenced buffers never evicted, deferred decodes, int16 storage on the iPad profile.
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>

namespace rig {

/** Immutable decoded sample at the ENGINE rate (resampled like decodeAudioData). Freed by the cache only after the
 *  graph has passed the epoch of its last detach (graph/epoch.h). Exactly one of f32/i16 is set per channel. */
struct SampleBuffer {
  std::uint32_t channels = 0;  // 1 or 2
  std::uint64_t frames = 0;
  double sampleRate = 0;
  const float *f32[2] = {nullptr, nullptr};
  const std::int16_t *i16[2] = {nullptr, nullptr};
  float i16Scale = 1.0f / 32768.0f;  // sample = i16 * scale
  std::uint64_t bytes = 0;           // stored bytes (cache accounting)
};

class BufferCacheApi {
 public:
  virtual ~BufferCacheApi() = default;
  using Ready = std::function<void(const SampleBuffer * /*null on failure*/)>;

  /** Decoded buffer for a cache key (sample url/path) with a reference taken, or null when not decoded (yet). */
  virtual const SampleBuffer *acquire(std::string_view key) = 0;
  /** Drop a reference; `epoch` = graph epoch of the detach of the last user (the buffer may be freed after it). */
  virtual void release(const SampleBuffer *buf, std::uint64_t epoch) = 0;
  /** Decode (worker; inline offline) unless cached; `ready` runs on the control thread. */
  virtual void request(std::string_view key, int priority, Ready ready) = 0;
  virtual bool has(std::string_view key) const = 0;
  virtual bool failed(std::string_view key) const = 0;

  /** Pins (contract 1.2 preload `pin`): mode "add" | "replace" | "none" | "auto". */
  virtual void pin(const std::string *keys, std::size_t n, std::string_view mode) = 0;
  /** Song switch protection: buffers of `keys` are never evicted until protect(nullptr, 0). */
  virtual void protect(const std::string *keys, std::size_t n) = 0;
  /** Memory pressure / low resource: 1 = drop unpinned, 2 = also drop pins beyond the current song. */
  virtual void trim(int level) = 0;

  /** Stored bytes (int16 storage counts 2 bytes per sample: contract 6 `cache estimate`, SETUP_REVIEW 20). */
  virtual double decodedMB() const = 0;
  virtual double pinnedMB() const = 0;
  virtual double capMB() const = 0;
};

}  // namespace rig
