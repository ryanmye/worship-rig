// T02: wa::DelayLine against DelayNode renders of the golden Chromium (157.0.8103.78),
// tools/golden/vectors/data/delay-line.txt (dump-delay-line.mjs), and the sample form used by feedback loops.
#include <cmath>
#include <string>
#include <vector>

#include "doctest.h"
#include "dsp/delay_line.h"
#include "test_strip_vectors.h"

using namespace rig::wa;

TEST_SUITE("delay_line") {
  TEST_CASE("DelayNode vectors (Chromium 157): constant, fractional and automated delays") {
    const auto cases = t02::readCases("delay-line.txt");
    REQUIRE(cases.size() >= 9);
    double worst = 0;
    int exact = 0;
    for (const auto &cs : cases) {
      const t02::Spec sp(cs.spec);
      const double sr = sp.num("sr");
      const std::size_t frames = static_cast<std::size_t>(sp.num("frames"));
      DelayLine dl(sp.num("max"), sr, sp.num("delay"));
      yyjson_val *au = sp.get("auto");
      std::size_t ai, an;
      yyjson_val *row;
      yyjson_arr_foreach(au, ai, an, row) {
        const std::string m = yyjson_get_str(yyjson_arr_get(row, 0));
        std::vector<double> a;
        for (std::size_t k = 1; k < yyjson_arr_size(row); ++k) a.push_back(yyjson_get_num(yyjson_arr_get(row, k)));
        if (m == "setValueAtTime") dl.delayTime().setValueAtTime(a[0], a[1]);
        else if (m == "linearRampToValueAtTime") dl.delayTime().linearRampToValueAtTime(a[0], a[1]);
        else if (m == "exponentialRampToValueAtTime") dl.delayTime().exponentialRampToValueAtTime(a[0], a[1]);
        else if (m == "setTargetAtTime") dl.delayTime().setTargetAtTime(a[0], a[1], a[2]);
        else FAIL("unknown automation " << m);
      }
      std::vector<float> x = t02::input(0, frames, sr, sp.num("amp")), y(frames);
      for (std::size_t q0 = 0; q0 < frames; q0 += 128)
        dl.process(static_cast<std::int64_t>(q0), sr, x.data() + q0, y.data() + q0,
                   std::min<std::size_t>(128, frames - q0));
      const double d = t02::maxDiff(y, t02::b64floats(cs.out));
      CHECK_MESSAGE(d <= 1e-7, cs.name << ": max diff " << d);
      worst = std::fmax(worst, d);
      exact += d == 0 ? 1 : 0;
    }
    MESSAGE("delay vectors: " << cases.size() << " cases, " << exact << " bit-exact, worst " << worst);
  }

  TEST_CASE("sample form: write then read at k frames returns the input k frames ago, fractions interpolate") {
    const double sr = 48000;
    DelayLine dl(0.1, sr);
    std::vector<float> hist;
    for (int i = 0; i < 2000; ++i) {
      const float x = static_cast<float>(std::sin(i * 0.01));
      dl.write(x);
      hist.push_back(x);
      if (i >= 300) {
        CHECK(dl.read(0.0, sr) == x);
        CHECK(dl.read(250.0 / sr, sr) == doctest::Approx(hist[static_cast<std::size_t>(i - 250)]).epsilon(1e-6));
        const float mid = dl.read(10.5 / sr, sr);
        const float a = hist[static_cast<std::size_t>(i - 10)], b = hist[static_cast<std::size_t>(i - 11)];
        CHECK(mid == doctest::Approx(0.5f * (a + b)).epsilon(1e-5));
      }
    }
    dl.clear();
    CHECK(dl.read(0.01, sr) == 0.0f);
  }

  TEST_CASE("block form in place (in == out) equals out of place") {
    const double sr = 44100;
    DelayLine a(0.05, sr, 0.0123), b(0.05, sr, 0.0123);
    std::vector<float> x = t02::input(0, 4096, sr, 0.3), y(4096), z = x;
    for (std::size_t q0 = 0; q0 < 4096; q0 += 128) {
      a.process(static_cast<std::int64_t>(q0), sr, x.data() + q0, y.data() + q0, 128);
      b.process(static_cast<std::int64_t>(q0), sr, z.data() + q0, z.data() + q0, 128);
    }
    CHECK(y == z);
  }
}
