// Slot width: the wIn / wMid / wNeg / wSide / wNarrow / wHp / wWide / wOut GainNode graph of fx.js Channel as one
// stage, with Chromium's arithmetic per node (speakers down-mix (L+R)*0.5f, float gain products, node sums).
#include "mix/width.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "num/js_math.h"
#include "time/automation.h"

namespace rig {

Width::Width() : narrow_(0.0), wide_(0.0), hp_(wa::BiquadType::Highpass, kSideHpHz, 20 * js::log10(js::kSqrt1_2), 0) {}

void Width::gainsFor(double w, double &narrow, double &wide) {
  const double x = std::min(kMax, std::max(0.0, std::isfinite(w) ? w : 1.0));
  narrow = std::min(1.0, x) - 1;
  wide = std::max(0.0, x - 1);
}

void Width::setWidth(double w, double when, bool step, std::int64_t nowFrame, double sr) {
  double n, wd;
  gainsFor(w, n, wd);
  narrow().setContextTime(nowFrame, sr);
  wide().setContextTime(nowFrame, sr);
  if (step) {
    wa::setNow(narrow(), n, when);
    wa::setNow(wide(), wd, when);
  } else {
    wa::rampTo(narrow(), n, when, wa::kTau);
    wa::rampTo(wide(), wd, when, wa::kTau);
  }
}

void Width::advance(std::size_t n, std::int64_t frame0, double sr) {
  float g[wa::Param::kQuantum];
  bool c;
  narrow_.values(g, &c, n, frame0, sr);
  wide_.values(g, &c, n, frame0, sr);
  hp_.processParamsOnly(n, frame0, sr);
}

void Width::process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr) {
  if (nch < 2) {
    // mono: S = x - x = 0, so wNarrow / wWide carry silence and wOut = x exactly; the params still advance
    float g[wa::Param::kQuantum];
    bool c;
    narrow_.values(g, &c, n, frame0, sr);
    wide_.values(g, &c, n, frame0, sr);
    float z[wa::Param::kQuantum] = {};  // wHp sees a silent mono side (a later stereo input re-initialises it)
    float *zc[1] = {z};
    hp_.process(zc, 1, n, frame0, sr);
    return;
  }
  float sideL[wa::Param::kQuantum], sideR[wa::Param::kQuantum];
  float nL[wa::Param::kQuantum], nR[wa::Param::kQuantum];
  for (std::size_t i = 0; i < n; ++i) {
    const float m = (ch[0][i] + ch[1][i]) * 0.5f;  // wMid: explicit 1 channel, speakers down-mix
    const float neg = m * -1.0f;                   // wNeg
    sideL[i] = ch[0][i] + neg;                     // wSide = wIn + up-mixed wNeg
    sideR[i] = ch[1][i] + neg;
  }
  float *side[2] = {sideL, sideR};
  float *nar[2] = {nL, nR};
  narrow_.process(side, nar, 2, n, frame0, sr);
  hp_.process(side, 2, n, frame0, sr);  // wHp (in place on the side signal; wNarrow already has its copy)
  wide_.process(side, side, 2, n, frame0, sr);
  for (unsigned c = 0; c < 2; ++c)
    for (std::size_t i = 0; i < n; ++i) ch[c][i] = ch[c][i] + nar[c][i] + side[c][i];  // wOut = wIn + wNarrow + wWide
}

}  // namespace rig
