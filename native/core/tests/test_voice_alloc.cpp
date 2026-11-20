// inst/voice_alloc.h (T11; reused by T12 / T15): D1 caps, voice.js / instruments.js steal policies, voice ids,
// construction order tie-breaks, eviction when every slot holds a fading voice, no allocation after construction.
#include <vector>

#include "doctest.h"
#include "helpers.h"
#include "inst/voice_alloc.h"
#include "runtime/rt_guard.h"

using rig::inst::StealPolicy;
using rig::inst::VoicePool;
using rig::inst::VoiceState;

namespace {

struct V {
  static int alive;
  int tag;
  explicit V(int t) : tag(t) { ++alive; }
  ~V() { --alive; }
};
int V::alive = 0;

template <class P>
int slotOfNote(P &pool, int note) {
  int s = -1;
  pool.forEach([&](int i, V &) {
    if (pool.meta(i).note == note && pool.meta(i).state != VoiceState::Free) s = i;
  });
  return s;
}

}  // namespace

TEST_SUITE("voice-alloc") {
  TEST_CASE("caps: default 64 (D1), clamp 1..128, 0 = default; pool = 128 + spare slots") {
    VoicePool<V> p;
    CHECK(p.cap() == 64);
    p.setCap(32);
    CHECK(p.cap() == 32);
    p.setCap(500);
    CHECK(p.cap() == 128);
    p.setCap(0);
    CHECK(p.cap() == 64);
    CHECK(VoicePool<V>::capacity() == rig::inst::kVoicePoolSize + rig::inst::kVoiceSpare);
  }

  TEST_CASE("more than 16 notes under the pedal: all sound up to the cap, then the oldest held is stolen") {
    VoicePool<V> p;
    std::vector<int> faded;
    auto fade = [&](int s) { faded.push_back(p.meta(s).note); };
    for (int n = 0; n < 40; ++n) {  // a pedalled run: held (or released-but-pedalled) notes pile up
      p.makeRoom(n * 0.1, fade);
      p.emplace(n, n * 0.1, n);
    }
    CHECK(p.playing() == 40);  // the web engine (16) would have stolen 24 by now
    CHECK(faded.empty());
    for (int n = 40; n < 70; ++n) {
      p.makeRoom(n * 0.1, fade);
      p.emplace(n, n * 0.1, n);
    }
    CHECK(p.playing() == 64);
    REQUIRE(faded.size() == 6);
    for (int i = 0; i < 6; ++i) CHECK(faded[i] == i);
    CHECK(p.steals() == 6);
  }

  TEST_CASE("voice.js policy: the earliest-released voice released by `when` first, else the oldest") {
    VoicePool<V> p;
    p.setCap(3);
    std::vector<int> faded;
    auto fade = [&](int s) { faded.push_back(p.meta(s).note); };
    p.emplace(1, 0.0, 1);
    p.emplace(2, 0.1, 2);
    p.emplace(3, 0.2, 3);
    p.markReleased(slotOfNote(p, 3), 0.3);
    p.markReleased(slotOfNote(p, 2), 0.5);  // released later than 3, but in the future at `when` 0.4
    p.makeRoom(0.4, fade);
    REQUIRE(faded.size() == 1);
    CHECK(faded[0] == 3);
    p.emplace(4, 0.4, 4);
    faded.clear();
    p.makeRoom(0.45, fade);  // 2 is released only at 0.5: not eligible yet -> oldest playing (1)
    REQUIRE(faded.size() == 1);
    CHECK(faded[0] == 1);
  }

  TEST_CASE("instruments.js BasicAllocator policy (sampler): any released voice first") {
    VoicePool<V> p(StealPolicy::AnyReleased);
    p.setCap(2);
    std::vector<int> faded;
    auto fade = [&](int s) { faded.push_back(p.meta(s).note); };
    p.emplace(1, 0.0, 1);
    p.emplace(2, 0.1, 2);
    p.markReleased(slotOfNote(p, 2), 0.9);
    p.makeRoom(0.2, fade);
    REQUIRE(faded.size() == 1);
    CHECK(faded[0] == 2);
  }

  TEST_CASE("ties break by construction order (JS Set insertion order), not by slot index") {
    VoicePool<V> p;
    p.setCap(3);
    std::vector<int> faded;
    auto fade = [&](int s) { faded.push_back(p.meta(s).note); };
    const int a = p.emplace(10, 0.0, 0);
    p.emplace(11, 0.0, 0);
    p.destroy(a);  // slot 0 is free again: the next voice takes it but is newer
    p.emplace(12, 0.0, 0);
    p.emplace(13, 0.0, 0);
    p.makeRoom(0.0, fade);  // all started at 0: the first constructed (11) goes
    REQUIRE(faded.size() == 1);
    CHECK(faded[0] == 11);
    int order[VoicePool<V>::capacity()];
    const unsigned n = p.ordered(order);
    REQUIRE(n == 3);
    CHECK(p.meta(order[0]).note == 11);
    CHECK(p.meta(order[2]).note == 13);
  }

  TEST_CASE("ids: stable while alive, stale after destroy; killed voices do not count; eviction when full") {
    VoicePool<V, 4> p;
    p.setCap(4);
    const int s = p.emplace(60, 0, 1);
    const std::uint32_t id = p.idOf(s);
    CHECK(p.slotOf(id) == s);
    p.destroy(s);
    CHECK(p.slotOf(id) == -1);
    const int s2 = p.emplace(61, 0, 2);
    CHECK(s2 == s);
    CHECK(p.idOf(s2) != id);
    for (int n = 0; n < 3; ++n) p.emplace(62 + n, 0, 3);
    for (int i = 0; i < 4; ++i) p.markKilled(i, 0.1);  // all four still fading: none counts, every slot used
    CHECK(p.playing() == 0);
    CHECK(p.live() == 4);
    int evicted = -1;
    const int s3 = p.emplaceEvicting([&](int x) { evicted = x; }, 70, 0.2, 4);
    CHECK(s3 >= 0);
    CHECK(evicted == s3);
    CHECK(p.meta(s3).note == 70);
    CHECK(p.live() == 4);
    CHECK(V::alive == 4);
  }

  TEST_CASE("no allocation after construction (audio thread)") {
    VoicePool<V> p;
    const long before = rigtest::g_rtAllocs;
    {
      rig::rt::RenderScope rs;
      for (int n = 0; n < 200; ++n) {
        p.makeRoom(n * 0.01, [&](int s) { p.markKilled(s, n * 0.01); });
        const int s = p.emplace(n % 128, n * 0.01, n);
        if (n % 3 == 0) p.markReleased(s, n * 0.01);
        p.forEach([&](int i, V &) {
          if (p.meta(i).state == VoiceState::Killed) p.destroy(i);
        });
      }
    }
    CHECK(rigtest::g_rtAllocs == before);
    CHECK(p.playing() == 64);
  }
}
