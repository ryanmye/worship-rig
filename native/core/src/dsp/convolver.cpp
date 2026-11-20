// wa::Convolver (see convolver.h). Normalisation scale: port of Chromium 157.0.8103.78
// third_party/blink/renderer/platform/audio/reverb.cc CalculateNormalizationScale.
//
// Copyright 2010 Google Inc. All rights reserved (the Chromium Authors; BSD-3, third_party/chromium/LICENSE) for the
// ported normalisation; the partitioned convolution itself is this file's own (ARCHITECTURE section 4).
#include "dsp/convolver.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <new>

#include "num/js_math.h"
#include "pffft.h"

namespace rig::wa {
namespace {

struct StageDef {
  std::size_t start, end;
  unsigned block;
};
// end = SIZE_MAX: the last stage covers the rest of the response.
constexpr StageDef kDefs[ConvolverKernel::kStages] = {
    {128, 2048, 128}, {2048, 16384, 1024}, {16384, static_cast<std::size_t>(-1), 8192}};

float *allocFloats(std::size_t n) {
  void *p = pffft_aligned_malloc(n * sizeof(float));
  if (!p) throw std::bad_alloc();
  std::memset(p, 0, n * sizeof(float));
  return static_cast<float *>(p);
}

/** pffft setups for the three FFT sizes: created once on first use (control side), read-only afterwards. */
const PFFFT_Setup *setupFor(unsigned fftSize) {
  static PFFFT_Setup *const s256 = pffft_new_setup(256, PFFFT_REAL);
  static PFFFT_Setup *const s2048 = pffft_new_setup(2048, PFFFT_REAL);
  static PFFFT_Setup *const s16384 = pffft_new_setup(16384, PFFFT_REAL);
  return fftSize == 256 ? s256 : fftSize == 2048 ? s2048 : s16384;
}

}  // namespace

ConvolverKernel::ConvolverKernel(const float *ir, std::size_t length, float scale) : length_(length) {
  directTaps_ = std::min(length, kDirectTaps);
  for (std::size_t t = 0; t < directTaps_; ++t) direct_[t] = ir[t] * scale;
  bytes_ = sizeof(direct_);
  std::size_t maxN = 0;
  for (unsigned s = 0; s < kStages; ++s) maxN = std::max<std::size_t>(maxN, 2u * kDefs[s].block);
  float *work = allocFloats(2 * maxN);
  for (unsigned s = 0; s < kStages; ++s) {
    const StageDef &d = kDefs[s];
    Stage &st = stages_[s];
    st.start = d.start;
    st.block = d.block;
    if (length <= d.start) continue;
    const std::size_t end = std::min(length, d.end);
    const std::size_t B = d.block, N = 2 * B;
    st.parts = static_cast<unsigned>((end - d.start + B - 1) / B);
    st.spectra = allocFloats(st.parts * N);
    bytes_ += st.parts * N * sizeof(float);
    const PFFFT_Setup *setup = setupFor(static_cast<unsigned>(N));
    const float norm = scale / static_cast<float>(N);  // pffft is unnormalised: IFFT(FFT(x)) = N x
    for (unsigned p = 0; p < st.parts; ++p) {
      float *buf = work;  // [h segment | zeros]
      std::memset(buf, 0, N * sizeof(float));
      const std::size_t t0 = d.start + p * B, t1 = std::min(end, t0 + B);
      for (std::size_t t = t0; t < t1; ++t) buf[t - t0] = ir[t] * norm;
      pffft_transform(setup, buf, st.spectra + p * N, work + maxN, PFFFT_FORWARD);
    }
  }
  pffft_aligned_free(work);
}

ConvolverKernel::~ConvolverKernel() {
  for (Stage &s : stages_) pffft_aligned_free(s.spectra);
}

Convolver::Convolver(const ConvolverKernel &kernel, unsigned phase) : k_(kernel) {
  std::size_t maxN = 256;
  std::size_t coverage = k_.directTaps();
  for (unsigned s = 0; s < ConvolverKernel::kStages; ++s) {
    const ConvolverKernel::Stage &ks = k_.stage(s);
    if (!ks.parts) continue;
    const std::size_t B = ks.block, N = 2 * B;
    StageState &st = st_[s];
    st.quanta = static_cast<unsigned>(B / kQuantum);
    st.in = allocFloats(N);
    st.fdl = allocFloats(ks.parts * N);
    st.acc = allocFloats(N);
    st.ready = allocFloats(B);
    // stagger (phase 0 / 1 = the two channels of a stereo IR): stage 2 starts at step 4 phase, stage 3 at
    // 59 + 29 phase, so the 16384-point FFTs and IFFTs of the two channels and the 2048-point FFTs of the same
    // channel never share a quantum
    if (s == 1) st.step = (4u * phase) % st.quanta;
    if (s == 2) st.step = (59u + 29u * phase) % st.quanta;
    bytes_ += (N + ks.parts * N + N + B) * sizeof(float);
    maxN = std::max(maxN, N);
    // input at frame f stops influencing the state once its window and every FDL slot holding it are gone
    coverage = std::max(coverage, ks.start + static_cast<std::size_t>(ks.parts + 4) * B);
  }
  work_ = allocFloats(2 * maxN);
  bytes_ += 2 * maxN * sizeof(float);
  tail_ = coverage + 2 * kQuantum;
}

Convolver::~Convolver() {
  for (StageState &s : st_) {
    pffft_aligned_free(s.in);
    pffft_aligned_free(s.fdl);
    pffft_aligned_free(s.acc);
    pffft_aligned_free(s.ready);
  }
  pffft_aligned_free(work_);
}

void Convolver::reset() {
  std::memset(hist_, 0, sizeof hist_);
  for (unsigned s = 0; s < ConvolverKernel::kStages; ++s) {
    const ConvolverKernel::Stage &ks = k_.stage(s);
    if (!ks.parts) continue;
    const std::size_t B = ks.block, N = 2 * B;
    StageState &st = st_[s];
    std::memset(st.in, 0, N * sizeof(float));
    std::memset(st.fdl, 0, ks.parts * N * sizeof(float));
    std::memset(st.acc, 0, N * sizeof(float));
    std::memset(st.ready, 0, B * sizeof(float));
  }
}

void Convolver::mac(unsigned s, unsigned from, unsigned to) {
  const ConvolverKernel::Stage &ks = k_.stage(s);
  StageState &st = st_[s];
  const std::size_t N = 2u * ks.block;
  const PFFFT_Setup *setup = setupFor(static_cast<unsigned>(N));
  for (unsigned p = from; p < to; ++p) {
    const unsigned slot = (st.fdlPos + ks.parts - p) % ks.parts;  // X_{j-p}
    pffft_zconvolve_accumulate(setup, st.fdl + slot * N, ks.spectra + p * N, st.acc, 1.0f);
  }
}

void Convolver::runStage(unsigned s, const float *in, float *out) {
  const ConvolverKernel::Stage &ks = k_.stage(s);
  StageState &st = st_[s];
  const std::size_t B = ks.block, N = 2 * B;
  const PFFFT_Setup *setup = setupFor(static_cast<unsigned>(N));
  float *const scratch = work_;
  float *const fftWork = work_ + N;
  if (st.quanta == 1) {
    // stage 1 (tap offset B): this quantum's input completes block j; Y_{j+1} is computed now, played next quantum
    for (std::size_t i = 0; i < kQuantum; ++i) out[i] += st.ready[i];
    std::memcpy(st.in, st.in + B, B * sizeof(float));
    std::memcpy(st.in + B, in, B * sizeof(float));
    st.fdlPos = (st.fdlPos + 1) % ks.parts;
    pffft_transform(setup, st.in, st.fdl + st.fdlPos * N, fftWork, PFFFT_FORWARD);
    std::memset(st.acc, 0, N * sizeof(float));
    mac(s, 0, ks.parts);
    pffft_transform(setup, st.acc, scratch, fftWork, PFFFT_BACKWARD);
    std::memcpy(st.ready, scratch + B, B * sizeof(float));
    return;
  }
  // stages 2 and 3 (tap offset 2B): period j+1 computes Y_{j+2} from the windows up to block j
  const unsigned k = st.step;
  const float *r = st.ready + k * kQuantum;
  for (std::size_t i = 0; i < kQuantum; ++i) out[i] += r[i];
  if (k == 0) {  // block j completed in the previous quantum
    st.fdlPos = (st.fdlPos + 1) % ks.parts;
    pffft_transform(setup, st.in, st.fdl + st.fdlPos * N, fftWork, PFFFT_FORWARD);
    std::memcpy(st.in, st.in + B, B * sizeof(float));
    std::memset(st.acc, 0, N * sizeof(float));
  }
  const unsigned macSteps = st.quanta - 2;  // steps 1 .. quanta-2 carry the MACs
  if (k >= 1 && k <= macSteps) mac(s, (k - 1) * ks.parts / macSteps, k * ks.parts / macSteps);
  if (k == st.quanta - 1) {
    pffft_transform(setup, st.acc, scratch, fftWork, PFFFT_BACKWARD);
    std::memcpy(st.ready, scratch + B, B * sizeof(float));
  }
  std::memcpy(st.in + B + k * kQuantum, in, kQuantum * sizeof(float));
  st.step = k + 1 == st.quanta ? 0 : k + 1;
}

void Convolver::process(const float *in, float *out) {
  std::memcpy(hist_ + kQuantum, in, kQuantum * sizeof(float));
  float y[kQuantum] = {};
  const float *__restrict h = k_.direct();
  for (std::size_t t = 0; t < k_.directTaps(); ++t) {
    const float hv = h[t];
    const float *__restrict x = hist_ + kQuantum - t;
    for (std::size_t n = 0; n < kQuantum; ++n) y[n] += hv * x[n];
  }
  for (unsigned s = 0; s < ConvolverKernel::kStages; ++s)
    if (k_.stage(s).parts) runStage(s, hist_ + kQuantum, y);
  std::memcpy(hist_, hist_ + kQuantum, kQuantum * sizeof(float));
  std::memcpy(out, y, sizeof y);
}

float chromiumNormalizationScale(const float *const *channels, unsigned numChannels, std::size_t length,
                                 double sampleRate) {
  // vector_math::Vsvesq per channel (x86 SSE: four float lanes, then the lanes summed), summed in float
  float power = 0;
  for (unsigned c = 0; c < numChannels; ++c) {
    const float *p = channels[c];
    float lane[4] = {0, 0, 0, 0};
    std::size_t i = 0;
    for (; i + 4 <= length; i += 4)
      for (int l = 0; l < 4; ++l) lane[l] += p[i + l] * p[i + l];
    float sum = (lane[0] + lane[1]) + (lane[2] + lane[3]);
    for (; i < length; ++i) sum += p[i] * p[i];
    power += sum;
  }
  power = std::sqrt(power / static_cast<float>(numChannels * length));
  constexpr float kMinPower = 0.000125f;
  if (!std::isfinite(power) || power < kMinPower) power = kMinPower;
  float scale = 1 / power;
  // fdlibm::powf(10, kGainCalibration * 0.05f) with kGainCalibration = -58: a constant, taken as the correctly
  // rounded float of 10^(float)(-2.9f) via Math.pow (fdlibm's powf is accurate to < 1 ulp; checked only through the
  // normalised ConvolverNode vectors, which agree to float rounding)
  scale *= static_cast<float>(rig::js::pow(10.0, static_cast<double>(-58.0f * 0.05f)));
  if (sampleRate > 0) scale *= static_cast<float>(44100.0f / static_cast<float>(sampleRate));
  if (numChannels == 4) scale *= 0.5f;
  return scale;
}

}  // namespace rig::wa
