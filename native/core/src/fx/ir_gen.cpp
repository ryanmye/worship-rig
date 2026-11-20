// Port of app/js/engine/fx.js irGen (see ir_gen.h). The comments quote the JS expression each line reproduces; the
// parenthesisation follows JS left-to-right evaluation so the double results are identical.
#include "fx/ir_gen.h"

#include <algorithm>
#include <cmath>

#include "num/js_math.h"
#include "num/prng.h"

namespace rig::fx {
namespace {

constexpr double kBands[7] = {125, 250, 500, 1000, 2000, 4000, 8000};  // IR_BANDS
constexpr double kRt[7] = {1.2, 1.1, 1.0, 0.9, 0.8, 0.5, 0.3};         // IR_RT
constexpr double kDampW[7] = {0, 0, 0, 0.25, 0.5, 0.75, 1};            // IR_DAMP_W
constexpr double kSqrt2 = 1.4142135623730951;                          // Math.SQRT2 = Math.sqrt(2)

struct Coefs {
  double b0, b1, b2, a1, a2;
};

/** biquadCoefs(type, f, sr, q, gainDb) (fx.js:299). */
Coefs biquadCoefs(bool bandpass, double f, double sr, double q, double gainDb) {
  const double w = (2 * js::kPi * std::min(f, sr * 0.45)) / sr;
  const double cw = js::cos(w);
  const double sw = js::sin(w);
  const double alpha = sw / (2 * q);
  double b0, b1, b2, a0, a1, a2;
  if (bandpass) {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cw;
    a2 = 1 - alpha;
  } else {  // low shelf (RBJ, S = 1)
    const double A = js::pow(10, gainDb / 40);
    const double al = (sw / 2) * kSqrt2;
    const double sa = 2 * js::sqrt(A) * al;
    b0 = A * (A + 1 - (A - 1) * cw + sa);
    b1 = 2 * A * (A - 1 - (A + 1) * cw);
    b2 = A * (A + 1 - (A - 1) * cw - sa);
    a0 = A + 1 + (A - 1) * cw + sa;
    a1 = -2 * (A - 1 + (A + 1) * cw);
    a2 = A + 1 + (A - 1) * cw - sa;
  }
  return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

double rtFor(int k, double sizeSec, double dq) {
  return sizeSec * kRt[k] * (1 + (0.5 - dq) * 0.8 * kDampW[k]);
}

class EngineRng final : public IrRandom {
 public:
  explicit EngineRng(std::uint32_t seed) : r_(seed) {}
  double next() override { return r_.next(); }

 private:
  Rng r_;
};

}  // namespace

double reverbBucket(double size) {
  const double s = std::isnan(size) ? 0.0 : size;  // Number(size) || 0
  const double rt = std::max(0.01, s) * 9;
  double best = kIrBuckets[0];
  for (double b : kIrBuckets)
    if (std::fabs(js::log(b / rt)) < std::fabs(js::log(best / rt))) best = b;
  return best;
}

double dampQ(double d) {
  const double v = std::isnan(d) ? 0.0 : d;
  return js::round(std::min(1.0, std::max(0.0, v)) * 10) / 10;
}

std::string irKey(double size, double damp, double sampleRate) {
  std::string k;
  appendJs(k, reverbBucket(size));
  k += '|';
  appendJs(k, dampQ(damp));
  k += '|';
  appendJs(k, sampleRate);
  return k;
}

std::uint32_t irSeed(std::uint32_t engineSeed, const std::string &key) {
  return hashSeed(std::to_string(engineSeed) + "|ir|" + key);
}

std::size_t irLength(double sr, double sizeSec, double damp) {
  const double dq = dampQ(damp);
  double mx = rtFor(0, sizeSec, dq);
  for (int k = 1; k < 7; ++k) mx = std::max(mx, rtFor(k, sizeSec, dq));  // Math.max(...rts)
  return static_cast<std::size_t>(std::ceil(1.1 * mx * sr));
}

IrChannels generateIr(double sr, IrRandom &rng, double sizeSec, double damp) {
  const double dq = dampQ(damp);
  double rts[7];
  for (int k = 0; k < 7; ++k) rts[k] = rtFor(k, sizeSec, dq);
  const std::size_t len = irLength(sr, sizeSec, damp);
  IrChannels chans;
  for (int c = 0; c < 2; ++c) {
    std::vector<float> &out = chans.ch[c];
    out.assign(len, 0.0f);
    for (int k = 0; k < 7; ++k) {
      const Coefs q = biquadCoefs(true, kBands[k], sr, kSqrt2, 0);
      const double decay = js::exp(-6.9 / (rts[k] * sr));  // -60 dB at rt
      double env = 1, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (std::size_t i = 0; i < len; ++i) {  // irBandChunk over every 16 k chunk (state carried: same as one loop)
        const double x = rng.next() * 2 - 1;
        const double y = q.b0 * x + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = static_cast<float>(static_cast<double>(out[i]) + y * env);  // Float32Array `+=`
        env *= decay;
      }
    }
    // 30 ms cosine fade-in
    const std::size_t fi = static_cast<std::size_t>(std::floor(0.03 * sr));
    for (std::size_t i = 0; i < fi && i < len; ++i)
      out[i] = static_cast<float>(static_cast<double>(out[i]) *
                                  (0.5 - 0.5 * js::cos((js::kPi * static_cast<double>(i)) / static_cast<double>(fi))));
    // early reflections: 6-10 random taps, 7-60 ms, random sign and gain
    double early = 0;
    const std::size_t ew = std::min(len, static_cast<std::size_t>(std::floor(0.08 * sr)));
    for (std::size_t i = 0; i < ew; ++i) early += static_cast<double>(out[i]) * static_cast<double>(out[i]);
    double eRms = js::sqrt(early / static_cast<double>(std::max<std::size_t>(1, ew)));
    if (eRms == 0 || std::isnan(eRms)) eRms = 0.01;  // `|| 0.01`
    const int taps = 6 + static_cast<int>(std::floor(rng.next() * 5));
    for (int t = 0; t < taps; ++t) {
      const double p = std::floor((0.007 + rng.next() * 0.053) * sr);
      if (p < static_cast<double>(len)) {
        const std::size_t pos = static_cast<std::size_t>(p);
        const double sign = rng.next() < 0.5 ? -1 : 1;  // drawn before the magnitude
        const double mag = 1 + rng.next() * 3;
        out[pos] = static_cast<float>(static_cast<double>(out[pos]) + sign * mag * eRms);
      }
    }
    // low shelf -6 dB below 150 Hz (double state, float32 out)
    const Coefs s = biquadCoefs(false, 150, sr, 0.707, -6);
    double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (std::size_t i = 0; i < len; ++i) {
      const double x = out[i];
      const double y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = static_cast<float>(y);
    }
  }
  // own energy normalisation over both channels (the convolver's normalisation is off)
  double e = 0;
  for (const auto &ch : chans.ch)
    for (float v : ch) e += static_cast<double>(v) * static_cast<double>(v);
  const double g = js::sqrt((kIrEnergy * 2) / (e != 0 ? e : 1));  // e || 1
  for (auto &ch : chans.ch)
    for (float &v : ch) v = static_cast<float>(static_cast<double>(v) * g);
  return chans;
}

IrChannels engineIr(double sr, std::uint32_t engineSeed, double size, double damp) {
  EngineRng rng(irSeed(engineSeed, irKey(size, damp, sr)));
  return generateIr(sr, rng, reverbBucket(size), damp);
}

}  // namespace rig::fx
