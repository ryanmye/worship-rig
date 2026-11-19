// Sample-rate conversion of decoded files, as `decodeAudioData` does it (M10, contract Q13).
//
// Port of Chromium's windowed-sinc resampler (media/base/sinc_resampler.cc, also third_party/blink
// platform/audio/sinc_resampler.cc): 32-tap Blackman-windowed sinc, 32 sub-sample kernels with linear interpolation
// between neighbours, 512-frame request blocks, zero history before the first frame. The port follows the revision
// that rendered the goldens, Chromium 157.0.8103.78 (BSD-3 notice: third_party/chromium/LICENSE, orchestrator item
// R24). Parity against the golden Chromium's own decodeAudioData output is MEASURED, not assumed: see
// tests/test_samples_decode.cpp and the T06 report.
#pragma once
#include <cstddef>
#include <vector>

namespace rig::samples {

/** Output length decodeAudioData produces: round(frames * outRate / inRate) (measured on the golden Chromium). */
std::size_t resampledLength(std::size_t frames, double inRate, double outRate);

/** Resample one channel. `out` is resized to resampledLength(). inRate == outRate copies. */
void resampleChannel(const std::vector<float> &in, double inRate, double outRate, std::vector<float> &out);

}  // namespace rig::samples
