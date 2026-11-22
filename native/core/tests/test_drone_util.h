// Helpers of the T16 drone tests (test_drone*.cpp): drone ops through the bridge, the engine's drone service, and the
// suites.mjs measures at any sample rate.
#pragma once
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "drone/drone_service.h"
#include "test_model_util.h"

namespace t16 {

inline constexpr double kPi = 3.14159265358979323846;

inline rig::drone::DroneServiceImpl *service(t13::Eng &e) {
  return dynamic_cast<rig::drone::DroneServiceImpl *>(e.model().service("drone"));
}

/** `drone {config}` (song.drone object JSON). */
inline std::string droneConfig(t13::Eng &e, const std::string &cfg, double when) {
  return e.call(R"({"v":1,"op":"drone","id":8,"config":)" + cfg + ",\"when\":" + t13::Eng::num(when) + "}");
}
/** `drone {key}`; fade < 0 = drone.fade. */
inline std::string droneKey(t13::Eng &e, int pc, bool minor, double when, double fade = -1) {
  std::string k = "{\"pc\":" + std::to_string(pc) + ",\"minor\":" + (minor ? "true" : "false");
  if (fade >= 0) k += ",\"fade\":" + t13::Eng::num(fade);
  return e.call(R"({"v":1,"op":"drone","id":8,"key":)" + k + "},\"when\":" + t13::Eng::num(when) + "}");
}

inline std::vector<float> mono(const t13::Eng &e) {
  std::vector<float> d(e.L.size());
  for (std::size_t i = 0; i < d.size(); ++i) d[i] = 0.5f * (e.L[i] + e.R[i]);
  return d;
}

/** Render until engine time t at sample rate `sr` (t13::Eng::until assumes 44.1 kHz). */
inline void untilSr(t13::Eng &e, double t, double sr) {
  const auto want = static_cast<std::size_t>(std::ceil(t * sr / 128.0)) * 128;
  if (want <= e.L.size()) return;
  auto o = e.render(want - e.L.size(), 128);
  e.L.insert(e.L.end(), o[0].begin(), o[0].end());
  e.R.insert(e.R.end(), o[1].begin(), o[1].end());
}

inline double rmsSr(const std::vector<float> &d, double sr, double a, double b) {
  const auto i0 = static_cast<std::size_t>(a * sr), i1 = std::min(d.size(), static_cast<std::size_t>(b * sr));
  double s = 0;
  for (std::size_t i = i0; i < i1; ++i) s += static_cast<double>(d[i]) * d[i];
  return i1 > i0 ? std::sqrt(s / static_cast<double>(i1 - i0)) : 0;
}

/** Hann-windowed single-bin DFT magnitude at f over [a, b] (a ratio measure, as suites.mjs bandMag is used). */
inline double bandMagSr(const std::vector<float> &d, double sr, double a, double b, double f) {
  const auto i0 = static_cast<std::size_t>(a * sr), i1 = std::min(d.size(), static_cast<std::size_t>(b * sr));
  const double n = static_cast<double>(i1 - i0);
  double re = 0, im = 0;
  for (std::size_t i = i0; i < i1; ++i) {
    const double k = static_cast<double>(i - i0);
    const double w = 0.5 - 0.5 * std::cos(2 * kPi * k / (n - 1));
    re += w * d[i] * std::cos(2 * kPi * f * k / sr);
    im -= w * d[i] * std::sin(2 * kPi * f * k / sr);
  }
  return std::sqrt(re * re + im * im);
}
inline double bandMag(const std::vector<float> &d, double a, double b, double f) {
  return bandMagSr(d, t13::kSR, a, b, f);
}

/** Pitch classes of target frequencies (Hz), sorted, unique. */
inline std::vector<int> pcsOf(const std::vector<double> &fs) {
  std::vector<int> p;
  for (double f : fs) {
    const int m = static_cast<int>(std::lround(69 + 12 * std::log2(f / 440)));
    const int pc = ((m % 12) + 12) % 12;
    if (std::find(p.begin(), p.end(), pc) == p.end()) p.push_back(pc);
  }
  std::sort(p.begin(), p.end());
  return p;
}

}  // namespace t16
