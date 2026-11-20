// wa::StereoPanner: StereoPannerNode, a port of Chromium 157.0.8103.78
// third_party/blink/renderer/platform/audio/stereo_panner.cc and modules/webaudio/stereo_panner_handler.cc
// (Copyright 2014 The Chromium Authors, BSD-3; third_party/chromium/LICENSE). Equal-power law (contract 3.1): mono
// input x = (p+1)/2, L = cos(x pi/2), R = sin(x pi/2); stereo input p <= 0: L = inL + inR cos((p+1) pi/2),
// R = inR sin((p+1) pi/2); p > 0: L = inL cos(p pi/2), R = inR + inL sin(p pi/2). Two code paths as in Chromium:
// an automated pan (sample-accurate values) uses double gains per frame, a constant pan float gains and float
// multiply-adds (Vsmul / Vsma). cos / sin are fdlibm (rig::fdlibm). RT-safe.
#pragma once
#include <cstddef>
#include <cstdint>

#include "time/param.h"

namespace rig::wa {

class StereoPanner {
 public:
  explicit StereoPanner(double pan = 0.0) : pan_(pan, -1.0f, 1.0f) {}
  Param &pan() { return pan_; }

  /**
   * One quantum (n <= 128): `nch` (1|2) input channels -> 2 output channels. Output may alias the input channels
   * (in[0] == outL, in[1] == outR); the left / right reads happen before the writes of each frame.
   */
  void process(const float *const *in, unsigned nch, float *outL, float *outR, std::size_t n, std::int64_t frame0,
               double sampleRate);

  /** The two laws on one frame, double path (tests, diagnostics). */
  static void panSampleAccurate(float inL, float inR, unsigned nch, float pan, float &outL, float &outR);

 private:
  Param pan_;
};

}  // namespace rig::wa
