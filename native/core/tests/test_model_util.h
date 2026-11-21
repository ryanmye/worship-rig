// Helpers of the T13 Model tests (test_model.cpp, test_song.cpp): an offline engine at 44.1 kHz driven through the
// bridge, with direct access to the Model and its SongGraph.
#pragma once
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

#include "api/engine.h"
#include "helpers.h"
#include "rig/rig_engine.h"
#include "model/model.h"
#include "model/song.h"

namespace t13 {

inline constexpr double kSR = 44100;

struct Eng {
  rig_engine *e = nullptr;
  std::vector<std::string> msgs;
  std::vector<float> L, R;  // everything rendered so far

  /** `app` = the app dir (samples/manifest.json) or empty (no sampler catalogue). */
  explicit Eng(bool start = true, double sr = kSR, const std::string &app = "") {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.flags = RIG_FLAG_TEST_API;
    cfg.sample_rate = sr;
    cfg.seed = 7;  // suites.mjs mkEngine
    cfg.app_dir = app.empty() ? nullptr : app.c_str();
    cfg.on_event = [](void *u, const char *j, size_t n) { static_cast<Eng *>(u)->msgs.emplace_back(j, n); };
    cfg.event_user = this;
    e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
    call(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    if (start) call(R"({"v":1,"op":"audio","action":"start","id":2})");
  }
  ~Eng() { rig_destroy(e); }
  Eng(const Eng &) = delete;
  Eng &operator=(const Eng &) = delete;
  std::string call(const std::string &m) {
    msgs.clear();
    rig_post(e, m.data(), m.size());
    std::string all;
    for (auto &x : msgs) all += x;
    return all;
  }
  std::vector<std::vector<float>> render(std::size_t frames, std::size_t chunk) {
    std::vector<std::vector<float>> out(2, std::vector<float>(frames));
    for (std::size_t d = 0; d < frames;) {
      const std::size_t n = std::min(chunk, frames - d);
      float *p[2] = {out[0].data() + d, out[1].data() + d};
      REQUIRE(rig_offline_render(e, p, 2, static_cast<uint32_t>(n)) == RIG_OK);
      d += n;
    }
    return out;
  }
  rig::Engine &engine() { return *reinterpret_cast<rig::Engine *>(e); }
  rig::Model &model() { return engine().model(); }
  rig::SongGraph &sg() { return model().songGraph(); }

  /** prepare -> token (-1 when refused). */
  long prepare(const std::string &patch) {
    const std::string r = call(R"({"v":1,"op":"prepare","id":3,"patch":)" + patch + "}");
    const std::size_t at = r.find("\"token\":");
    return at == std::string::npos ? -1 : std::strtol(r.c_str() + at + 8, nullptr, 10);
  }
  bool commit(long token, double when = -1) {
    std::string m = R"({"v":1,"op":"commit","id":4,"token":)" + std::to_string(token);
    if (when >= 0) m += ",\"when\":" + num(when);
    return rigtest::contains(call(m + "}"), "\"committed\":true");
  }
  bool use(const std::string &patch, double when = -1) { return commit(prepare(patch), when); }
  std::string set(const std::string &path, const std::string &value, double when = -1, double glide = 0) {
    std::string m = R"({"v":1,"op":"set","id":7,"path":")" + path + R"(","value":)" + value;
    if (when >= 0) m += ",\"when\":" + num(when);
    if (glide > 0) m += ",\"glide\":" + num(glide);
    return call(m + "}");
  }
  void on(int n, double when, int vel = 100) {
    call(R"({"v":1,"op":"play","e":"on","n":)" + std::to_string(n) + ",\"vel\":" + std::to_string(vel) +
         ",\"when\":" + num(when) + "}");
  }
  void off(int n, double when) {
    call(R"({"v":1,"op":"play","e":"off","n":)" + std::to_string(n) + ",\"when\":" + num(when) + "}");
  }
  void pedal(bool down, double when) {
    call(std::string(R"({"v":1,"op":"play","e":"pedal","down":)") + (down ? "true" : "false") + ",\"when\":" +
         num(when) + "}");
  }
  /** Render until engine time `t` (in quanta), appending to L/R. */
  void until(double t) {
    const auto want = static_cast<std::size_t>(std::ceil(t * kSR / 128.0)) * 128;
    if (want <= L.size()) return;
    auto o = render(want - L.size(), 128);
    L.insert(L.end(), o[0].begin(), o[0].end());
    R.insert(R.end(), o[1].begin(), o[1].end());
  }
  rig_meters meters() {
    rig_meters m{};
    m.struct_size = sizeof m;
    rig_get_meters(e, &m);
    return m;
  }
  static std::string num(double v) {
    char b[48];
    std::snprintf(b, sizeof b, "%.17g", v);
    return b;
  }
};

/** A slot JSON: instrument type:id, gain, all sends explicit (0 unless given), optional extra fields. */
inline std::string slot(const std::string &type, const std::string &id, double gain = 1,
                        const std::string &extra = "") {
  return R"({"instrument":{"type":")" + type + R"(","id":")" + id + R"("},"gain":)" + Eng::num(gain) +
         R"(,"sends":{"reverb":0,"delay":0,"chorus":0})" + (extra.empty() ? "" : "," + extra) + "}";
}
/** A patch of up to 16 slot JSONs ("null" for empty), plus optional top-level members. */
inline std::string patch(const std::vector<std::string> &slots, const std::string &extra = "") {
  std::string s = R"({"slots":[)";
  for (std::size_t i = 0; i < slots.size(); ++i) s += (i ? "," : "") + slots[i];
  return s + "]" + (extra.empty() ? "" : "," + extra) + "}";
}

inline double rms(const std::vector<float> &d, double a, double b) {
  const auto i0 = static_cast<std::size_t>(a * kSR), i1 = std::min(d.size(), static_cast<std::size_t>(b * kSR));
  double s = 0;
  for (std::size_t i = i0; i < i1; ++i) s += static_cast<double>(d[i]) * d[i];
  return i1 > i0 ? std::sqrt(s / static_cast<double>(i1 - i0)) : 0;
}
inline double db(double x) {
  return 20 * std::log10(x + 1e-30);
}
/** Lowest 50 ms window level (dB) in [a, b] (suites.mjs minWindowDb). */
inline double minWindowDb(const std::vector<float> &d, double a, double b) {
  double m = 1e9;
  for (double t = a; t + 0.05 <= b; t += 0.05) m = std::min(m, db(rms(d, t, t + 0.05)));
  return m;
}

}  // namespace t13
