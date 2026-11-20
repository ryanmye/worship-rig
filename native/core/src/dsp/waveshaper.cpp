// WaveShaper: port of Chromium 157.0.8103.78 third_party/blink/renderer/modules/webaudio/wave_shaper_handler.cc
// (WaveShaperHandler::Process, WaveShaperKernel, WaveShaperCurveValues). Copyright 2011 The Chromium Authors,
// BSD-3 (third_party/chromium/LICENSE: redistribution with or without modification permitted provided the notice,
// conditions and disclaimer are retained; no endorsement; "AS IS", no warranty).
//
// Curve lookup as the x86 build computes it (vector_math Vsadd / Vsmul / Vclip, cvttps, then v1 + f * (v2 - v1)
// as three separate float operations): float virtual index (x + 1) * (0.5 (n - 1)) clamped to [0, n - 1], index =
// truncation, clamped neighbours. Oversampling: per channel UpSampler(128) [+ UpSampler(256)] -> curve ->
// [DownSampler(512) ->] DownSampler(256), sub-block 128 frames; latency 0 / 128 / 192 frames. A change of the
// channel count re-initialises the kernels (fresh resampler state), as CheckNumberOfChannelsForInput does.
#include "dsp/waveshaper.h"

#include <algorithm>
#include <cstring>
#include <memory>

#include "dsp/resampler_updown.h"

namespace rig::wa {
namespace {

constexpr std::size_t kSubBlock = 128;  // kMaxSubBlockFrames (render quantum 128)

/** WaveShaperHandler::WaveShaperCurveValues, in place allowed (dst may equal src). */
void curveValues(float *dst, const float *src, std::size_t n, const float *curve, std::size_t len) {
  const float scale = static_cast<float>(0.5 * static_cast<double>(len - 1));
  const float hi = static_cast<float>(len - 1);
  const int maxIndex = static_cast<int>(len - 1);
  for (std::size_t k = 0; k < n; ++k) {
    float v = src[k] + 1.0f;  // Vsadd
    v = v * scale;            // Vsmul
    // Vclip (SSE max/min against the bounds; a NaN index lands on the lower clamp below)
    v = std::min(std::max(v, 0.0f), hi);
    const int i1 = v == v ? static_cast<int>(v) : 0;  // _mm_cvttps_epi32 (NaN -> INT_MIN -> clamped to 0)
    const float index = static_cast<float>(i1);
    const float v1 = curve[std::clamp(i1, 0, maxIndex)];
    const float v2 = curve[std::clamp(i1 + 1, 0, maxIndex)];
    const float f = v - index;
    float d = v2 - v1;
    d = f * d;
    dst[k] = d + v1;
  }
}

}  // namespace

struct WaveShaper::Impl {
  const float *curve = nullptr;
  std::size_t n = 0;
  const float *pendingCurve = nullptr;
  std::size_t pendingN = 0;
  bool hasPending = false;
  Oversample os;
  unsigned lastChannels = 0;
  struct Kernel {
    UpSampler up{kSubBlock}, up2{kSubBlock * 2};
    DownSampler down{kSubBlock * 2}, down2{kSubBlock * 4};
    alignas(16) float temp[kSubBlock * 2] = {};
    alignas(16) float temp2[kSubBlock * 4] = {};
    void reset() {
      up.reset();
      up2.reset();
      down.reset();
      down2.reset();
    }
  };
  std::unique_ptr<Kernel> k[2];
};

WaveShaper::WaveShaper(const float *curve, std::size_t n, Oversample os, unsigned channels) : impl_(new Impl) {
  impl_->curve = n ? curve : nullptr;
  impl_->n = curve ? n : 0;
  impl_->os = os;
  impl_->lastChannels = channels;
  if (os != Oversample::None)
    for (auto &k : impl_->k) k = std::make_unique<Impl::Kernel>();
}

WaveShaper::~WaveShaper() {
  delete impl_;
}

void WaveShaper::setCurve(const float *curve, std::size_t n) {
  impl_->pendingCurve = n ? curve : nullptr;
  impl_->pendingN = curve ? n : 0;
  impl_->hasPending = true;
}

double WaveShaper::latencyFrames() const {
  switch (impl_->os) {
    case Oversample::None:
      return 0.0;
    case Oversample::X2:
      return static_cast<double>(impl_->k[0]->up.latencyFrames() + impl_->k[0]->down.latencyFrames());
    case Oversample::X4:
      return static_cast<double>(impl_->k[0]->up.latencyFrames() + impl_->k[0]->down.latencyFrames() +
                                 (impl_->k[0]->up2.latencyFrames() + impl_->k[0]->down2.latencyFrames()) / 2);
  }
  return 0.0;
}

void WaveShaper::process(float *const *ch, unsigned channels, std::size_t n) {
  Impl &m = *impl_;
  if (m.hasPending) {
    m.curve = m.pendingCurve;
    m.n = m.pendingN;
    m.hasPending = false;
  }
  if (channels > 2) channels = 2;
  if (channels != m.lastChannels) {  // Uninitialize + Initialize: new kernels
    m.lastChannels = channels;
    if (m.os != Oversample::None)
      for (auto &k : m.k) k->reset();
  }
  if (!m.curve || m.n == 0) return;  // no curve: pass-through
  for (unsigned c = 0; c < channels; ++c) {
    float *x = ch[c];
    if (m.os == Oversample::None) {
      curveValues(x, x, n, m.curve, m.n);
      continue;
    }
    Impl::Kernel &k = *m.k[c];
    for (std::size_t off = 0; off < n; off += kSubBlock) {
      // the quantum is 128 frames = one sub-block (UpSampler/DownSampler block sizes are fixed at construction)
      float *chunk = x + off;
      if (m.os == Oversample::X2) {
        k.up.process(chunk, k.temp);
        curveValues(k.temp, k.temp, kSubBlock * 2, m.curve, m.n);
        k.down.process(k.temp, chunk);
      } else {
        k.up.process(chunk, k.temp);
        k.up2.process(k.temp, k.temp2);
        curveValues(k.temp2, k.temp2, kSubBlock * 4, m.curve, m.n);
        k.down2.process(k.temp2, k.temp);
        k.down.process(k.temp, chunk);
      }
    }
  }
}

}  // namespace rig::wa
