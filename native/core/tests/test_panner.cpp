// T02: wa::StereoPanner against StereoPannerNode renders of the golden Chromium (157.0.8103.78),
// tools/golden/vectors/data/panner.txt (dump-panner.mjs): mono and stereo laws, constant pans (float path) and
// automated pans (double path), clamping. BUILD_PLAN T02: <= 1e-6 (in practice bit-exact).
#include <cmath>
#include <string>
#include <vector>

#include "doctest.h"
#include "dsp/panner.h"
#include "test_strip_vectors.h"

using namespace rig::wa;

TEST_SUITE("panner") {
  TEST_CASE("StereoPannerNode vectors (Chromium 157): mono and stereo law, constant and automated") {
    const auto cases = t02::readCases("panner.txt");
    REQUIRE(cases.size() >= 20);
    double worst = 0;
    int exact = 0;
    for (const auto &cs : cases) {
      const t02::Spec sp(cs.spec);
      const double sr = sp.num("sr");
      const std::size_t frames = static_cast<std::size_t>(sp.num("frames"));
      const unsigned nch = static_cast<unsigned>(sp.num("ch"));
      StereoPanner p(std::fmax(-1.0, std::fmin(1.0, sp.num("pan"))));
      yyjson_val *au = sp.get("auto");
      std::size_t ai, an;
      yyjson_val *row;
      yyjson_arr_foreach(au, ai, an, row) {
        const std::string m = yyjson_get_str(yyjson_arr_get(row, 0));
        std::vector<double> a;
        for (std::size_t k = 1; k < yyjson_arr_size(row); ++k) a.push_back(yyjson_get_num(yyjson_arr_get(row, k)));
        if (m == "setValueAtTime") p.pan().setValueAtTime(a[0], a[1]);
        else if (m == "linearRampToValueAtTime") p.pan().linearRampToValueAtTime(a[0], a[1]);
        else if (m == "setTargetAtTime") p.pan().setTargetAtTime(a[0], a[1], a[2]);
        else FAIL("unknown automation " << m);
      }
      std::vector<float> x[2] = {t02::input(0, frames, sr, sp.num("amp")), t02::input(1, frames, sr, sp.num("amp"))};
      std::vector<float> l(frames), r(frames);
      for (std::size_t q0 = 0; q0 < frames; q0 += 128) {
        const float *in[2] = {x[0].data() + q0, x[1].data() + q0};
        p.process(in, nch, l.data() + q0, r.data() + q0, std::min<std::size_t>(128, frames - q0),
                  static_cast<std::int64_t>(q0), sr);
      }
      const std::vector<float> wl = t02::b64floats(cs.out);
      const double d = std::fmax(t02::maxDiff(l, wl), t02::maxDiff(r, cs.out1 == "same" ? wl : t02::b64floats(cs.out1)));
      CHECK_MESSAGE(d <= 1e-6, cs.name << ": max diff " << d);
      worst = std::fmax(worst, d);
      exact += d == 0 ? 1 : 0;
    }
    MESSAGE("panner vectors: " << cases.size() << " cases, " << exact << " bit-exact, worst " << worst);
  }

  TEST_CASE("laws: mono -3 dB at centre, stereo p <= 0 keeps L, p > 0 keeps R") {
    float l, r;
    StereoPanner::panSampleAccurate(1, 0, 1, 0, l, r);
    CHECK(l == doctest::Approx(std::sqrt(0.5)).epsilon(1e-7));
    CHECK(r == doctest::Approx(std::sqrt(0.5)).epsilon(1e-7));
    StereoPanner::panSampleAccurate(0.5f, 0.25f, 2, -1, l, r);  // hard left: L = inL + inR, R = 0
    CHECK(l == doctest::Approx(0.75));
    CHECK(std::fabs(r) < 1e-7);
    StereoPanner::panSampleAccurate(0.5f, 0.25f, 2, 1, l, r);  // hard right: L = 0, R = inR + inL
    CHECK(std::fabs(l) < 1e-7);
    CHECK(r == doctest::Approx(0.75));
  }
}
