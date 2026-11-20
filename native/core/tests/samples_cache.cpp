// T06: BufferCache policy, ported from the JS engine tests (test/phase1/engine/suites.mjs: preloadAndLRU, pinsUnion,
// pinsLimitedEvict, switchHeadroom, sampleRetry, userManifestGuards cache part) plus the native-only parts: one byte
// unit for f32 and int16 storage, epoch-deferred frees, worker pool delivery, rate change. Decoding is replaced by a
// fake loader so sizes are exact and the tests are fast.
#include <atomic>
#include <cmath>
#include <map>
#include <mutex>

#include "doctest.h"
#include "samples/buffer_cache.h"

using namespace rig::samples;
using rig::SampleBuffer;

namespace {

constexpr std::uint64_t kK = 1024;

/** Fake decoder: bytes per url from `sizes` (default 8 KiB of float32), failures by substring. */
struct Fake {
  std::mutex m;
  std::map<std::string, int> calls;
  std::map<std::string, std::uint64_t> sizes;  // stored bytes at f32; halved by the loader for int16
  std::map<std::string, int> failFirst;        // url -> transient failures before success
  std::vector<std::string> transientAlways, permanent;
  int channels = 1;
  std::uint64_t natural = 0;  // 0 = frames

  LoadOutcome operator()(const LoadRequest &rq) {
    std::lock_guard<std::mutex> l(m);
    ++calls[rq.url];
    LoadOutcome o;
    for (const auto &p : permanent)
      if (rq.url.find(p) != std::string::npos) {
        o.status = LoadOutcome::Status::Permanent;
        o.error = "HTTP 404";
        return o;
      }
    for (const auto &p : transientAlways)
      if (rq.url.find(p) != std::string::npos) {
        o.status = LoadOutcome::Status::Transient;
        o.error = "timed out";
        return o;
      }
    auto ff = failFirst.find(rq.url);
    if (ff != failFirst.end() && ff->second > 0) {
      --ff->second;
      o.status = LoadOutcome::Status::Transient;
      o.error = "network error";
      return o;
    }
    const std::uint64_t f32Bytes = sizes.count(rq.url) ? sizes[rq.url] : 8 * kK;
    Processed p;
    p.channels = channels;
    p.frames = static_cast<std::size_t>(f32Bytes / 4 / static_cast<std::uint64_t>(channels));
    for (int c = 0; c < channels; ++c) p.ch[c].assign(p.frames, 0.25f);
    p.natural = natural ? natural : p.frames;
    o.buffer = makeStored(p, rq.engineRate, rq.storage);
    o.status = LoadOutcome::Status::Ok;
    return o;
  }
  int count(const std::string &u) {
    std::lock_guard<std::mutex> l(m);
    return calls.count(u) ? calls[u] : 0;
  }
};

struct Rig {
  Fake fake;
  std::vector<std::string> warns;
  std::unique_ptr<BufferCache> c;
  double clockMs = 0;
  std::uint64_t epoch = 0;
  bool gated = false;
  explicit Rig(std::uint64_t cap = 1000 * kK, Storage st = Storage::F32, JobRunner *r = nullptr, int retries = 2) {
    BufferCache::Config cfg;
    cfg.capBytes = cap;
    cfg.storage = st;
    cfg.engineRate = 44100;
    cfg.retries = retries;
    cfg.retryDelayMs = 1;
    cfg.nowMs = [this] { return clockMs; };
    cfg.warn = [this](const std::string &s) { warns.push_back(s); };
    cfg.graphEpoch = [this]() -> std::uint64_t { return epoch; };
    c = std::make_unique<BufferCache>(cfg, [this](const LoadRequest &rq) { return fake(rq); }, r);
  }
  /** Decode `url` (inline) and return its buffer without a reference. */
  const SampleBuffer *load(const std::string &url, int midi = 60, double maxSec = 0) {
    const SampleBuffer *b = nullptr;
    DecodeOpts o;
    o.maxSec = maxSec;
    c->requestJob({url, midi, o}, 1, false, [&](const SampleBuffer *x) { b = x; });
    c->waitIdle();
    return b;
  }
  std::vector<std::string> urls(const std::string &dir, int n) {
    std::vector<std::string> v;
    for (int i = 0; i < n; ++i) v.push_back("/s/" + dir + "/" + std::to_string(i) + ".mp3");
    return v;
  }
};

}  // namespace

TEST_SUITE("samples_cache") {
  TEST_CASE("preloadAndLRU: pinned set survives an over-cap decode of other content") {
    Rig r(100 * kK);
    const auto K = r.urls("keys", 4);
    for (auto &u : K) r.fake.sizes[u] = 10 * kK;
    for (auto &u : K) r.load(u);
    r.c->pinAdd(K);
    CHECK(r.c->entryCount() == 4);
    CHECK(r.c->pinnedBytes() == 40 * kK);
    // the cap leaves room for the pinned set + 6 KiB; an unpinned 20 KiB sample over it never evicts the pinned set
    r.c->setCapBytes(r.c->bytes() + 6 * kK);
    r.fake.sizes["/s/other/0.mp3"] = 20 * kK;
    r.load("/s/other/0.mp3");
    for (auto &u : K) CHECK(r.c->has(u));
    CHECK(r.c->decodedMB() > 0);
    // a second unpinned decode evicts the first unpinned one (LRU), still not the pins
    r.fake.sizes["/s/other/1.mp3"] = 20 * kK;
    r.load("/s/other/1.mp3");
    CHECK_FALSE(r.c->has("/s/other/0.mp3"));
    for (auto &u : K) CHECK(r.c->has(u));
  }

  TEST_CASE("pinsUnion: add never unpins the setlist; replace swaps; unpin empties") {
    Rig r;
    const auto K = r.urls("keys", 4);
    const auto M = r.urls("mp3", 1);
    r.c->pin(K.data(), K.size(), "replace");
    CHECK(r.c->pins().size() == 4);
    r.c->pin(M.data(), M.size(), "add");
    CHECK(r.c->pins().size() == 5);
    for (auto &u : K) CHECK(r.c->pins().count(u));
    r.c->pin(M.data(), M.size(), "none");
    CHECK(r.c->pins().size() == 5);
    r.c->pin(M.data(), M.size(), "replace");
    CHECK(r.c->pins().size() == 1);
    r.c->unpin(std::vector<std::string>(r.c->pins().begin(), r.c->pins().end()));
    CHECK(r.c->pins().empty());
  }

  TEST_CASE("pinsLimitedEvict: pins absolute under a low cap, then LRU down to the 85 % low-water mark") {
    Rig r(100000 * kK);
    const auto K = r.urls("k", 4), M = r.urls("m", 2);
    for (auto &u : K) r.fake.sizes[u] = 30 * kK;
    for (auto &u : M) r.fake.sizes[u] = 25 * kK;
    for (auto &u : K) r.load(u);
    r.c->setPins(K);
    for (auto &u : M) r.load(u);
    const std::uint64_t bytesK = 4 * 30 * kK, bytesM = 2 * 25 * kK;
    CHECK(r.c->bytes() == bytesK + bytesM);
    CHECK(r.c->pinnedBytes() == bytesK);
    // estimate counts a shared set once and is exact for decoded keys
    std::vector<std::string> both = K;
    both.insert(both.end(), M.begin(), M.end());
    both.insert(both.end(), K.begin(), K.end());
    auto est = r.c->estimateBytes(both);
    CHECK(est.unknown == 0);
    CHECK(est.bytes == doctest::Approx(static_cast<double>(bytesK + bytesM)));
    CHECK(est.count == 6);
    // everything pinned and a cap below the total: nothing can go
    r.c->setPins(both);
    r.c->setCapBytes(bytesK + bytesM / 2);
    CHECK(r.c->bytes() == bytesK + bytesM);
    // pins limited to M: K goes LRU-first, down to the low-water mark (not all of it)
    r.c->setPins(M);
    int kLeft = 0;
    for (auto &u : K) kLeft += r.c->has(u);
    CHECK(kLeft > 0);
    CHECK(kLeft < 4);
    CHECK(static_cast<double>(r.c->bytes()) <= r.c->lowWaterBytes());
    // a cap M alone fills: every unpinned buffer goes, pinned stay
    r.c->setCapBytes(bytesM);
    for (auto &u : K) CHECK_FALSE(r.c->has(u));
    for (auto &u : M) CHECK(r.c->has(u));
    CHECK(r.c->bytes() == bytesM);
    // sizes remembered after eviction: the estimate is still exact
    auto again = r.c->estimateBytes(K);
    CHECK(again.unknown == 0);
    CHECK(again.bytes == doctest::Approx(static_cast<double>(bytesK)));
  }

  TEST_CASE("switchHeadroom: protect makes the cap hard; pinned buffers of other songs give way, referenced never") {
    Rig r(100 * kK);
    const auto A = r.urls("a", 3), B = r.urls("b", 3), C = r.urls("c", 3);  // 3 songs x 3 x 10 KiB
    for (auto *s : {&A, &B, &C})
      for (auto &u : *s) r.fake.sizes[u] = 10 * kK;
    for (auto &u : A) r.load(u);
    for (auto &u : B) r.load(u);
    std::vector<std::string> pins = A;
    pins.insert(pins.end(), B.begin(), B.end());
    r.c->setPins(pins);
    // before any prepare (protect unset) pins are absolute: even a tiny cap evicts nothing pinned
    r.c->setCapBytes(40 * kK);
    CHECK(r.c->bytes() == 60 * kK);
    CHECK_FALSE(r.c->hasProtect());
    // song A plays (referenced), song C arrives: protect = A + C
    std::vector<const SampleBuffer *> held;
    for (auto &u : A) held.push_back(r.c->acquire(u));
    std::vector<std::string> prot = A;
    prot.insert(prot.end(), C.begin(), C.end());
    r.c->protect(prot.data(), prot.size());
    r.c->setCapBytes(100 * kK);
    for (auto &u : C) r.load(u);  // 90 KiB: A + B(60 -> must give way) + C ... cap 100
    CHECK(r.c->bytes() <= 100 * kK);
    for (auto &u : A) CHECK(r.c->has(u));  // referenced + protected
    for (auto &u : C) CHECK(r.c->has(u));  // incoming, protected
    int bLeft = 0;
    for (auto &u : B) bLeft += r.c->has(u);
    CHECK(bLeft < 3);  // B's pinned buffers gave way (LRU, just enough)
    CHECK(r.c->evictedPinned() > 0);
    for (auto &u : B) CHECK(r.c->pins().count(u));  // their pins stay: a later re-warm decodes them again
    // gapless: a referenced buffer is never evicted even with the cap far below it
    r.c->setCapBytes(1 * kK);
    for (auto &u : A) CHECK(r.c->has(u));
    for (auto *b : held) r.c->release(b, 0);
    r.c->protect(nullptr, 0);
    CHECK_FALSE(r.c->hasProtect());
  }

  TEST_CASE("sampleRetry: transient failures retry twice, permanent ones once; failure is warned once") {
    Rig r;
    r.fake.failFirst["/x/flaky.wav"] = 1;
    r.fake.transientAlways = {"hang"};
    r.fake.permanent = {"gone"};
    CHECK(r.load("/x/flaky.wav") != nullptr);
    CHECK(r.fake.count("/x/flaky.wav") == 2);
    CHECK(r.load("/x/hang.wav") == nullptr);
    CHECK(r.fake.count("/x/hang.wav") == 3);  // 1 + 2 retries
    CHECK(r.load("/x/gone.wav") == nullptr);
    CHECK(r.fake.count("/x/gone.wav") == 1);
    CHECK(r.warns.size() == 2);
    CHECK(r.c->failed("/x/gone.wav"));
    // a skipped url is not decoded again, and does not warn again
    CHECK(r.load("/x/gone.wav") == nullptr);
    CHECK(r.fake.count("/x/gone.wav") == 1);
    CHECK(r.warns.size() == 2);
    // transient failure: skipped for 30 s, then tried again
    r.clockMs = 29000;
    CHECK(r.load("/x/hang.wav") == nullptr);
    CHECK(r.fake.count("/x/hang.wav") == 3);
    r.clockMs = 31000;
    r.fake.transientAlways.clear();
    CHECK(r.load("/x/hang.wav") != nullptr);
    CHECK_FALSE(r.c->failed("/x/hang.wav"));
    // a missing file costs nothing in an estimate
    CHECK(r.c->estimateBytes({"/x/gone.wav"}).bytes == 0);
  }

  TEST_CASE("one byte unit: int16 storage counts 2 bytes per sample everywhere (SETUP_REVIEW 20)") {
    Rig f(1000 * kK, Storage::F32), h(1000 * kK, Storage::I16);
    f.fake.sizes["/s/a.mp3"] = h.fake.sizes["/s/a.mp3"] = 40 * kK;
    const SampleBuffer *bf = f.load("/s/a.mp3");
    const SampleBuffer *bh = h.load("/s/a.mp3");
    REQUIRE(bf);
    REQUIRE(bh);
    CHECK(bf->bytes == 40 * kK);
    CHECK(bh->bytes == 20 * kK);
    CHECK(bf->f32[0] != nullptr);
    CHECK(bh->i16[0] != nullptr);
    CHECK(bh->f32[0] == nullptr);
    CHECK(h.c->decodedMB() == doctest::Approx(f.c->decodedMB() / 2));
    // the estimate of a never-decoded sample is the 1.75 MB float32 default scaled to the storage
    CHECK(f.c->estimateBytes({"/s/zzz/new.mp3"}).bytes == doctest::Approx(1.75 * 1024 * 1024));
    CHECK(h.c->estimateBytes({"/s/zzz/new.mp3"}).bytes == doctest::Approx(0.875 * 1024 * 1024));
    // capMB is in stored bytes: 320 MB means 320 MB of resident int16 data (about 640 MB of float32)
    BufferCache::Config cfg;
    cfg.capBytes = 320ull * 1024 * 1024;
    cfg.storage = Storage::I16;
    BufferCache ipad(cfg, [](const LoadRequest &) { return LoadOutcome{}; }, nullptr);
    CHECK(ipad.capMB() == doctest::Approx(320.0));
    CHECK(ipad.bytesPerSample() == 2);
    // quantisation of the int16 copy: within half an LSB of the float original (scale 1/32768)
    CHECK(bh->i16Scale == doctest::Approx(1.0 / 32768.0));
    CHECK(static_cast<double>(bh->i16[0][5]) * static_cast<double>(bh->i16Scale) ==
          doctest::Approx(0.25).epsilon(1e-4));
  }

  TEST_CASE("int16 storage keeps over-range buffers by growing the scale") {
    Processed p;
    p.channels = 1;
    p.frames = 4;
    p.ch[0] = {0.0f, 1.5f, -2.0f, 0.5f};
    auto s = makeStored(p, 44100, Storage::I16);
    CHECK(s->i16Scale == doctest::Approx(2.0f / 32767.0f));
    CHECK(s->i16[0][2] == -32767);
    CHECK(static_cast<double>(s->i16[0][1]) * static_cast<double>(s->i16Scale) == doctest::Approx(1.5).epsilon(1e-3));
  }

  TEST_CASE("sustain variants: key collapse once the natural length is known, stand-in and supersede") {
    Rig r(100000 * kK);
    const std::string u = "/s/long/C4.mp3";
    r.fake.sizes[u] = 40 * kK;                      // 10240 frames at 44.1 kHz: shorter than both caps
    CHECK(r.c->keyOf(u, 60, 30) == u + "#max=30");  // length unknown: a separate long key
    r.load(u, 60, 30);                              // decodes the long variant; meta learned
    CHECK(r.c->keyOf(u, 60, 30) == u);              // both caps give the same buffer: shared key
    CHECK(r.c->has(u));
    CHECK(r.c->entryCount() == 1);
    // a truncated sample (longer than the legacy 16 s cap at 44.1 kHz) keeps two keys
    const std::string v = "/s/long/C3.mp3";
    r.fake.sizes[v] = 4 * 44100ull * 20;  // 20 s mono float32
    r.fake.natural = 20 * 44100;
    r.load(v, 60, 30);
    CHECK(r.c->keyOf(v, 60, 30) == v + "#max=30");
    CHECK(r.c->has(v + "#max=30"));
    CHECK_FALSE(r.c->has(v));
    // the long buffer answers for the legacy key after a legacy-cap request (neighbour preload) without decoding
    const int before = r.fake.count(v);
    const SampleBuffer *legacy = r.load(v, 60, 0);
    CHECK(legacy != nullptr);
    CHECK(r.fake.count(v) == before);
    CHECK(r.c->has(v));  // stand-in
    CHECK(r.c->peek(v) == r.c->peek(v + "#max=30"));
    // pins on the legacy key hold the long buffer
    r.c->setPins({v});
    CHECK(r.c->pinnedBytes() == 4 * 44100ull * 20);
    // estimateBytes: the legacy key costs the long buffer, counted once with the long key
    auto est = r.c->estimateBytes({v, v + "#max=30"});
    CHECK(est.count == 1);
  }

  TEST_CASE("epoch: an evicted buffer is freed only after the graph passed its release epoch + 1") {
    Rig r(1000 * kK);
    r.fake.sizes["/s/e/0.mp3"] = 10 * kK;
    r.load("/s/e/0.mp3");
    const SampleBuffer *b = r.c->acquire("/s/e/0.mp3");
    REQUIRE(b);
    r.c->release(b, 5);  // detached at control epoch 5
    r.epoch = 5;
    r.c->setPins({});
    r.c->setCapBytes(1);  // evict it
    CHECK_FALSE(r.c->has("/s/e/0.mp3"));
    CHECK(r.c->bytes() == 0);          // accounting drops at eviction
    CHECK(r.c->graveyardSize() == 1);  // memory is still there: the audio thread may read it
    CHECK(b->f32[0][0] == 0.25f);      // still valid
    r.epoch = 6;
    CHECK(r.c->collect() == 0);
    r.epoch = 7;
    CHECK(r.c->collect() == 1);
    CHECK(r.c->graveyardSize() == 0);
  }

  TEST_CASE("acquire/release counting and referenced bytes") {
    Rig r(1000 * kK);
    r.fake.sizes["/s/r/0.mp3"] = 10 * kK;
    r.load("/s/r/0.mp3");
    CHECK(r.c->referencedBytes() == 0);
    const SampleBuffer *a = r.c->acquire("/s/r/0.mp3");
    const SampleBuffer *b = r.c->acquire("/s/r/0.mp3");
    CHECK(a == b);
    CHECK(r.c->referencedBytes() == 10 * kK);
    r.c->release(a, 0);
    CHECK(r.c->referencedBytes() == 10 * kK);
    r.c->release(b, 0);
    CHECK(r.c->referencedBytes() == 0);
    CHECK(r.c->acquire("/s/nope.mp3") == nullptr);
  }

  TEST_CASE("invalidate: user failure marks and unreferenced buffers go, referenced and factory ones stay") {
    Rig r(1000 * kK);
    r.fake.permanent = {"uA4"};
    r.fake.sizes["/user/keys/C4.wav"] = 10 * kK;
    r.fake.sizes["/user/keys/uB4.wav"] = 10 * kK;
    r.fake.sizes["/factory/C4.mp3"] = 10 * kK;
    r.load("/user/keys/C4.wav");
    r.load("/user/keys/uB4.wav");
    r.load("/factory/C4.mp3");
    r.load("/user/keys/uA4.wav");  // permanent failure
    CHECK(r.c->failed("/user/keys/uA4.wav"));
    const SampleBuffer *held = r.c->acquire("/user/keys/C4.wav");
    auto res = r.c->invalidate({"/user/keys/C4.wav", "/user/keys/uB4.wav", "/user/keys/uA4.wav"});
    CHECK(res.failed == 1);
    CHECK(res.dropped == 1);  // uB4; C4 is referenced by a live instrument
    CHECK_FALSE(r.c->failed("/user/keys/uA4.wav"));
    CHECK(r.c->has("/user/keys/C4.wav"));
    CHECK_FALSE(r.c->has("/user/keys/uB4.wav"));
    CHECK(r.c->has("/factory/C4.mp3"));
    r.c->release(held, 0);
  }

  TEST_CASE("trimUnpinned and trim levels (low resource, memory pressure)") {
    Rig r(1000 * kK);
    const auto A = r.urls("a", 2), B = r.urls("b", 2), C = r.urls("c", 2);
    for (auto *s : {&A, &B, &C})
      for (auto &u : *s) r.load(u);
    r.c->setPins(B);
    const SampleBuffer *ref = r.c->acquire(A[0]);
    r.c->trim(1);           // drop unpinned, unreferenced
    CHECK(r.c->has(A[0]));  // referenced
    CHECK_FALSE(r.c->has(A[1]));
    CHECK_FALSE(r.c->has(C[0]));
    CHECK(r.c->has(B[0]));  // pinned
    r.c->trim(2);           // critical: pinned buffers beyond the current song go too
    CHECK_FALSE(r.c->has(B[0]));
    CHECK(r.c->has(A[0]));
    CHECK(r.c->pins().count(B[0]));  // pins stay
    r.c->release(ref, 0);
  }

  TEST_CASE("engine rate change: stale buffers leave the lookup path, referenced ones live until released") {
    Rig r(1000 * kK);
    r.fake.sizes["/s/q/0.mp3"] = 10 * kK;
    r.fake.sizes["/s/q/1.mp3"] = 10 * kK;
    r.load("/s/q/0.mp3");
    r.load("/s/q/1.mp3");
    const SampleBuffer *held = r.c->acquire("/s/q/0.mp3");
    CHECK(held->sampleRate == 44100);
    r.c->setEngineRate(48000);
    CHECK_FALSE(r.c->has("/s/q/0.mp3"));
    CHECK_FALSE(r.c->has("/s/q/1.mp3"));
    CHECK(r.c->referencedBytes() == 10 * kK);  // the live instrument still reads the old buffer
    CHECK(held->f32[0][0] == 0.25f);
    const SampleBuffer *fresh = r.load("/s/q/0.mp3");
    REQUIRE(fresh);
    CHECK(fresh->sampleRate == 48000);
    CHECK(fresh != held);
    r.c->release(held, 0);
    CHECK(r.c->referencedBytes() == 0);
    // remembered sizes follow the rate (an estimate stays exact: 48000 / 44100)
    CHECK(r.c->estimateBytes({"/s/q/1.mp3"}).bytes == doctest::Approx(10.0 * kK * 48000 / 44100));
  }

  TEST_CASE("worker pool: concurrent requests of one key decode once, callbacks run on pump()") {
    ThreadPool pool(2);
    Rig r(1000 * kK, Storage::F32, &pool);
    std::atomic<int> woke{0};
    int got = 0;
    const SampleBuffer *first = nullptr;
    for (int i = 0; i < 4; ++i)
      r.c->requestJob({"/s/p/0.mp3", 60, {}}, 1, false, [&](const SampleBuffer *b) {
        ++got;
        if (!first) first = b;
        CHECK(b == first);
      });
    r.c->requestJob({"/s/p/1.mp3", 60, {}}, 0, true, [&](const SampleBuffer *b) {
      ++got;
      CHECK(b != nullptr);
      r.c->release(b, 0);
    });
    CHECK(got == 0);  // nothing is delivered before the control thread pumps
    r.c->waitIdle();
    CHECK(got == 5);
    CHECK(r.fake.count("/s/p/0.mp3") == 1);
    CHECK(r.c->entryCount() == 2);
    (void)woke;
  }
}
