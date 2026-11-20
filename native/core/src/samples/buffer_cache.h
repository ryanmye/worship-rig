// BufferCache (M10): the decoded-sample cache. Port of `BufferCache` (app/js/engine/sampler.js) with the policy the
// contract documents (1.2, 7): LRU under a byte cap with a low-water mark (85 %), pins (add / replace / auto),
// `protect` during a song switch (pinned buffers of other songs give way, LRU, just enough), referenced buffers never
// evicted (gapless rule), sustain variants (`<url>#max=<s>`) with legacy-key stand-ins, decoded sizes remembered after
// eviction, failure marks with a 30 s retry window.
//
// UNITS (SETUP_REVIEW 20): every byte count in this file is STORED bytes: channels x frames x 4 for float32 storage,
// x 2 for int16 storage (iPad profile). `decodedMB`, `pinnedMB`, `capMB`, the cap itself, `estimateBytes` and the
// 1.75 MB per unknown sample default all use that one unit; the default is scaled with the storage (1.75 MB float32,
// 0.875 MB int16). The cap is therefore a real memory budget: 320 MB means 320 MB of resident sample data.
//
// Threading: ALL state is control-thread only. Decoding runs on a JobRunner (worker threads, or inline offline); a
// worker only touches its own data and pushes the finished buffer into a mutex-protected mailbox that pump() drains
// on the control thread. Buffers handed out by acquire() stay valid until released AND the graph passed the epoch
// given to release() (graph/epoch.h): evicted buffers wait in a graveyard until then.
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "model/buffer_cache_api.h"
#include "samples/decode.h"
#include "samples/decode_pool.h"
#include "samples/process_sample.h"

namespace rig::samples {

inline constexpr double kMB = 1024.0 * 1024.0;
inline constexpr double kDefaultSampleBytesF32 = 1.75 * kMB;  // measured: 591 factory-song samples = 1.73 MB each
inline constexpr double kRetryAfterMs = 30000;
inline constexpr const char *kVariantSep = "#max=";

enum class Storage { F32, I16 };

struct SampleJob {
  std::string url;  // file path
  int midi = 60;
  DecodeOpts opts;  // maxSec selects the variant (keyOf)
};

/** What a load produces; see Stored. */
struct Stored : SampleBuffer {
  std::vector<float> f32v[2];
  std::vector<std::int16_t> i16v[2];
  int refs = 0;
  std::uint64_t lastUsed = 0;
  std::uint64_t freeAfterEpoch = 0;
  bool hasEpoch = false;
  // processSample facts (JS buf._natural / _capped / _dualMono / _onsetTrim / _monoFix)
  std::uint64_t natural = 0;
  bool capped = false, dualMono = false;
  double onsetTrim = 0;
  MonoFix monoFix;
  double lrDiff = 0;
};

struct LoadRequest {
  std::string url;
  int midi = 60;
  DecodeOpts opts;
  double engineRate = 48000;
  Storage storage = Storage::F32;
};
struct LoadOutcome {
  enum class Status { Ok, Transient, Permanent } status = Status::Permanent;
  std::string error;
  std::unique_ptr<Stored> buffer;  // Ok only
};
using LoadFn = std::function<LoadOutcome(const LoadRequest &)>;

/** Pack processSample output into a Stored buffer (float32 or int16 + scale). */
std::unique_ptr<Stored> makeStored(const Processed &p, double sampleRate, Storage storage);
/** Decode + resample to the engine rate + processSample + pack. `host` decodes formats the core cannot. */
LoadOutcome loadSampleFile(const LoadRequest &rq, const HostDecodeFn &host);

/** URL part of a cache key. */
std::string urlOfKey(std::string_view key);

class BufferCache final : public BufferCacheApi {
 public:
  struct Config {
    std::uint64_t capBytes = 700ull * 1024 * 1024;
    double lowWater = 0.85;
    Storage storage = Storage::F32;
    double engineRate = 48000;
    int retries = 2;
    int retryDelayMs = 400;
    std::function<std::uint64_t()> graphEpoch;      // null: evicted buffers are freed at once
    std::function<double()> nowMs;                  // null: steady clock
    std::function<void(const std::string &)> warn;  // "Sample missing or undecodable, skipped: ..."
    std::function<void()> wake;                     // a worker finished: the control thread should pump()
    // T00c (D3 memory budget): hard cap on STORED bytes. A finished decode that would push the total above it
    // after eviction (everything left is referenced, pinned or protected) is refused: its waiters get null, the url
    // is marked failed for the retry window, and `warnMemory` fires once until the cache drops below low water.
    // 0 = off (1.x behaviour: the cap is soft and referenced buffers may exceed it). CacheService sets it per
    // profile (ARCHITECTURE section 7).
    std::uint64_t hardCapBytes = 0;
    std::function<void(const std::string &)> warnMemory;
  };
  using Ready = BufferCacheApi::Ready;

  /** `runner` is not owned (null = inline). `load` null = the real file decoder with `host`. */
  BufferCache(Config cfg, LoadFn load, JobRunner *runner);
  ~BufferCache() override;

  // ---- BufferCacheApi (contract 1.2) -------------------------------------------------------------------------
  const SampleBuffer *acquire(std::string_view key) override;
  void release(const SampleBuffer *buf, std::uint64_t epoch) override;
  void request(std::string_view key, int priority, Ready ready) override;
  bool has(std::string_view key) const override;
  bool failed(std::string_view key) const override;
  void pin(const std::string *keys, std::size_t n, std::string_view mode) override;
  void protect(const std::string *keys, std::size_t n) override;
  void trim(int level) override;
  double decodedMB() const override { return static_cast<double>(bytes_) / kMB; }
  double pinnedMB() const override { return static_cast<double>(pinnedBytes()) / kMB; }
  double capMB() const override { return static_cast<double>(cfg_.capBytes) / kMB; }

  /** Epoch source of the graph; set once at startup (null = evicted buffers are freed at once, offline). */
  void setEpochSource(std::function<std::uint64_t()> fn) { cfg_.graphEpoch = std::move(fn); }
  /** Worker-finished notification; set once at startup, before the first request (workers read it). */
  void setWake(std::function<void()> fn) { cfg_.wake = std::move(fn); }
  /** Replace the decoder (tests; control thread, nothing in flight). */
  void setLoader(LoadFn load) { load_ = std::move(load); }

  // ---- decode requests -----------------------------------------------------------------------------------------
  /** Register how a key's url is decoded for request(key) / acquire-by-key callers (midi, maxMonoLossDb). */
  void declareSource(const std::string &url, int midi, const DecodeOpts &opts);
  /** Decode `job` unless cached or skipped (a failed url): `ready` runs on the control thread (inline: before this
   *  returns) with the buffer, or null on failure. With `takeRef` the callback's buffer carries a reference (JS
   *  `acquire(url, ctx, midi, owner, opts)`): release() it. */
  void requestJob(const SampleJob &job, int priority, bool takeRef, Ready ready);
  /** Drain finished decodes (control thread; call when `wake` fired, or each loop turn). Returns how many. */
  std::size_t pump();
  /** Decodes submitted and not yet integrated. */
  std::size_t inflight() const { return inflight_.size(); }
  /** Block until nothing is in flight (tests, synchronous preload). Pumps while waiting. */
  void waitIdle();

  // ---- keys, sizes (JS keyOf / estimateBytes / roomFor) --------------------------------------------------------
  std::string keyOf(const std::string &url, int midi, double maxSec) const;
  struct Estimate {
    double bytes = 0;
    int unknown = 0;
    int count = 0;
  };
  Estimate estimateBytes(const std::vector<std::string> &keys) const;
  bool roomFor(double extraBytes) const;
  std::uint64_t pinnedBytes() const;
  std::uint64_t referencedBytes() const;
  std::uint64_t bytes() const { return bytes_; }
  std::uint64_t capBytes() const { return cfg_.capBytes; }
  double lowWaterBytes() const { return static_cast<double>(cfg_.capBytes) * cfg_.lowWater; }
  /** Change the cap (tests, memory profile); re-evicts. */
  void setCapBytes(std::uint64_t bytes);
  int bytesPerSample() const { return cfg_.storage == Storage::I16 ? 2 : 4; }
  double defaultSampleBytes() const { return kDefaultSampleBytesF32 * bytesPerSample() / 4.0; }
  Storage storage() const { return cfg_.storage; }
  double engineRate() const { return cfg_.engineRate; }
  /** The audio thread adopted a new rate: buffers at the old rate are stale (unreferenced ones go now). */
  void setEngineRate(double sr);

  // ---- pins, protection, variants ----------------------------------------------------------------------------
  void pinAdd(const std::vector<std::string> &keys);
  void setPins(const std::vector<std::string> &keys);
  void unpin(const std::vector<std::string> &keys);
  const std::set<std::string> &pins() const { return pinned_; }
  bool hasProtect() const { return protect_.has_value(); }
  bool isProtected(const std::string &key) const { return protectedKey(key); }
  void clearProtect() { protect_.reset(); }
  /** The long variant now answers for legacy key `url` (its owner already released it). */
  void supersede(const std::string &legacyKey, const std::string &longKey);
  /** A decoded long variant of `url`, or "". */
  std::string longOf(const std::string &url) const;
  /** Failure marks and unreferenced buffers of these urls go (My Samples rescan). */
  struct Invalidated {
    int failed = 0, dropped = 0;
  };
  Invalidated invalidate(const std::vector<std::string> &urls);
  /** Drop every buffer that is neither pinned, referenced nor protected; returns stored bytes freed. */
  std::uint64_t trimUnpinned();
  /** Free what the graph no longer reads (call each control turn; evictions do it too). */
  std::size_t collect();
  std::size_t graveyardSize() const { return graveyard_.size(); }
  int evictedPinned() const { return evictedPinned_; }
  /** T00c: decodes refused by the hard cap since creation. */
  int capRefused() const { return capRefused_; }
  std::uint64_t hardCapBytes() const { return cfg_.hardCapBytes; }
  const std::map<std::string, double> &sizes() const { return sizes_; }
  /** Decoded buffer for `key` without taking a reference (tests). */
  const Stored *peek(std::string_view key) const;
  bool skipped(const std::string &url);
  std::size_t entryCount() const { return entries_.size(); }

 private:
  struct Meta {
    std::uint64_t nat = 0;
    int ch = 1;
    double sr = 0;
    int midi = 60;
  };
  struct Failure {
    double at = 0;
    bool permanent = false;
  };
  struct Done {
    std::string key, url;
    SampleJob job;
    LoadOutcome out;
  };
  struct Waiter {
    bool takeRef = false;
    Ready ready;
  };

  double now() const;
  bool protectedKey(const std::string &key) const;
  bool isPinned(const std::string &key) const;
  std::string standIn(const std::string &key) const;
  Stored *find(const std::string &key);
  const Stored *find(const std::string &key) const { return const_cast<BufferCache *>(this)->find(key); }
  void deleteEntry(const std::string &key);
  void evict(double incoming = 0);
  void finish(Done &d);
  void deliver(const std::string &key, const std::string &url, Stored *e);
  static LoadOutcome runLoad(const LoadFn &load, const LoadRequest &rq, int retries, int delayMs);
  void adoptLong(const std::string &url);

  Config cfg_;
  LoadFn load_;
  JobRunner *runner_;
  std::unordered_map<std::string, std::unique_ptr<Stored>> entries_;
  std::map<std::string, std::vector<Waiter>> inflight_;  // key -> waiters
  std::set<std::string> pinned_;
  std::map<std::string, Failure> failed_;
  std::map<std::string, double> sizes_;  // stored bytes per key, kept after eviction
  std::map<std::string, Meta> meta_;
  std::map<std::string, std::string> superseded_, supersededBy_;
  std::map<std::string, std::set<std::string>> longKeys_;
  std::map<std::string, std::pair<int, DecodeOpts>> sources_;
  std::optional<std::set<std::string>> protect_;
  std::vector<std::unique_ptr<Stored>> graveyard_;  // evicted, waiting for the graph epoch (Stored::freeAfterEpoch)
  std::vector<std::unique_ptr<Stored>> stale_;      // referenced buffers of the previous engine rate
  std::uint64_t bytes_ = 0, tick_ = 0;
  int evictedPinned_ = 0;
  int capRefused_ = 0;     // T00c
  bool capWarned_ = false;  // T00c: one warnMemory per excursion above low water
  std::mutex mailM_;
  std::vector<Done> mailbox_;
  std::size_t posted_ = 0;  // jobs posted whose result has not been integrated (control thread view)
};

}  // namespace rig::samples
