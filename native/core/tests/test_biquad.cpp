// T02: wa::Biquad / wa::BiquadFilter against BiquadFilterNode renders of the golden Chromium (157.0.8103.78),
// tools/golden/vectors/data/biquad.txt (dump-biquad.mjs): every type, edge frequencies, mono / stereo, k-rate and
// a-rate automation, a type change. Plus analytic sanity checks of the formulas.
#include <cmath>
#include <complex>
#include <string>
#include <vector>

#include "doctest.h"
#include "dsp/biquad.h"
#include "test_strip_vectors.h"

using namespace rig::wa;

namespace {

constexpr double kPi = 3.14159265358979323846;

double magDb(const BiquadCoeffs &c, double hz, double sr) {
  const std::complex<double> z = std::polar(1.0, -2.0 * kPi * hz / sr);
  const std::complex<double> num = c.b0 + c.b1 * z + c.b2 * z * z;
  const std::complex<double> den = 1.0 + c.a1 * z + c.a2 * z * z;
  return 20.0 * std::log10(std::abs(num / den));
}

BiquadType typeOf(const std::string &t) {
  if (t == "lowpass") return BiquadType::Lowpass;
  if (t == "highpass") return BiquadType::Highpass;
  if (t == "bandpass") return BiquadType::Bandpass;
  if (t == "lowshelf") return BiquadType::Lowshelf;
  if (t == "highshelf") return BiquadType::Highshelf;
  if (t == "peaking") return BiquadType::Peaking;
  if (t == "notch") return BiquadType::Notch;
  return BiquadType::Allpass;
}

void applyAuto(Param &p, const std::string &m, const std::vector<double> &a) {
  if (m == "setValueAtTime") p.setValueAtTime(a[0], a[1]);
  else if (m == "linearRampToValueAtTime") p.linearRampToValueAtTime(a[0], a[1]);
  else if (m == "exponentialRampToValueAtTime") p.exponentialRampToValueAtTime(a[0], a[1]);
  else if (m == "setTargetAtTime") p.setTargetAtTime(a[0], a[1], a[2]);
  else FAIL("unknown automation " << m);
}

}  // namespace

TEST_SUITE("biquad") {
  TEST_CASE("BiquadFilterNode vectors (Chromium 157): bit-exact") {
    const auto cases = t02::readCases("biquad.txt");
    REQUIRE(cases.size() >= 70);
    double worst = 0;
    int exact = 0;
    for (const auto &cs : cases) {
      const t02::Spec sp(cs.spec);
      const double sr = sp.num("sr");
      const std::size_t frames = static_cast<std::size_t>(sp.num("frames"));
      const unsigned nch = static_cast<unsigned>(sp.num("ch"));
      BiquadFilter f(typeOf(sp.str("type")), sp.num("f"), sp.num("q"), sp.num("g"));
      f.setKRate(sp.str("rate") == "k-rate");
      // AudioParam construction clamps the frequency to [0, nyquist]
      f.frequency().setValue(std::fmin(sp.num("f"), sr / 2));
      yyjson_val *au = sp.get("auto");
      std::size_t ai, an;
      yyjson_val *row;
      yyjson_arr_foreach(au, ai, an, row) {
        const std::string pn = yyjson_get_str(yyjson_arr_get(row, 0));
        const std::string m = yyjson_get_str(yyjson_arr_get(row, 1));
        std::vector<double> a;
        for (std::size_t k = 2; k < yyjson_arr_size(row); ++k) a.push_back(yyjson_get_num(yyjson_arr_get(row, k)));
        applyAuto(pn == "frequency" ? f.frequency() : pn == "Q" ? f.q() : f.gain(), m, a);
      }
      long retypeAt = -1;
      BiquadType retype = BiquadType::Lowpass;
      if (yyjson_val *rt = sp.get("retype")) {
        retypeAt = static_cast<long>(yyjson_get_num(yyjson_arr_get(rt, 0)));
        retype = typeOf(yyjson_get_str(yyjson_arr_get(rt, 1)));
      }
      std::vector<float> x[2] = {t02::input(0, frames, sr, sp.num("amp")), t02::input(1, frames, sr, sp.num("amp"))};
      for (std::size_t q0 = 0; q0 < frames; q0 += 128) {
        if (static_cast<long>(q0) == retypeAt) f.setType(retype);
        float *ch[2] = {x[0].data() + q0, x[1].data() + q0};
        f.process(ch, nch, std::min<std::size_t>(128, frames - q0), static_cast<std::int64_t>(q0), sr);
      }
      const std::vector<float> want0 = t02::b64floats(cs.out);
      double d = t02::maxDiff(x[0], want0);
      if (nch == 2) d = std::fmax(d, t02::maxDiff(x[1], cs.out1 == "same" ? want0 : t02::b64floats(cs.out1)));
      CHECK_MESSAGE(d <= 1e-7, cs.name << ": max diff " << d);
      worst = std::fmax(worst, d);
      exact += d == 0 ? 1 : 0;
    }
    MESSAGE("biquad vectors: " << cases.size() << " cases, " << exact << " bit-exact, worst " << worst);
  }

  TEST_CASE("formulas: cookbook peaking within float-precision gain, Butterworth -3.01 dB") {
    const double sr = 44100;
    const BiquadCoeffs c = biquadCoeffs(BiquadType::Peaking, 1000, 1, 9, sr);
    CHECK(magDb(c, 1000, sr) == doctest::Approx(9).epsilon(1e-6));  // A = 10^(g/40) rounded to float (fdlibm::expf)
    const double butter = 20 * std::log10(std::sqrt(0.5));
    CHECK(magDb(biquadCoeffs(BiquadType::Lowpass, 2000, butter, 0, sr), 2000, sr) == doctest::Approx(-3.0103).epsilon(1e-4));
    CHECK(magDb(biquadCoeffs(BiquadType::Highpass, 150, butter, 0, sr), 150, sr) ==
          doctest::Approx(-3.0103).epsilon(1e-4));
    CHECK(magDb(biquadCoeffs(BiquadType::Highpass, 150, butter, 0, sr), 75, sr) < -11.5);  // 2-pole slope
    BiquadCoeffs e = biquadCoeffs(BiquadType::Lowpass, sr / 2, 0, 0, sr);  // Nyquist lowpass: exact bypass (Q5)
    CHECK((e.b0 == 1 && e.b1 == 0 && e.b2 == 0 && e.a1 == 0 && e.a2 == 0));
    const BiquadCoeffs id = biquadCoeffs(BiquadType::Highshelf, 6000, 0, 0, sr);  // 0 dB shelf: b == a
    CHECK((id.b0 == 1 && id.b1 == id.a1 && id.b2 == id.a2));
  }

  TEST_CASE("state continues across blocks (block size does not matter)") {
    Biquad a, b;
    const BiquadCoeffs c = biquadCoeffs(BiquadType::Peaking, 800, 2, 6, 44100);
    a.set(c);
    b.set(c);
    std::vector<float> x(1000), ya(1000), yb(1000);
    for (std::size_t i = 0; i < x.size(); ++i) x[i] = static_cast<float>(std::sin(static_cast<double>(i) * 0.3));
    a.process(x.data(), ya.data(), 1000);
    for (std::size_t i = 0; i < 1000; i += 128)
      b.process(x.data() + i, yb.data() + i, std::min<std::size_t>(128, 1000 - i));
    CHECK(ya == yb);
  }
}
