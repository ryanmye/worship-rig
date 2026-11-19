// Test helpers: an offline engine with captured events, JSON snippets, analytic references.
#pragma once
#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "doctest.h"
#include "rig/rig_engine.h"

namespace rigtest {

/** Allocation counter of the audio-thread trap (alloc_trap.cpp): allocations made while rt::inRender(). */
extern long g_rtAllocs;

struct OfflineEngine {
  rig_engine *e = nullptr;
  std::vector<std::string> msgs;  // every event/reply delivered so far (batches are kept as one string)

  explicit OfflineEngine(double sr = 48000.0, unsigned flags = RIG_FLAG_TEST_API, unsigned seed = 1) {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.flags = flags;
    cfg.sample_rate = sr;
    cfg.seed = seed;
    cfg.on_event = [](void *u, const char *j, size_t n) { static_cast<OfflineEngine *>(u)->msgs.emplace_back(j, n); };
    cfg.event_user = this;
    e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
  }
  ~OfflineEngine() { rig_destroy(e); }
  OfflineEngine(const OfflineEngine &) = delete;
  OfflineEngine &operator=(const OfflineEngine &) = delete;

  rig_status post(const std::string &m) { return rig_post(e, m.data(), m.size()); }
  /** Post and return everything delivered by this call, joined. */
  std::string call(const std::string &m) {
    msgs.clear();
    post(m);
    std::string all;
    for (auto &s : msgs) all += s;
    return all;
  }
  void hello() { call(R"({"v":1,"op":"hello","protocol":1,"id":1})"); }
  std::vector<std::vector<float>> render(size_t frames, size_t chunk = 0) {
    std::vector<std::vector<float>> out(2, std::vector<float>(frames));
    if (!chunk) chunk = frames;
    for (size_t d = 0; d < frames;) {
      const size_t n = std::min(chunk, frames - d);
      float *p[2] = {out[0].data() + d, out[1].data() + d};
      REQUIRE(rig_offline_render(e, p, 2, static_cast<uint32_t>(n)) == RIG_OK);
      d += n;
    }
    return out;
  }
};

inline bool contains(const std::string &s, const char *needle) {
  return s.find(needle) != std::string::npos;
}

inline double maxAbsDiff(const std::vector<float> &a, const std::vector<float> &b) {
  double m = 0;
  for (size_t i = 0; i < a.size() && i < b.size(); ++i) m = std::fmax(m, std::fabs(double(a[i]) - double(b[i])));
  return m;
}

}  // namespace rigtest
