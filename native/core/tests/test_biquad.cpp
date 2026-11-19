#include <cmath>
#include <complex>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "dsp/biquad.h"

using namespace rig::wa;
namespace {

constexpr double kPi = 3.14159265358979323846;

/** |H(e^jw)| in dB straight from the coefficients. */
double magDb(const BiquadCoeffs &c, double hz, double sr) {
  const std::complex<double> z = std::polar(1.0, -2.0 * kPi * hz / sr);
  const std::complex<double> num = c.b0 + c.b1 * z + c.b2 * z * z;
  const std::complex<double> den = 1.0 + c.a1 * z + c.a2 * z * z;
  return 20.0 * std::log10(std::abs(num / den));
}

/** Steady-state gain by actually filtering a sine (checks the recursion, not only the coefficients). */
double measuredDb(Biquad &f, double hz, double sr) {
  const std::size_t n = 48000;
  std::vector<float> x(n), y(n);
  for (std::size_t i = 0; i < n; ++i) x[i] = static_cast<float>(std::sin(2 * kPi * hz * i / sr));
  f.reset();
  f.process(x.data(), y.data(), n);
  double px = 0, py = 0;
  for (std::size_t i = n / 2; i < n; ++i) {
    px = std::fmax(px, std::fabs(x[i]));
    py = std::fmax(py, std::fabs(y[i]));
  }
  return 20.0 * std::log10(py / px);
}

}  // namespace

TEST_SUITE("biquad") {
  const double sr = 44100;

  TEST_CASE("peaking: matches the cookbook formulas written out independently") {
    const double f = 1000, q = 1, g = 9;
    const double A = std::pow(10, g / 40), w0 = 2 * kPi * f / sr, al = std::sin(w0) / (2 * q), k = std::cos(w0);
    const double a0 = 1 + al / A;
    const BiquadCoeffs c = biquadCoeffs(BiquadType::Peaking, f, q, g, sr);
    CHECK(c.b0 == doctest::Approx((1 + al * A) / a0).epsilon(1e-12));
    CHECK(c.b1 == doctest::Approx(-2 * k / a0).epsilon(1e-12));
    CHECK(c.b2 == doctest::Approx((1 - al * A) / a0).epsilon(1e-12));
    CHECK(c.a1 == doctest::Approx(-2 * k / a0).epsilon(1e-12));
    CHECK(c.a2 == doctest::Approx((1 - al / A) / a0).epsilon(1e-12));
    CHECK(magDb(c, f, sr) == doctest::Approx(g).epsilon(1e-9));
    Biquad bq;
    bq.set(c);
    CHECK(measuredDb(bq, f, sr) == doctest::Approx(g).epsilon(1e-3));
  }

  TEST_CASE("lowpass / highpass: Q is in dB (resonance), Butterworth is -3.01 dB") {
    const double butter = 20 * std::log10(std::sqrt(0.5));
    const BiquadCoeffs lp = biquadCoeffs(BiquadType::Lowpass, 2000, butter, 0, sr);
    CHECK(magDb(lp, 2000, sr) == doctest::Approx(-3.0103).epsilon(1e-4));
    const BiquadCoeffs hp = biquadCoeffs(BiquadType::Highpass, 2000, butter, 0, sr);
    CHECK(magDb(hp, 2000, sr) == doctest::Approx(-3.0103).epsilon(1e-4));
    // +6 dB Q: resonance peak of 6 dB at the cutoff
    CHECK(magDb(biquadCoeffs(BiquadType::Lowpass, 2000, 6.0, 0, sr), 2000, sr) == doctest::Approx(6.0).epsilon(1e-6));
    CHECK(magDb(lp, 20, sr) == doctest::Approx(0.0).epsilon(1e-3));
    CHECK(magDb(hp, 20000, sr) == doctest::Approx(0.0).epsilon(1e-2));
  }

  TEST_CASE("edge frequencies: Nyquist lowpass and 0 Hz highpass pass through (Q5)") {
    BiquadCoeffs c = biquadCoeffs(BiquadType::Lowpass, sr / 2, 0, 0, sr);
    CHECK((c.b0 == 1 && c.b1 == 0 && c.b2 == 0 && c.a1 == 0 && c.a2 == 0));
    c = biquadCoeffs(BiquadType::Highpass, 0, 0, 0, sr);
    CHECK((c.b0 == 1 && c.b1 == 0));
    c = biquadCoeffs(BiquadType::Lowpass, 0, 0, 0, sr);
    CHECK(c.b0 == 0);
    c = biquadCoeffs(BiquadType::Highpass, sr, 0, 0, sr);  // above Nyquist clamps to Nyquist: silence
    CHECK(c.b0 == 0);
  }

  TEST_CASE("shelves: gain at the extremes, +/- dB, identity at 0 dB") {
    const BiquadCoeffs ls = biquadCoeffs(BiquadType::Lowshelf, 200, 0, 12, sr);
    CHECK(magDb(ls, 10, sr) == doctest::Approx(12.0).epsilon(2e-3));
    CHECK(magDb(ls, 15000, sr) == doctest::Approx(0.0).epsilon(1e-3));
    const BiquadCoeffs hs = biquadCoeffs(BiquadType::Highshelf, 6000, 0, -9, sr);
    CHECK(magDb(hs, 20000, sr) == doctest::Approx(-9.0).epsilon(5e-3));
    CHECK(magDb(hs, 100, sr) == doctest::Approx(0.0).epsilon(1e-3));
    const BiquadCoeffs id = biquadCoeffs(BiquadType::Highshelf, 6000, 0, 0, sr);
    CHECK(std::fabs(magDb(id, 3000, sr)) < 1e-9);
  }

  TEST_CASE("notch: deep null at the centre; peaking Q<=0 is a flat A^2 gain") {
    CHECK(magDb(biquadCoeffs(BiquadType::Notch, 60, 10, 0, sr), 60, sr) < -200);
    const BiquadCoeffs flat = biquadCoeffs(BiquadType::Peaking, 1000, 0, 6, sr);
    CHECK(flat.b0 == doctest::Approx(std::pow(10, 6.0 / 20)).epsilon(1e-12));
  }

  TEST_CASE("state continues across blocks (block size does not matter)") {
    Biquad a, b;
    const BiquadCoeffs c = biquadCoeffs(BiquadType::Peaking, 800, 2, 6, sr);
    a.set(c);
    b.set(c);
    std::vector<float> x(1000), ya(1000), yb(1000);
    for (std::size_t i = 0; i < x.size(); ++i) x[i] = static_cast<float>(std::sin(i * 0.3) + 0.1 * i / 1000.0);
    a.process(x.data(), ya.data(), 1000);
    for (std::size_t i = 0; i < 1000; i += 128)
      b.process(x.data() + i, yb.data() + i, std::min<std::size_t>(128, 1000 - i));
    CHECK(ya == yb);
  }
}
