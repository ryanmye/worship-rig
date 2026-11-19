#include "dsp/biquad.h"

#include <algorithm>
#include <cmath>

namespace rig::wa {
namespace {

constexpr double kPi = 3.14159265358979323846;

BiquadCoeffs norm(double b0, double b1, double b2, double a0, double a1, double a2) {
  const double inv = 1.0 / a0;
  return {b0 * inv, b1 * inv, b2 * inv, a1 * inv, a2 * inv};
}

}  // namespace

BiquadCoeffs biquadCoeffs(BiquadType type, double freqHz, double q, double gainDb, double sampleRate) {
  const double nyquist = sampleRate * 0.5;
  const double f = std::clamp(freqHz / nyquist, 0.0, 1.0);  // normalised: 1 = Nyquist (Chromium clamps likewise)
  const double A = std::pow(10.0, gainDb / 40.0);
  switch (type) {
    case BiquadType::Lowpass: {
      if (f >= 1.0) return norm(1, 0, 0, 1, 0, 0);  // Nyquist: pass-through
      if (f <= 0.0) return norm(0, 0, 0, 1, 0, 0);  // 0 Hz: silence
      const double res = std::pow(10.0, q / 20.0);  // Q in dB
      const double theta = kPi * f;
      const double alpha = std::sin(theta) / (2.0 * res);
      const double c = std::cos(theta);
      const double beta = (1.0 - c) / 2.0;
      return norm(beta, 2.0 * beta, beta, 1.0 + alpha, -2.0 * c, 1.0 - alpha);
    }
    case BiquadType::Highpass: {
      if (f >= 1.0) return norm(0, 0, 0, 1, 0, 0);
      if (f <= 0.0) return norm(1, 0, 0, 1, 0, 0);  // 0 Hz: pass-through
      const double res = std::pow(10.0, q / 20.0);
      const double theta = kPi * f;
      const double alpha = std::sin(theta) / (2.0 * res);
      const double c = std::cos(theta);
      const double beta = (1.0 + c) / 2.0;
      return norm(beta, -2.0 * beta, beta, 1.0 + alpha, -2.0 * c, 1.0 - alpha);
    }
    case BiquadType::Bandpass: {
      if (f <= 0.0 || f >= 1.0) return norm(0, 0, 0, 1, 0, 0);
      if (q <= 0.0) return norm(1, 0, 0, 1, 0, 0);
      const double w0 = kPi * f;
      const double alpha = std::sin(w0) / (2.0 * q);
      const double k = std::cos(w0);
      return norm(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * k, 1.0 - alpha);
    }
    case BiquadType::Allpass: {
      if (f <= 0.0 || f >= 1.0) return norm(1, 0, 0, 1, 0, 0);
      if (q <= 0.0) return norm(-1, 0, 0, 1, 0, 0);
      const double w0 = kPi * f;
      const double alpha = std::sin(w0) / (2.0 * q);
      const double k = std::cos(w0);
      return norm(1.0 - alpha, -2.0 * k, 1.0 + alpha, 1.0 + alpha, -2.0 * k, 1.0 - alpha);
    }
    case BiquadType::Peaking: {
      if (f <= 0.0 || f >= 1.0) return norm(1, 0, 0, 1, 0, 0);
      if (q <= 0.0) return norm(A * A, 0, 0, 1, 0, 0);
      const double w0 = kPi * f;
      const double alpha = std::sin(w0) / (2.0 * q);
      const double k = std::cos(w0);
      return norm(1.0 + alpha * A, -2.0 * k, 1.0 - alpha * A, 1.0 + alpha / A, -2.0 * k, 1.0 - alpha / A);
    }
    case BiquadType::Notch: {
      if (f <= 0.0 || f >= 1.0) return norm(1, 0, 0, 1, 0, 0);
      if (q <= 0.0) return norm(0, 0, 0, 1, 0, 0);
      const double w0 = kPi * f;
      const double alpha = std::sin(w0) / (2.0 * q);
      const double k = std::cos(w0);
      return norm(1.0, -2.0 * k, 1.0, 1.0 + alpha, -2.0 * k, 1.0 - alpha);
    }
    case BiquadType::Lowshelf: {
      if (f >= 1.0) return norm(A * A, 0, 0, 1, 0, 0);
      if (f <= 0.0) return norm(1, 0, 0, 1, 0, 0);
      const double w0 = kPi * f;
      const double S = 1.0;
      const double alpha = 0.5 * std::sin(w0) * std::sqrt((A + 1.0 / A) * (1.0 / S - 1.0) + 2.0);
      const double k = std::cos(w0);
      const double k2 = 2.0 * std::sqrt(A) * alpha;
      const double ap1 = A + 1.0;
      const double am1 = A - 1.0;
      return norm(A * (ap1 - am1 * k + k2), 2.0 * A * (am1 - ap1 * k), A * (ap1 - am1 * k - k2), ap1 + am1 * k + k2,
                  -2.0 * (am1 + ap1 * k), ap1 + am1 * k - k2);
    }
    case BiquadType::Highshelf: {
      if (f >= 1.0) return norm(1, 0, 0, 1, 0, 0);
      if (f <= 0.0) return norm(A * A, 0, 0, 1, 0, 0);
      const double w0 = kPi * f;
      const double S = 1.0;
      const double alpha = 0.5 * std::sin(w0) * std::sqrt((A + 1.0 / A) * (1.0 / S - 1.0) + 2.0);
      const double k = std::cos(w0);
      const double k2 = 2.0 * std::sqrt(A) * alpha;
      const double ap1 = A + 1.0;
      const double am1 = A - 1.0;
      return norm(A * (ap1 + am1 * k + k2), -2.0 * A * (am1 + ap1 * k), A * (ap1 + am1 * k - k2), ap1 - am1 * k + k2,
                  2.0 * (am1 - ap1 * k), ap1 - am1 * k - k2);
    }
  }
  return {};
}

void Biquad::process(const float *in, float *out, std::size_t n) {
  double x1 = x1_, x2 = x2_, y1 = y1_, y2 = y2_;
  const double b0 = c_.b0, b1 = c_.b1, b2 = c_.b2, a1 = c_.a1, a2 = c_.a2;
  for (std::size_t i = 0; i < n; ++i) {
    const double x = in[i];
    const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = static_cast<float>(y);
  }
  // Flush denormal state like Chromium's (FTZ/DAZ covers it on x86/arm64; this keeps portable builds honest).
  auto flush = [](double v) { return std::fabs(v) < 1e-30 ? 0.0 : v; };
  x1_ = flush(x1);
  x2_ = flush(x2);
  y1_ = flush(y1);
  y2_ = flush(y2);
}

}  // namespace rig::wa
