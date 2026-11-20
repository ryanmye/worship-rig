// DECISIONS D4 (engine-wide voice limit), CPU side: the per-voice cost of every synth.js patch with 16 slots holding
// notes (the held-pedal worst case: nothing released), the fit behind the 'auto' numbers (inst/voice_alloc.h,
// ARCHITECTURE 7.1 "D4"), and the budget check: 16 slots of the costliest patch played far past the limit stay at the
// limit and inside the 128-frame quantum on this box. Timing is thread CPU time (a loaded shared box measures the
// DSP, not the scheduler); the budget assertion is skipped under sanitizers.
#include <time.h>

#include <algorithm>
#include <string>
#include <vector>

#include "api/engine.h"
#include "helpers.h"
#include "inst/voice_alloc.h"

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

constexpr double kQuantumUs = 128.0 / 48000 * 1e6;  // 2667 us

double threadUs() {
  timespec ts{};
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
  return static_cast<double>(ts.tv_sec) * 1e6 + static_cast<double>(ts.tv_nsec) / 1e3;
}

/** hello + audio start + a 16-slot song of one synth patch; polyphony 128; `limit` = the config value (JSON). */
void song16(OfflineEngine &e, const std::string &id, const std::string &limit) {
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
  std::string p = R"({"slots":[)";
  for (int i = 0; i < 16; ++i)
    p += (i ? "," : "") + std::string(R"({"instrument":{"type":"synth","id":")") + id + R"("},"gain":0.3})";
  p += "]}";
  const std::string r = e.call(R"({"v":1,"op":"prepare","id":3,"patch":)" + p + "}");
  REQUIRE(contains(r, "\"token\":"));
  const std::size_t at = r.find("\"token\":") + 8;
  const std::string token = r.substr(at, r.find_first_of(",}", at) - at);
  REQUIRE(contains(e.call(R"({"v":1,"op":"commit","id":4,"token":)" + token + "}"), "\"committed\":true"));
  REQUIRE(contains(e.call(R"({"v":1,"op":"config","id":5,"polyphony":128,"voiceLimit":)" + limit + "}"),
                   "\"ok\":true"));
}

/** `notes` held notes (each sounds in all 16 slots); returns the mean thread-CPU us per 128-frame quantum. */
double perQuantum(OfflineEngine &e, int notes, int quanta = 300) {
  std::string batch = "[";
  for (int i = 0; i < notes; ++i)
    batch += (i ? "," : "") + std::string(R"({"v":1,"op":"play","e":"on","vel":100,"n":)") +
             std::to_string(36 + i) + "}";
  if (notes) e.post(batch + "]");
  e.render(128 * 40);  // attacks done, steal fades gone
  std::vector<float> l(128), r(128);
  float *p[2] = {l.data(), r.data()};
  const double t0 = threadUs();
  for (int i = 0; i < quanta; ++i) rig_offline_render(e.e, p, 2, 128);
  return (threadUs() - t0) / quanta;
}

rig_meters meters(OfflineEngine &e) {
  rig_meters m{};
  m.struct_size = sizeof m;
  REQUIRE(rig_get_meters(e.e, &m) == RIG_OK);
  return m;
}

}  // namespace

TEST_SUITE("voice-limit-cpu") {
  TEST_CASE("D4 Auto: per-voice cost of every synth.js patch, 16 held slots (fit printed; ARCHITECTURE 7.1)") {
    // t(N) = fixed16 + perVoice * N, N = 16 slots x notes; the limit is off so every voice sounds
    double worst = 0, fixedWorst = 0;
    std::string worstId;
    for (const char *id : {"warm-pad", "glass-pad", "strings", "sub-bass", "soft-keys", "bell"}) {
      double t0, t8;
      {
        OfflineEngine e;
        song16(e, id, "0");
        t0 = perQuantum(e, 0);
      }
      {
        OfflineEngine e;
        song16(e, id, "0");
        t8 = perQuantum(e, 8);
        CHECK(meters(e).voices == 128u);
      }
      const double per = (t8 - t0) / 128;
      MESSAGE(std::string(id) << ": 16 slots idle " << t0 << " us, 16 x 8 held voices " << t8 << " us per quantum -> "
                 << per << " us per voice");
      if (per > worst) {
        worst = per;
        fixedWorst = t0;
        worstId = id;
      }
    }
    const double fit = (0.6 * kQuantumUs - fixedWorst) / worst;
    MESSAGE("costliest voice " << worstId << " " << worst << " us; auto(desktop, this box) = (0.60 x " << kQuantumUs
                               << " - " << fixedWorst << ") / " << worst << " = " << fit
                               << " -> provisional kAutoVoiceLimitDesktop " << rig::inst::kAutoVoiceLimitDesktop
                               << ", iPad (2x slower assumed) " << rig::inst::kAutoVoiceLimitIpad);
    CHECK(worst > 0);
  }

  TEST_CASE("D4 budget: 16 slots of the costliest patch played far past the auto limit stay at it, in budget") {
    // warm-pad = the costliest synth.js voice measured here (strings within 5 %). 16 notes x 16 slots = 256 note-ons;
    // auto (desktop) = 128 sounding at most. Re-measured once on a miss: the box is shared with another build.
    double us = 0;
    unsigned playing = 0;
    for (int attempt = 0; attempt < 2; ++attempt) {
      OfflineEngine e;
      song16(e, "warm-pad", "\"auto\"");
      us = perQuantum(e, 16);
      rig::Engine &en = *reinterpret_cast<rig::Engine *>(e.e);
      playing = meters(e).voices;
      CHECK(en.graph().stats().limitSteals.load() == 256u - rig::inst::kAutoVoiceLimitDesktop);
      if (kSanitized || us < kQuantumUs) break;
    }
    CHECK(playing == rig::inst::kAutoVoiceLimitDesktop);  // the steal fades are long gone: live = playing
    MESSAGE("16 slots x warm-pad at the auto limit (" << playing << " voices): " << us << " us per quantum = "
                                                    << 100 * us / kQuantumUs << " % of the quantum (target <= 60 %)");
    if (!kSanitized) CHECK(us < kQuantumUs);
  }
}
