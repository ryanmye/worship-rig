#include <atomic>
#include <thread>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "runtime/command.h"
#include "runtime/mpsc.h"
#include "runtime/seqlock.h"
#include "runtime/spsc.h"

using namespace rig;

TEST_SUITE("queues") {
  TEST_CASE("POD layouts are frozen") {
    CHECK(sizeof(Command) == 64);
    CHECK(sizeof(AudioEvent) == 32);
  }

  TEST_CASE("spsc: fifo order, full and empty") {
    SpscQueue<int, 8> q;
    int v;
    CHECK(!q.pop(v));
    for (int i = 0; i < 8; ++i) CHECK(q.push(i));
    CHECK(!q.push(99));
    CHECK(q.size() == 8);
    for (int i = 0; i < 8; ++i) {
      REQUIRE(q.pop(v));
      CHECK(v == i);
    }
    CHECK(q.empty());
    for (int round = 0; round < 100; ++round) {  // wrap-around
      CHECK(q.push(round));
      REQUIRE(q.pop(v));
      CHECK(v == round);
    }
  }

  TEST_CASE("spsc: two threads, 2M items, strict order, no loss") {
    SpscQueue<std::uint64_t, 1024> q;
    constexpr std::uint64_t N = 2'000'000;
    std::thread prod([&] {
      for (std::uint64_t i = 0; i < N;) {
        if (q.push(i)) ++i;
      }
    });
    std::uint64_t expect = 0;
    bool ordered = true;
    while (expect < N) {
      std::uint64_t v;
      if (q.pop(v)) {
        if (v != expect) ordered = false;
        ++expect;
      }
    }
    prod.join();
    CHECK(ordered);
    CHECK(q.empty());
  }

  TEST_CASE("mpsc: 4 producers, every item delivered exactly once, per-producer order kept") {
    MpscQueue<std::uint64_t, 1024> q;
    constexpr std::uint64_t per = 200'000;
    std::vector<std::thread> th;
    for (std::uint64_t p = 0; p < 4; ++p)
      th.emplace_back([&, p] {
        for (std::uint64_t i = 0; i < per;) {
          if (q.push((p << 32) | i)) ++i;
        }
      });
    std::uint64_t next[4] = {0, 0, 0, 0}, got = 0;
    bool ok = true;
    while (got < 4 * per) {
      std::uint64_t v;
      if (!q.pop(v)) continue;
      const std::uint64_t p = v >> 32, i = v & 0xffffffffu;
      if (next[p] != i) ok = false;
      ++next[p];
      ++got;
    }
    for (auto &t : th) t.join();
    CHECK(ok);
  }

  TEST_CASE("seqlock: reader never sees a torn snapshot") {
    struct Snap {
      std::uint64_t a, b, c, d;
    };
    Seqlock<Snap> lock;
    std::atomic<bool> stop{false};
    std::thread w([&] {
      for (std::uint64_t i = 1; !stop.load(); ++i) lock.write({i, i, i, i});
    });
    bool torn = false;
    for (int i = 0; i < 200000; ++i) {
      const Snap s = lock.read();
      if (s.a != s.b || s.b != s.c || s.c != s.d) torn = true;
    }
    stop = true;
    w.join();
    CHECK(!torn);
  }
}
