// T00c scale-out amendment (DECISIONS D1-D3, BUILD_PLAN "T00c"): 16 slots per song, per-slot polyphony cap, host
// buffer sizes through the FIFO, and the memory caps that 16 slots need (sample cache hard cap + pin budget, reverb
// cap over kernels AND slot state, T04 finding 1). The web oracle stays at 4 slots, so slots 4..15 are tested as
// bit-exact copies of the slot-0 path with the test voice (no golden exists for them).
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "api/engine.h"
#include "fx/reverb_service.h"
#include "graph/builtin_units.h"
#include "helpers.h"
#include "meter/meter.h"
#include "samples/buffer_cache.h"
#include "samples/cache_service.h"

using rigtest::contains;
using rigtest::OfflineEngine;

namespace {

#if defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__)
constexpr bool kSanitized = true;
#elif defined(__has_feature)
#if __has_feature(address_sanitizer) || __has_feature(thread_sanitizer)
constexpr bool kSanitized = true;
#else
constexpr bool kSanitized = false;
#endif
#else
constexpr bool kSanitized = false;
#endif

rig::Engine &eng(OfflineEngine &e) {
  return *reinterpret_cast<rig::Engine *>(e.e);
}

/** A test-voice slot (sine, fast attack, long release) or a JSON null. */
std::string slotJson(bool on, double gain = 0.9, double pan = 0.0, double rev = 0.0, double dly = 0.0,
                     double release = 0.2) {
  if (!on) return "null";
  return R"({"instrument":{"type":"test","id":"sine"},"gain":)" + std::to_string(gain) + R"(,"pan":)" +
         std::to_string(pan) + R"(,"sends":{"reverb":)" + std::to_string(rev) + R"(,"delay":)" +
         std::to_string(dly) + R"(},"params":{"attack":0.002,"decay":0.3,"sustain":0.8,"release":)" +
         std::to_string(release) + "}}";
}

/** `n` slot entries; slot i sounds when bit i of `mask` is set. */
std::string patch(int n, std::uint32_t mask, double gain = 0.9, double pan = 0.0, double rev = 0.0,
                  double dly = 0.0, double release = 0.2) {
  std::string s = R"({"slots":[)";
  for (int i = 0; i < n; ++i) s += (i ? "," : "") + slotJson((mask >> i) & 1u, gain, pan, rev, dly, release);
  return s + "]}";
}

/** hello + audio start + prepare/commit of `p` (token = the reply's). */
void song(OfflineEngine &e, const std::string &p, bool start = true) {
  if (start) {
    e.hello();
    e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
  }
  const std::string r = e.call(R"({"v":1,"op":"prepare","id":3,"patch":)" + p + "}");
  REQUIRE(contains(r, "\"token\":"));
  const std::size_t at = r.find("\"token\":") + 8;
  const std::string token = r.substr(at, r.find_first_of(",}", at) - at);
  REQUIRE(contains(e.call(R"({"v":1,"op":"commit","id":4,"token":)" + token + "}"), "\"committed\":true"));
}

rig_meters meters(OfflineEngine &e) {
  rig_meters m{};
  m.struct_size = sizeof m;
  REQUIRE(rig_get_meters(e.e, &m) == RIG_OK);
  return m;
}

std::size_t count(const std::string &s, const std::string &needle) {
  std::size_t n = 0;
  for (std::size_t p = s.find(needle); p != std::string::npos; p = s.find(needle, p + needle.size())) ++n;
  return n;
}

}  // namespace

TEST_SUITE("t00c") {
  TEST_CASE("D3: a 16-slot song attaches 16 instruments + strips; meters, state and tick cover all 16 slots") {
    OfflineEngine e;
    song(e, patch(16, 0xffffu));
    rig::Model &m = eng(e).model();
    for (std::size_t i = 0; i < rig::kChannels; ++i) {
      INFO("slot " << i);
      CHECK(m.attachedKind(rig::instSlot(i)) == "inst.test");
      CHECK(m.attachedKind(rig::stripSlot(i)) == "strip");
    }
    const std::string st = e.call(R"({"v":1,"op":"get","what":"state","id":5})");
    CHECK(contains(st, "\"slotCount\":16"));
    CHECK(contains(st, "\"polyphony\":64"));
    CHECK(count(st, "\"present\":true") == 16);
    e.call(R"({"v":1,"op":"config","id":6,"meters":{"slots":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]}})");
    e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":100})");
    e.render(9600);
    const rig_meters mt = meters(e);
    CHECK(mt.struct_size == sizeof(rig_meters));
    CHECK(mt.slot_count == 16);
    for (int i = 0; i < 16; ++i) {
      INFO("slot " << i);
      CHECK(mt.slot_peak_all[i] > 0.1f);
      CHECK(mt.slot_peak_all[i] == mt.slot_peak_all[0]);  // identical paths, identical numbers
      CHECK(mt.slot_rms_all[i] == mt.slot_rms_all[0]);
      CHECK(mt.slot_retiring[i] == 0);
    }
    for (int i = 0; i < 4; ++i) CHECK(mt.slot_peak[i] == mt.slot_peak_all[i]);  // API 1.0 mirror
    CHECK(mt.voices == 16);
    const std::string tick = eng(e).buildTick(false);
    const std::size_t a = tick.find("\"slots\":[");
    REQUIRE(a != std::string::npos);
    const std::string arr = tick.substr(a, tick.find("]]", a) + 2 - a);
    CHECK(count(arr, "[") == 17);  // the outer array + 16 [peak, rms] pairs
  }

  TEST_CASE("D3: rig_meters is struct_size-versioned (an API 1.0 caller gets the 80-byte 4-slot layout)") {
    OfflineEngine e;
    song(e, patch(4, 0x1u));
    e.call(R"({"v":1,"op":"play","e":"on","n":60,"vel":100})");
    e.render(4800);
    alignas(rig_meters) unsigned char buf[sizeof(rig_meters) + 16];
    std::memset(buf, 0xab, sizeof buf);
    auto *m = reinterpret_cast<rig_meters *>(buf);
    m->struct_size = RIG_METERS_SIZE_V1;
    REQUIRE(rig_get_meters(e.e, m) == RIG_OK);
    CHECK(m->struct_size == 80u);
    CHECK(m->slot_peak[0] > 0.1f);
    for (std::size_t i = RIG_METERS_SIZE_V1; i < sizeof buf; ++i) CHECK(buf[i] == 0xab);  // nothing written past
    const rig_meters full = meters(e);
    CHECK(full.slot_count == 4);
    CHECK(full.slot_peak_all[0] == m->slot_peak[0]);
  }

  TEST_CASE("D3: slots 4..15 render bit-exactly like slot 0 (strip, pan, sends, sum)") {
    auto renderOnly = [](int k) {
      OfflineEngine e(48000);
      song(e, patch(16, 1u << k, 0.7, -0.4, 0.3, 0.2));
      e.call(R"({"v":1,"op":"play","e":"on","n":64,"vel":90})");
      auto out = e.render(14400, 441);
      e.call(R"({"v":1,"op":"play","e":"off","n":64})");
      auto tail = e.render(9600);
      out[0].insert(out[0].end(), tail[0].begin(), tail[0].end());
      out[1].insert(out[1].end(), tail[1].begin(), tail[1].end());
      return out;
    };
    const auto ref = renderOnly(0);
    double peak = 0;
    for (float x : ref[0]) peak = std::fmax(peak, std::fabs(x));
    CHECK(peak > 0.05);  // not a silent comparison
    for (int k : {1, 4, 7, 12, 15}) {
      INFO("slot " << k);
      const auto o = renderOnly(k);
      CHECK(rigtest::maxAbsDiff(o[0], ref[0]) == 0.0);
      CHECK(rigtest::maxAbsDiff(o[1], ref[1]) == 0.0);
    }
  }

  TEST_CASE("D3: per-slot sets reach slots 10..15; 4-slot songs keep 4 channels; a smaller song detaches the rest") {
    OfflineEngine e;
    song(e, patch(16, 0xffffu));
    CHECK(contains(e.call(R"({"v":1,"op":"set","id":7,"path":"slots.15.gain","value":0.2})"), "\"applied\":true"));
    CHECK(contains(e.call(R"({"v":1,"op":"set","id":8,"path":"slots.10.pan","value":-1})"), "\"applied\":true"));
    CHECK(eng(e).model().patch().slots[15].gain == doctest::Approx(0.2));
    CHECK(eng(e).model().patch().slots[10].pan == -1.0);
    CHECK(contains(e.call(R"({"v":1,"op":"set","id":9,"path":"slots.16.gain","value":0.2})"), "unknown-param"));
    song(e, patch(4, 0x3u), false);
    rig::Model &m = eng(e).model();
    for (std::size_t i = 0; i < 4; ++i) CHECK(m.attachedKind(rig::stripSlot(i)) == "strip");
    for (std::size_t i = 4; i < rig::kChannels; ++i) {
      CHECK(m.attachedKind(rig::stripSlot(i)).empty());
      CHECK(m.attachedKind(rig::instSlot(i)).empty());
    }
    e.call(R"({"v":1,"op":"config","id":6,"meters":{"slots":[0,15]}})");
    const std::string tick = eng(e).buildTick(false);
    const std::size_t a = tick.find("\"slots\":[");
    REQUIRE(a != std::string::npos);
    CHECK(count(tick.substr(a, tick.find("]]", a) + 2 - a), "[") == 5);  // web layout: 4 pairs
    song(e, patch(2, 0x1u), false);  // fewer than 4 entries: still the web engine's 4 channels
    for (std::size_t i = 0; i < 4; ++i) CHECK(m.attachedKind(rig::stripSlot(i)) == "strip");
  }

  TEST_CASE("D3 bridge validation: slot 0..15 everywhere, > 16 slots and out-of-range values are rejected") {
    OfflineEngine e;
    song(e, patch(16, 0x1u));
    CHECK(contains(e.call(R"({"v":1,"op":"config","id":5,"eqAudition":{"slot":15,"mode":"bypass"}})"),
                   "\"eqAudition\":true"));
    CHECK(contains(e.call(R"({"v":1,"op":"config","id":6,"eqAudition":{"slot":16,"mode":"bypass"}})"),
                   "\"eqAudition\":false"));
    CHECK(contains(e.call(R"({"v":1,"op":"prepare","id":7,"patch":)" + patch(17, 0) + "}"), "bad-request"));
    CHECK(contains(e.call(R"({"v":1,"op":"prepare","id":8,"patch":)" + patch(16, 0) + "}"), "\"token\":"));
    e.call(R"({"v":1,"op":"config","id":9,"meters":{"slots":[15,16,-1,3.5]}})");
    auto *ms = rig::MeterServiceImpl::of(eng(e).model());
    REQUIRE(ms != nullptr);
    CHECK(ms->slotSubscribed(15));
    CHECK(!ms->slotSubscribed(16));
    CHECK(!ms->slotSubscribed(3));
    CHECK(contains(e.call(R"({"v":1,"op":"config","id":10,"polyphony":96})"), "bad-request"));
    CHECK(contains(e.call(R"({"v":1,"op":"audio","id":11,"action":"start","bufferFrames":100})"), "bad-request"));
    const std::string h = e.call(R"({"v":1,"op":"hello","protocol":1,"id":12})");
    CHECK(contains(h, "\"minor\":1"));
    CHECK(contains(h, "\"slots16\""));
    CHECK(contains(h, "\"polyphony\""));
    CHECK(contains(h, "\"bufferFrames\""));
  }

  TEST_CASE("D1: the polyphony cap reaches every instrument (attach + config), > 16 held notes sound") {
    OfflineEngine e;
    song(e, patch(1, 0x1u));
    auto playAll = [&](int from, int n) {
      std::string batch = "[";
      for (int i = 0; i < n; ++i)
        batch += (i ? "," : "") + std::string(R"({"v":1,"op":"play","e":"on","vel":100,"n":)") +
                 std::to_string((from + i) % 128) + "}";
      e.post(batch + "]");
      e.render(1280);
    };
    playAll(20, 80);  // 80 held notes, no note-off (what a held pedal does to the voice pool)
    CHECK(meters(e).voices == 64);  // default cap
    CHECK(contains(e.call(R"({"v":1,"op":"config","id":5,"polyphony":128})"), "\"polyphony\":128"));
    playAll(0, 128);
    CHECK(meters(e).voices == 128);
    CHECK(contains(e.call(R"({"v":1,"op":"config","id":6,"polyphony":32})"), "\"polyphony\":32"));
    playAll(0, 4);  // already above the new cap: new notes steal, live voices are not cut (cap enforced at note-on)
    CHECK(meters(e).voices == 128);
    CHECK(contains(e.call(R"({"v":1,"op":"get","what":"state","id":7})"), "\"polyphony\":32"));
    song(e, patch(16, 0xffffu), false);  // fresh instruments get the cap at attach (Op::VoiceCap after AttachUnit)
    e.render(256);
    playAll(30, 40);
    CHECK(meters(e).voices == 16u * 32u);
  }

  TEST_CASE("D1 allocator (test voice, the reference for T11/T12): free first, then oldest released, oldest held") {
    rig::SlotSpec sp;
    sp.inst = rig::InstKind::TestSine;
    rig::TestInstrument ti(sp, 48000);
    CHECK(ti.voiceCap() == 64);
    ti.setVoiceCap(32);
    for (int n = 36; n < 68; ++n) ti.noteOn(n, 100, 0.8f, 0);
    CHECK(ti.liveVoices() == 32);
    CHECK(ti.stolen() == 0);
    ti.noteOff(40, 0, false);
    ti.noteOff(37, 0, false);
    ti.noteOn(100, 100, 0.8f, 0);  // at the cap: the oldest RELEASED voice (37, started before 40) goes
    CHECK(ti.stolen() == 1);
    CHECK(ti.voicesOf(37, true) == 0);
    CHECK(ti.voicesOf(40, true) == 1);
    ti.noteOn(101, 100, 0.8f, 0);  // next released: 40
    CHECK(ti.voicesOf(40, true) == 0);
    ti.noteOn(102, 100, 0.8f, 0);  // no released voice left: the oldest held (36)
    CHECK(ti.voicesOf(36, false) == 0);
    CHECK(ti.voicesOf(38, false) == 1);
    CHECK(ti.liveVoices() == 32);
    ti.setVoiceCap(128);
    for (int n = 0; n < 96; ++n) ti.noteOn(n % 128, 100, 0.8f, 0);
    CHECK(ti.liveVoices() == 128);
    const std::uint32_t s0 = ti.stolen();
    ti.noteOn(127, 100, 0.8f, 0);
    CHECK(ti.stolen() == s0 + 1);
    CHECK(ti.liveVoices() == 128);
    ti.setVoiceCap(1000);
    CHECK(ti.voiceCap() == 128);  // pools are sized for 128 (DECISIONS D1)
  }

  TEST_CASE("T08 #1: a strip moved into a retiring channel keeps sounding and metering its origin slot") {
    auto run = [](bool move) {
      OfflineEngine e;
      song(e, patch(4, 1u << 2, 0.8, 0.3, 0.2, 0.0));
      e.call(R"({"v":1,"op":"play","e":"on","n":67,"vel":100})");
      auto a = e.render(9600, 128);
      if (move) {
        rig::Model &m = eng(e).model();
        REQUIRE(m.moveUnit(rig::instSlot(2), rig::retireInstSlot(7), -1.0));
        REQUIRE(m.moveUnit(rig::stripSlot(2), rig::retireStripSlot(7), -1.0));
        CHECK(m.attachedKind(rig::retireStripSlot(7)) == "strip");
        CHECK(m.attachedKind(rig::stripSlot(2)).empty());
        CHECK(!m.moveUnit(rig::stripSlot(2), rig::retireStripSlot(8), -1.0));  // nothing there any more
      }
      auto b = e.render(9600, 128);
      const rig_meters mt = meters(e);
      a[0].insert(a[0].end(), b[0].begin(), b[0].end());
      return std::make_pair(a, mt);
    };
    const auto ref = run(false), mv = run(true);
    CHECK(rigtest::maxAbsDiff(ref.first[0], mv.first[0]) == 0.0);  // the move is inaudible
    CHECK(mv.second.slot_peak_all[2] > 0.1f);
    CHECK(mv.second.slot_peak_all[2] == ref.second.slot_peak_all[2]);  // the origin slot's meter hears it
    CHECK(mv.second.slot_rms_all[2] == ref.second.slot_rms_all[2]);
    CHECK(mv.second.slot_retiring[2] == 1);
    CHECK(ref.second.slot_retiring[2] == 0);
    CHECK(mv.second.voices == 1);
  }

  TEST_CASE("D2: the FIFO turns host blocks of 64/192/256/441/512 frames into the 128-frame render bit-exactly") {
    auto run = [](std::size_t block) {
      OfflineEngine e;
      song(e, patch(4, 0x5u, 0.8, 0.2, 0.3, 0.3));
      e.call(R"({"v":1,"op":"play","e":"on","n":57,"vel":100,"when":0.0101})");
      e.call(R"({"v":1,"op":"play","e":"off","n":57,"when":0.3})");
      return e.render(48000, block);
    };
    const auto ref = run(128);
    double peak = 0;
    for (float x : ref[0]) peak = std::fmax(peak, std::fabs(x));
    CHECK(peak > 0.05);
    for (std::size_t b : {64u, 192u, 256u, 441u, 512u, 1u, 4096u}) {
      INFO("block " << b);
      const auto o = run(b);
      CHECK(rigtest::maxAbsDiff(o[0], ref[0]) == 0.0);
      CHECK(rigtest::maxAbsDiff(o[1], ref[1]) == 0.0);
    }
    CHECK(rig::Engine::fifoResidue(64) == 64);
    CHECK(rig::Engine::fifoResidue(128) == 0);
    CHECK(rig::Engine::fifoResidue(192) == 64);
    CHECK(rig::Engine::fifoResidue(256) == 0);
    CHECK(rig::Engine::fifoResidue(441) == 127);  // worst residue of the cycle, not the first one (71)
    CHECK(rig::Engine::fifoResidue(96) == 96);
    CHECK(rig::Engine::fifoResidue(0) == 0);
    CHECK(rig::Engine::fifoResidue(512) == 0);
  }

  TEST_CASE("memory: the sample cache's hard cap refuses what cannot be evicted; one memory warning") {
    using namespace rig::samples;
    auto loader = [](const LoadRequest &rq) {
      LoadOutcome o;
      Processed p;
      p.channels = 1;
      p.frames = 10 * 1024;  // 40 KiB of float32
      p.ch[0].assign(p.frames, 0.25f);
      p.natural = p.frames;
      o.buffer = makeStored(p, rq.engineRate, rq.storage);
      o.status = LoadOutcome::Status::Ok;
      return o;
    };
    for (bool hard : {false, true}) {
      INFO("hard cap " << hard);
      BufferCache::Config cfg;
      cfg.capBytes = 100 * 1024;
      cfg.hardCapBytes = hard ? cfg.capBytes : 0;
      int warns = 0;
      cfg.warnMemory = [&](const std::string &) { ++warns; };
      BufferCache c(cfg, loader, nullptr);
      std::vector<const rig::SampleBuffer *> held;
      for (const char *u : {"/s/a.wav", "/s/b.wav", "/s/c.wav", "/s/d.wav"})
        c.requestJob({u, 60, {}}, 1, true, [&](const rig::SampleBuffer *b) { held.push_back(b); });
      const auto ok = std::count_if(held.begin(), held.end(), [](const rig::SampleBuffer *b) { return b; });
      if (hard) {
        CHECK(ok == 2);  // 80 KiB referenced; a third would pass the 100 KiB cap
        CHECK(c.capRefused() == 2);
        CHECK(warns == 1);
        CHECK(c.bytes() <= cfg.capBytes);
        CHECK(c.failed("/s/c.wav"));  // transient mark: retried after the window
      } else {
        CHECK(ok == 4);  // 1.x: the cap is soft for referenced buffers
        CHECK(c.bytes() > cfg.capBytes);
        CHECK(warns == 0);
      }
      for (const auto *b : held)
        if (b) c.release(b, 0);
    }
  }

  TEST_CASE("memory: per-profile cache caps and the pin budget (85 % of the hard cap, request order)") {
    for (bool ipad : {false, true}) {
      rig_config cfg;
      rig_config_init(&cfg);
      cfg.mode = RIG_MODE_OFFLINE;
      cfg.flags = RIG_FLAG_TEST_API;
      cfg.profile = ipad ? RIG_PROFILE_IPAD : RIG_PROFILE_DESKTOP;
      std::vector<std::string> msgs;
      cfg.on_event = [](void *u, const char *j, size_t n) {
        static_cast<std::vector<std::string> *>(u)->emplace_back(j, n);
      };
      cfg.event_user = &msgs;
      rig_engine *raw = rig_create(&cfg, nullptr);
      REQUIRE(raw != nullptr);
      auto *cs = dynamic_cast<rig::samples::CacheServiceImpl *>(
          reinterpret_cast<rig::Engine *>(raw)->model().service<rig::CacheService>());
      REQUIRE(cs != nullptr);
      const std::uint64_t cap = (ipad ? 320ull : 700ull) << 20;
      CHECK(cs->cache().capBytes() == cap);
      CHECK(cs->cache().hardCapBytes() == (ipad ? cap : cap / 2 * 3));
      // unknown keys are estimated at the default sample size (1.75 MB f32, 0.875 MB int16)
      const double each = cs->cache().defaultSampleBytes();
      const std::size_t fit = static_cast<std::size_t>(0.85 * static_cast<double>(cs->cache().hardCapBytes()) / each);
      std::vector<std::string> keys;
      for (std::size_t i = 0; i < fit + 25; ++i) keys.push_back("/pins/s" + std::to_string(i) + ".wav");
      const auto kept = cs->withinPinBudget(keys, false);
      CHECK(kept.size() == fit);
      CHECK(kept.front() == keys.front());  // request order: the next song's samples first
      CHECK(kept.back() == keys[fit - 1]);
      CHECK(contains(cs->statsFields(), "\"pinsDropped\":25"));
      // T00c review: pins whose decodes have not landed yet still count (back-to-back `preload {pin:'add'}`)
      cs->cache().pinAdd(kept);
      std::vector<std::string> more;
      for (std::size_t i = 0; i < 8; ++i) more.push_back("/pins/more" + std::to_string(i) + ".wav");
      CHECK(cs->withinPinBudget(more, true).empty());
      CHECK(cs->withinPinBudget({keys.front()}, true).size() == 1);  // already pinned: kept, not counted twice
      cs->cache().setPins({});
      const std::string hello = R"({"v":1,"op":"hello","protocol":1,"id":1})";
      rig_post(raw, hello.data(), hello.size());  // flushes the queued events
      bool warned = false;
      for (auto &s : msgs) warned = warned || (contains(s, "\"code\":\"memory\"") && contains(s, "unpinned"));
      CHECK(warned);
      rig_destroy(raw);
    }
  }

  TEST_CASE("memory (T04 finding 1): the reverb cap covers kernels AND slot state on the iPad profile") {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.flags = RIG_FLAG_TEST_API;
    cfg.profile = RIG_PROFILE_IPAD;
    cfg.on_event = [](void *, const char *, size_t) {};
    rig_engine *raw = rig_create(&cfg, nullptr);
    REQUIRE(raw != nullptr);
    rig::Engine &en = *reinterpret_cast<rig::Engine *>(raw);
    auto post = [&](const std::string &s) { rig_post(raw, s.data(), s.size()); };
    post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    post(R"({"v":1,"op":"audio","action":"start","id":2})");
    auto *pool = dynamic_cast<rig::fx::ReverbPool *>(en.model().service("reverb"));
    REQUIRE(pool != nullptr);
    CHECK(pool->maxBytes() == (std::size_t(32) << 20));
    std::vector<float> l(4800), r(4800);
    float *p[2] = {l.data(), r.data()};
    auto renderSec = [&](double s) {
      for (int i = 0; i < static_cast<int>(s * 10); ++i) REQUIRE(rig_offline_render(raw, p, 2, 4800) == RIG_OK);
    };
    renderSec(0.2);
    std::size_t worst = 0, worstKernels = 0, slotState = 0, worstFade = 0;
    const double sizes[] = {0.7, 0.85, 1.0, 0.7, 1.0, 0.85};
    for (double sz : sizes) {
      const rig::fx::ReverbPool::Stage st = pool->stage(sz, 0.5, false);
      pool->waitBuilds();
      pool->commitTo(&st, 0.02, en.model().now());
      for (int k = 0; k < 12; ++k) {  // 0.8 s fade + idle (0.05 s) + margin; sampled during the crossfade too
        renderSec(0.1);
        worstFade = std::max(worstFade, pool->bytes());
      }
      worst = std::max(worst, pool->bytes());
      worstKernels = std::max(worstKernels, pool->kernelBytes());
      slotState = std::max(slotState, pool->bytes() - pool->kernelBytes());
    }
    MESSAGE("iPad reverb after each switch: worst total " << worst / 1048576.0 << " MB (kernels "
                                                          << worstKernels / 1048576.0 << " MB, slot state up to "
                                                          << slotState / 1048576.0
                                                          << " MB), cap 32 MB; during a crossfade "
                                                          << worstFade / 1048576.0 << " MB");
    CHECK(slotState > 0);        // state is counted now
    CHECK(worst <= pool->maxBytes());
    CHECK(worstFade <= pool->maxBytes());  // T00c review: also while two units crossfade (evict at the swap)
    rig_destroy(raw);
  }

  TEST_CASE("CPU per 128-frame quantum: 16 slots (strips + test voices) vs 4 (indicative, this box)") {
    auto perQuantum = [](int slots, int notes) {
      OfflineEngine e;
      song(e, patch(slots, slots >= 32 ? 0xffffffffu : (1u << slots) - 1u));
      std::string batch = "[";
      for (int i = 0; i < notes; ++i)
        batch += (i ? "," : "") + std::string(R"({"v":1,"op":"play","e":"on","vel":100,"n":)") +
                 std::to_string(40 + i) + "}";
      if (notes) e.post(batch + "]");
      e.render(1280);
      const int q = 750;  // 2 s at 48 kHz
      std::vector<float> l(128), r(128);
      float *p[2] = {l.data(), r.data()};
      const auto t0 = std::chrono::steady_clock::now();
      for (int i = 0; i < q; ++i) rig_offline_render(e.e, p, 2, 128);
      return std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / q;
    };
    const double budget = 128.0 / 48000 * 1e6;
    const double s4 = perQuantum(4, 0), s16 = perQuantum(16, 0);
    const double v16x8 = perQuantum(16, 8), v16x64 = perQuantum(16, 64);
    MESSAGE("us per quantum (budget " << budget << " us): 4 slots idle " << s4 << ", 16 slots idle " << s16
                                      << ", 16 slots x 8 test voices " << v16x8 << ", 16 x 64 test voices "
                                      << v16x64);
    if (!kSanitized) CHECK(s16 < budget);  // timing means nothing under ASan / TSan
  }
}

TEST_SUITE("realtime") {
  struct FakeHost {
    static inline std::atomic<rig_engine *> eng{nullptr};
    static inline std::atomic<unsigned> asked{0}, startsV1{0};
    static inline std::atomic<double> lastLatency{0};
    static void started(unsigned frames) {
      rig_device_info info{};
      info.struct_size = sizeof info;
      info.sample_rate = 48000;
      info.channels = 2;
      info.buffer_frames = frames;
      info.output_latency_sec = 0.003;
      info.device_id = "fake";
      rig_host_audio_started(eng.load(), &info);
    }
  };

  struct Rt {
    rig_engine *e = nullptr;
    std::mutex mu;
    std::string all;
    explicit Rt(const rig_host *h = nullptr) {
      rig_config cfg;
      rig_config_init(&cfg);
      cfg.mode = RIG_MODE_REALTIME;
      cfg.sample_rate = 48000;
      cfg.host = h;
      cfg.on_event = [](void *u, const char *j, size_t n) {
        auto *r = static_cast<Rt *>(u);
        std::lock_guard<std::mutex> lk(r->mu);
        r->all.append(j, n);
      };
      cfg.event_user = this;
      e = rig_create(&cfg, nullptr);
    }
    ~Rt() { rig_destroy(e); }
    void post(const std::string &m) { REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK); }
    bool waitFor(const std::string &needle, int ms = 3000) {
      for (int i = 0; i < ms; ++i) {
        {
          std::lock_guard<std::mutex> lk(mu);
          if (all.find(needle) != std::string::npos) return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      return false;
    }
    void clear() {
      std::lock_guard<std::mutex> lk(mu);
      all.clear();
    }
  };

  TEST_CASE("D2: bufferFrames reaches the host (audio_start_frames, or as latency for a 1.0 host); grant reported") {
    rig_host h{};
    h.struct_size = sizeof h;
    h.audio_start = [](void *, const char *, double, uint32_t) { FakeHost::started(999); };  // must not be used
    h.audio_start_frames = [](void *, const char *, double, uint32_t, uint32_t frames) {
      FakeHost::asked = frames;
      FakeHost::started(frames == 128 ? 256 : frames);  // an OS that rounds 128 up to 256 (iPad may)
    };
    h.audio_stop = [](void *) {};
    {
      Rt rt(&h);
      FakeHost::eng = rt.e;
      rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
      rt.post(R"({"v":1,"op":"audio","action":"start","id":2,"bufferFrames":64})");
      REQUIRE(rt.waitFor("\"state\":\"running\""));
      CHECK(FakeHost::asked == 64);
      CHECK(rt.waitFor("\"bufferFrames\":64"));
      CHECK(rt.waitFor("\"latencyMs\":4.33"));  // 3 ms host + 64 frames the FIFO holds back
      rt.clear();
      rt.post(R"({"v":1,"op":"audio","action":"restart","id":3})");  // the request is kept across restarts
      REQUIRE(rt.waitFor("\"restarted\":true"));
      CHECK(FakeHost::asked == 64);
      rt.clear();
      rt.post(R"({"v":1,"op":"audio","action":"restart","id":4,"bufferFrames":128})");
      REQUIRE(rt.waitFor("\"restarted\":true"));
      CHECK(FakeHost::asked == 128);
      CHECK(rt.waitFor("\"bufferFrames\":256"));  // the granted size, not the requested one
      CHECK(rt.waitFor("\"latencyMs\":3"));      // 256 is a multiple of 128: no FIFO residue
    }
    rig_host v1{};
    v1.struct_size = static_cast<uint32_t>(RIG_HOST_SIZE_V1);  // built against API 1.0: no audio_start_frames
    v1.audio_start = [](void *, const char *, double latency, uint32_t) {
      FakeHost::lastLatency = latency;
      FakeHost::startsV1 = FakeHost::startsV1 + 1;
      FakeHost::started(0);
    };
    v1.audio_stop = [](void *) {};
    {
      Rt rt(&v1);
      FakeHost::eng = rt.e;
      rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
      rt.post(R"({"v":1,"op":"audio","action":"start","id":2,"bufferFrames":256})");
      REQUIRE(rt.waitFor("\"state\":\"running\""));
      CHECK(FakeHost::startsV1 == 1);
      CHECK(FakeHost::lastLatency.load() == doctest::Approx(256.0 / 48000));
      CHECK(rt.waitFor("\"bufferFrames\":256"));  // nothing granted: the request is reported
    }
  }

  TEST_CASE("D2: realtime FIFO at 64/192/256/441/512-frame host blocks: continuous output, frames accounted") {
    for (unsigned block : {64u, 192u, 256u, 441u, 512u}) {
      INFO("block " << block);
      Rt rt;
      REQUIRE(rt.e != nullptr);
      rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
      rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
      REQUIRE(rt.waitFor("\"re\":2"));
      rt.post(R"({"v":1,"op":"prepare","id":3,"patch":)" + patch(4, 0x1u, 0.8) + "}");
      REQUIRE(rt.waitFor("\"token\":1"));
      rt.post(R"({"v":1,"op":"commit","id":4,"token":1})");
      REQUIRE(rt.waitFor("\"committed\":true"));
      rt.post(R"({"v":1,"op":"play","e":"on","n":69,"vel":100})");
      std::vector<float> l(512), r(512), all;
      float *p[2] = {l.data(), r.data()};
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      double worstUs = 0;
      const double t0 = rig_engine_time(rt.e);
      const unsigned calls = 48000u * 3 / 4 / block;  // 0.75 s of audio, paced at ~4x real time
      for (unsigned i = 0; i < calls; ++i) {
        const auto a = std::chrono::steady_clock::now();
        REQUIRE(rig_render(rt.e, p, 2, block, 0) == RIG_OK);
        worstUs = std::max(worstUs, std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - a)
                                        .count());
        all.insert(all.end(), l.begin(), l.begin() + block);
        std::this_thread::sleep_for(std::chrono::microseconds(block * 5));
      }
      const double dt = rig_engine_time(rt.e) - t0;
      // engine time advanced by the frames delivered, within one quantum (the FIFO renders ahead)
      CHECK(dt * 48000 >= calls * block - 1);
      CHECK(dt * 48000 <= calls * block + 128 + 1);
      // the 440 Hz sine of the test voice: no FIFO seam (a seam would jump by far more than one sample step)
      double peak = 0, worstStep = 0;
      for (std::size_t i = 4800; i < all.size(); ++i) {
        peak = std::fmax(peak, std::fabs(all[i]));
        worstStep = std::fmax(worstStep, std::fabs(all[i] - all[i - 1]));
      }
      CHECK(peak > 0.1);
      constexpr double kTwoPi = 6.283185307179586;
      CHECK(worstStep <= peak * kTwoPi * 440 / 48000 * 1.05 + 1e-4);
      MESSAGE("block " << block << ": worst rig_render " << worstUs << " us of " << block / 48.0 * 1000 << " us");
    }
  }

  TEST_CASE("D2 soak: blocks cycling 64/192/256/441/512 with concurrent posts and a rate change (TSan)") {
    Rt rt;
    REQUIRE(rt.e != nullptr);
    rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"re\":2"));
    // 16 sounding slots, short release tails (sanitizer builds render several times slower than real time)
    rt.post(R"({"v":1,"op":"prepare","id":3,"patch":)" + patch(16, 0xffffu, 0.3, 0.0, 0.0, 0.0, 0.02) + "}");
    REQUIRE(rt.waitFor("\"token\":1"));
    rt.post(R"({"v":1,"op":"commit","id":4,"token":1})");
    REQUIRE(rt.waitFor("\"committed\":true"));
    std::atomic<bool> stop{false};
    std::atomic<long> frames{0};
    std::thread host([&] {
      const unsigned blocks[] = {64, 192, 256, 441, 512};
      std::vector<float> l(512), r(512);
      float *p[2] = {l.data(), r.data()};
      bool changed = false;
      for (unsigned i = 0; !stop; ++i) {
        const unsigned n = blocks[(i / 16) % 5];
        rig_render(rt.e, p, 2, n, 0);
        frames += n;
        if (!changed && frames > 48000) {  // a device rate change mid-soak (lock-free hand-off)
          changed = true;
          rig_device_info info{};
          info.struct_size = sizeof info;
          info.sample_rate = 44100;
          info.channels = 2;
          info.buffer_frames = 441;
          rig_host_audio_started(rt.e, &info);
        }
        std::this_thread::sleep_for(std::chrono::microseconds(n * 4));
      }
    });
    // posts until 2 s of audio went through (any build speed), at most 40 s of wall time
    const auto t0 = std::chrono::steady_clock::now();
    for (int k = 0; frames < 96000 && std::chrono::steady_clock::now() - t0 < std::chrono::seconds(40); ++k) {
      const int n = 40 + k % 40, s = k % 16;
      rt.post(R"({"v":1,"op":"play","e":"on","vel":90,"n":)" + std::to_string(n) + "}");
      rt.post(R"({"v":1,"op":"set","path":"slots.)" + std::to_string(s) + R"(.pan","value":)" +
              std::to_string((k % 7) / 3.5 - 1) + "}");
      if (k) rt.post(R"({"v":1,"op":"play","e":"off","n":)" + std::to_string(40 + (k - 1) % 40) + "}");
      if (k % 50 == 25) rt.post(R"({"v":1,"op":"config","polyphony":32})");
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    rt.post(R"({"v":1,"op":"get","what":"stats","id":9})");
    REQUIRE(rt.waitFor("\"re\":9"));
    stop = true;
    host.join();
    CHECK(frames > 48000);
    std::lock_guard<std::mutex> lk(rt.mu);
    const std::size_t at = rt.all.find("\"re\":9");
    const std::string st = rt.all.substr(at, 400);
    CHECK(contains(st, "\"eventsDropped\":0"));
    CHECK(contains(st, "\"heapDropped\":0"));
    CHECK(contains(st, "\"rateChanges\":1"));
    MESSAGE("soak: " << frames.load() << " frames; " << st.substr(0, 200));
  }
}
