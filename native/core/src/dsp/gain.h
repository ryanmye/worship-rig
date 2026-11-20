// wa::Gain: GainNode (Chromium 157.0.8103.78 modules/webaudio/gain_handler.cc, BSD-3, The Chromium Authors;
// third_party/chromium/LICENSE): an a-rate gain AudioParam; with sample-accurate values out = in * g[i] (Vmul),
// else the timeline's value: 0 => silence, 1 => copy, other => in * g (Vsmul). Float products only, so this is
// bit-exact by construction; it exists so every strip / FX stage evaluates its param the way the node would
// (exactly one timeline evaluation per quantum). RT-safe.
#pragma once
#include <cstddef>
#include <cstdint>

#include "time/param.h"

namespace rig::wa {

class Gain {
 public:
  explicit Gain(double value = 1.0) : g_(value) {}
  Param &gain() { return g_; }

  /** One quantum of `nch` channels, out[c] = in[c] * gain (in == out allowed). */
  void process(const float *const *in, float *const *out, unsigned nch, std::size_t n, std::int64_t frame0,
               double sampleRate);
  /** Evaluate the gain for this quantum only: fills g[0..n) (or g[0] when *constant). */
  void values(float *g, bool *constant, std::size_t n, std::int64_t frame0, double sampleRate);

 private:
  Param g_;
};

}  // namespace rig::wa
