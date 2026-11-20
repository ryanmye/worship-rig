// Integrator (T07 review O1): where the 'main' click goes. The JS sends it to ctx.destination only; recordTap hears
// it only with setClick({record:true}) and the analysers (rig_meters.out_peak) sit on fx.out (contract 1.5, 3.11).
// The destination (`out` tap, what the goldens compare) keeps the click either way.
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <string>
#include <unistd.h>
#include <vector>

#include "doctest.h"
#include "helpers.h"
#include "io/wav.h"

using namespace rigtest;
namespace fs = std::filesystem;

namespace {

std::string resultPath(const std::string &all) {
  // the reply batch holds {"re":5,...,"result":{"path":...}} among other events
  const std::size_t p = all.find("\"path\":\"");
  if (p == std::string::npos) return {};
  const std::size_t a = p + 8, b = all.find('"', a);
  return b == std::string::npos ? std::string() : all.substr(a, b - a);
}

float peakOf(const std::vector<float> &v) {
  float m = 0;
  for (float s : v) m = std::max(m, std::fabs(s));
  return m;
}

struct Take {
  float outPeak = 0, wavPeak = 0, meterPeak = 0;
};

Take renderClick(bool record) {
  const fs::path dir = fs::temp_directory_path() /
                       ("rig_int_clickrec_" + std::to_string(::getpid()) + (record ? "_on" : "_off"));
  fs::remove_all(dir);
  fs::create_directories(dir);
  OfflineEngine e(48000);
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
  e.call(R"({"v":1,"op":"song","id":3,"tempo":120})");
  e.call(std::string(R"({"v":1,"op":"click","action":"config","id":4,"output":"main","level":1,"record":)") +
         (record ? "true" : "false") + "}");
  const std::string r = e.call(R"({"v":1,"op":"rec","action":"start","dir":")" + dir.string() + R"(","id":5})");
  const std::string path = resultPath(r);
  REQUIRE(!path.empty());
  e.call(R"({"v":1,"op":"click","action":"start","id":6,"when":0.01})");
  Take t;
  for (int k = 0; k < 25; ++k) {  // 25 x 384 frames = 0.2 s: the first click (t0 = 0.06 s) is fully inside
    const auto out = e.render(384);
    t.outPeak = std::max({t.outPeak, peakOf(out[0]), peakOf(out[1])});
    rig_meters m{};
    m.struct_size = sizeof m;
    REQUIRE(rig_get_meters(e.e, &m) == RIG_OK);
    t.meterPeak = std::max({t.meterPeak, m.out_peak[0], m.out_peak[1]});
  }
  e.call(R"({"v":1,"op":"rec","action":"stop","id":7})");
  rig::io::WavData w;
  std::string err;
  REQUIRE(rig::io::readWav(path, w, &err));
  REQUIRE(w.ch.size() == 2);
  REQUIRE(w.frames() > 9000);
  t.wavPeak = std::max(peakOf(w.ch[0]), peakOf(w.ch[1]));
  fs::remove_all(dir);
  return t;
}

}  // namespace

TEST_SUITE("click-record") {
  TEST_CASE("main click: destination always, recorder only with record:true, meters never") {
    const Take off = renderClick(false);
    CHECK(off.outPeak == doctest::Approx(0.5).epsilon(2e-3));  // the device output carries the click
    CHECK(off.wavPeak == 0.0f);                                 // nothing else plays: the take is click-free
    CHECK(off.meterPeak == 0.0f);                               // out_peak is pre-click
    const Take on = renderClick(true);
    CHECK(on.outPeak == doctest::Approx(0.5).epsilon(2e-3));
    CHECK(on.wavPeak == doctest::Approx(0.5).epsilon(2e-3));  // 16-bit take of the same click
    CHECK(on.meterPeak == 0.0f);
  }
}
