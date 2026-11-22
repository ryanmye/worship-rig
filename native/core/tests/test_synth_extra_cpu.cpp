// T15 / DECISIONS D4: per-voice CPU of every synth-extra patch and organ preset with 16 slots holding notes (the
// held-pedal worst case), measured as unit.voice-limit-cpu measures the synth.js voices (thread CPU time, 48 kHz,
// polyphony 128, total voice limit off). Reported (MESSAGE) for ARCHITECTURE 7.1; asserted only loosely (a shared
// 2-CPU box): every voice under 100 us per 128-frame quantum outside sanitizers.
#include <time.h>

#include <string>
#include <vector>

#include "helpers.h"

using rigtest::contains;
using rigtest::OfflineEngine;

namespace {

#if defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__)
constexpr bool kSanitized = true;
#elif defined(__has_feature)
#if __has_feature(address_sanitizer) || __has_feature(thread_sanitizer) || __has_feature(undefined_behavior_sanitizer)
constexpr bool kSanitized = true;
#else
constexpr bool kSanitized = false;
#endif
#else
constexpr bool kSanitized = false;
#endif

double threadUs() {
  timespec ts{};
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
  return static_cast<double>(ts.tv_sec) * 1e6 + static_cast<double>(ts.tv_nsec) / 1e3;
}

void song16(OfflineEngine &e, const std::string &type, const std::string &id) {
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
  std::string p = R"({"slots":[)";
  for (int i = 0; i < 16; ++i)
    p += (i ? "," : "") + std::string(R"({"instrument":{"type":")") + type + R"(","id":")" + id +
         R"("},"gain":0.3,"mono":"off"})";
  p += "]}";
  const std::string r = e.call(R"({"v":1,"op":"prepare","id":3,"patch":)" + p + "}");
  REQUIRE(contains(r, "\"token\":"));
  const std::size_t at = r.find("\"token\":") + 8;
  const std::string token = r.substr(at, r.find_first_of(",}", at) - at);
  REQUIRE(contains(e.call(R"({"v":1,"op":"commit","id":4,"token":)" + token + "}"), "\"committed\":true"));
  REQUIRE(contains(e.call(R"({"v":1,"op":"config","id":5,"polyphony":128,"voiceLimit":0})"), "\"ok\":true"));
}

double perQuantum(OfflineEngine &e, int notes, int quanta = 200) {
  std::string batch = "[";
  for (int i = 0; i < notes; ++i)
    batch += (i ? "," : "") + std::string(R"({"v":1,"op":"play","e":"on","vel":100,"n":)") +
             std::to_string(48 + i) + "}";
  if (notes) e.post(batch + "]");
  e.render(128 * 40);
  std::vector<float> l(128), r(128);
  float *p[2] = {l.data(), r.data()};
  const double t0 = threadUs();
  for (int i = 0; i < quanta; ++i) rig_offline_render(e.e, p, 2, 128);
  return (threadUs() - t0) / quanta;
}

}  // namespace

TEST_SUITE("synth-extra-cpu") {
  TEST_CASE("D4: per-voice cost of every synth-extra patch and organ preset, 16 held slots (ARCHITECTURE 7.1)") {
    struct K {
      const char *type, *id;
    };
    const K kinds[] = {{"synth", "supersaw-pad"}, {"synth", "juno-pad"},    {"synth", "shimmer-pad"},
                       {"synth", "dx-epiano"},    {"synth", "pluck"},       {"synth", "poly-stab"},
                       {"synth", "analog-brass"}, {"synth", "square-lead"}, {"synth", "808-sub"},
                       {"synth", "synth-bass"},   {"organ", "gospel"},      {"organ", "soft-pad"},
                       {"organ", "full"},         {"organ", "church"}};
    double worst = 0;
    std::string worstId;
    for (const K &k : kinds) {
      double t0, t8;
      {
        OfflineEngine e;
        song16(e, k.type, k.id);
        t0 = perQuantum(e, 0);
      }
      {
        OfflineEngine e;
        song16(e, k.type, k.id);
        t8 = perQuantum(e, 8);
      }
      const double per = (t8 - t0) / 128;
      MESSAGE(k.type << ":" << k.id << ": 16 slots idle " << t0 << " us, 16 x 8 held " << t8 << " us per quantum -> "
                     << per << " us per voice");
      if (per > worst) {
        worst = per;
        worstId = k.id;
      }
      if (!kSanitized) CHECK(per < 100);
    }
    MESSAGE("costliest T15 voice: " << worstId << " " << worst << " us per 128-frame quantum");
    CHECK(worst > 0);
  }
}
