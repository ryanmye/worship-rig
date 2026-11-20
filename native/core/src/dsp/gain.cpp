// GainNode processing (Chromium 157.0.8103.78 gain_handler.cc, BSD-3; third_party/chromium/LICENSE).
#include "dsp/gain.h"

#include <cstring>

namespace rig::wa {

void Gain::values(float *g, bool *constant, std::size_t n, std::int64_t frame0, double sr) {
  if (g_.hasSampleAccurateValues(frame0, sr)) {
    g_.processARate(frame0, sr, g, n);
    *constant = false;
  } else {
    g[0] = g_.processKRate(frame0, sr);
    *constant = true;
  }
}

void Gain::process(const float *const *in, float *const *out, unsigned nch, std::size_t n, std::int64_t frame0,
                   double sr) {
  float g[Param::kQuantum];
  bool constant = true;
  values(g, &constant, n, frame0, sr);
  for (unsigned c = 0; c < nch; ++c) {
    const float *x = in[c];
    float *y = out[c];
    if (!constant) {
      for (std::size_t i = 0; i < n; ++i) y[i] = x[i] * g[i];
    } else if (g[0] == 0.0f) {
      std::memset(y, 0, n * sizeof(float));
    } else if (g[0] == 1.0f) {
      if (y != x) std::memcpy(y, x, n * sizeof(float));
    } else {
      const float k = g[0];
      for (std::size_t i = 0; i < n; ++i) y[i] = x[i] * k;
    }
  }
}

}  // namespace rig::wa
