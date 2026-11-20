// "golden-analytic": the test voice fixtures against an analytic reference computed here (no JS oracle exists for
// the test voice), and the first real golden: eq-peak-a rendered through the C API vs the committed smoke WAV.
#include <algorithm>
#include <cmath>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "fixture_runner.h"
#include "io/wav.h"
#include "yyjson.h"

using namespace rig::tools;

namespace {

struct Adsr {
  double a, d, s, r;
};

/** Closed-form envelope: linear attack, setTarget decay with the 12-tau pin, release from the held value. */
double envelope(double t, const Adsr &p, double tRel) {
  auto pre = [&](double x) {
    if (x < p.a) return x / p.a;
    const double dt = x - p.a;
    return dt >= 12 * p.d ? p.s : p.s + (1.0 - p.s) * std::exp(-dt / p.d);
  };
  if (t < tRel) return pre(t);
  const double v0 = pre(tRel), dt = t - tRel;
  return dt >= 12 * p.r ? 0.0 : v0 * std::exp(-dt / p.r);
}

std::vector<float> reference(double sr, std::size_t frames, int note, int vel, bool saw, double gain, double pan,
                             double tOn, double tOff, const Adsr &p, int channel) {
  const std::int64_t f0 = std::llround(tOn * sr), fr = std::llround(tOff * sr);
  const double freq = 440.0 * std::pow(2.0, (note - 69) / 12.0);
  const double x = (pan + 1.0) / 2.0;
  const double law = channel == 0 ? std::cos(x * 1.5707963267948966) : std::sin(x * 1.5707963267948966);
  std::vector<float> out(frames, 0.0f);
  for (std::size_t i = 0; i < frames; ++i) {
    const std::int64_t k = static_cast<std::int64_t>(i) - f0;
    if (k < 0) continue;
    const double ph = k * freq / sr, frac = ph - std::floor(ph);
    const double s = saw ? 2.0 * frac - 1.0 : std::sin(2.0 * 3.141592653589793 * frac);
    out[i] = static_cast<float>(s * (vel / 127.0) * envelope(k / sr, p, double(fr - f0) / sr) * gain * law);
  }
  return out;
}

double maxDiff(const std::vector<float> &a, const std::vector<float> &b) {
  double m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) m = std::fmax(m, std::fabs(double(a[i]) - double(b[i])));
  return m;
}

}  // namespace

TEST_SUITE("golden-analytic") {
  const std::string golden = std::string(RIG_REPO_DIR) + "/native/golden";

  TEST_CASE("test voice fixtures (file-driven) match the analytic reference") {
    std::vector<Fixture> fx;
    std::string err;
    REQUIRE(loadFixtures(std::string(RIG_SOURCE_DIR) + "/tests/fixtures/test-voice.json", fx, &err));
    REQUIRE(fx.size() == 2);
    const double sr = 44100;
    {
      const RunResult r = runFixture(fx[0], golden, sr);
      REQUIRE(r.ok);
      CHECK(r.skipped.empty());
      const Adsr p{0.01, 0.1, 0.7, 0.2};
      for (int c = 0; c < 2; ++c) {
        const auto ref = reference(sr, r.channels[c].size(), 69, 100, false, 1.0, 0.0, 0.1, 0.6, p, c);
        CHECK(maxDiff(r.channels[c], ref) < 2e-5);
      }
      const auto &l = r.channels[0];
      CHECK(*std::max_element(l.begin(), l.end()) > 0.3f);  // it is actually sounding
    }
    {
      const RunResult r = runFixture(fx[1], golden, sr);
      REQUIRE(r.ok);
      const Adsr p{0.01, 0.1, 0.7, 0.05};
      for (int c = 0; c < 2; ++c) {
        const auto ref = reference(sr, r.channels[c].size(), 57, 64, true, 0.5, 0.5, 0.05, 0.3, p, c);
        CHECK(maxDiff(r.channels[c], ref) < 2e-5);
      }
    }
  }

  TEST_CASE("eq-peak-a through the C API matches the committed golden (exact tier, max|diff| <= 2e-4)") {
    std::vector<Fixture> fx;
    std::string err;
    REQUIRE(loadFixtures(golden + "/manifest.json", fx, &err));
    const auto it = std::find_if(fx.begin(), fx.end(), [](const Fixture &f) { return f.id == "eq-peak-a"; });
    REQUIRE(it != fx.end());
    const RunResult r = runFixture(*it, golden, 44100);
    REQUIRE(r.ok);
    // the fixture's patch uses synth/warm-pad (not implemented yet) but the injected impulse goes through the strip
    rig::io::WavData ref;
    REQUIRE(rig::io::readWav(golden + "/smoke/eq-peak-a.wav", ref, &err));
    REQUIRE(ref.frames() == r.channels[0].size());
    for (int c = 0; c < 2; ++c) CHECK(maxDiff(r.channels[c], ref.ch[c]) <= 2e-4);
    const auto peak = *std::max_element(r.channels[0].begin(), r.channels[0].end());
    CHECK(peak > 0.1f);
  }

  TEST_CASE("the golden harness reports what it cannot do instead of pretending") {
    // T07 review O3: no hard-coded id (click-120-44 stopped being "unimplemented" when T07 landed). Probe, from the
    // manifest, the first single-instrument fixture (one slot, no injection, no drone) whose render reports its
    // instrument as unsupported; such a render must be silent. Each instrument type is rendered at most once, so the
    // probe moves on by itself as waves 2-3 land, and passes vacuously once every instrument type exists.
    std::vector<Fixture> fx;
    std::string err;
    REQUIRE(loadFixtures(golden + "/manifest.json", fx, &err));
    std::vector<std::string> implemented;
    bool probed = false;
    for (const Fixture &f : fx) {
      yyjson_doc *d = yyjson_read(f.json.data(), f.json.size(), 0);
      REQUIRE(d != nullptr);
      yyjson_val *root = yyjson_doc_get_root(d);
      yyjson_val *setup = yyjson_obj_get(root, "setup");
      yyjson_val *patch = yyjson_obj_get(setup, "patch");
      yyjson_val *drone = yyjson_obj_get(patch, "drone");
      const char *kind = yyjson_get_str(yyjson_obj_get(root, "kind"));
      std::string type;
      int used = 0;
      size_t i, n;
      yyjson_val *slot;
      yyjson_arr_foreach(yyjson_obj_get(patch, "slots"), i, n, slot) {
        if (yyjson_is_null(slot)) continue;
        ++used;
        const char *t = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(slot, "instrument"), "type"));
        type = t ? t : "";
      }
      const bool candidate = used == 1 && !type.empty() && !yyjson_obj_get(setup, "inject") &&
                             !yyjson_get_bool(yyjson_obj_get(drone, "on")) &&
                             std::string(kind ? kind : "") != "drone-freeze" &&
                             std::find(implemented.begin(), implemented.end(), type) == implemented.end();
      yyjson_doc_free(d);
      if (!candidate) continue;
      const RunResult r = runFixture(f, golden, 44100);
      REQUIRE(r.ok);
      const bool unsupported = std::any_of(r.skipped.begin(), r.skipped.end(),
                                           [](const std::string &s) { return s.rfind("instrument ", 0) == 0; });
      if (!unsupported) {
        implemented.push_back(type);
        continue;
      }
      MESSAGE("probe fixture " << f.id << " (instrument type " << type << ", reported unsupported)");
      for (const auto &ch : r.channels) {
        float peak = 0.0f;
        for (float s : ch) peak = std::fmax(peak, std::fabs(s));
        CHECK(peak == 0.0f);
      }
      probed = true;
      break;
    }
    if (!probed) MESSAGE("every instrument type in the manifest is implemented: nothing left to probe");
  }
}
