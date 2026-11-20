// MasterEq (mix/master_eq.h, contract 3.8; fx.js:2170-2173): eqIn -> lowshelf 100 Hz -> peaking 1 kHz (Q .8) ->
// highshelf 8 kHz, three BiquadFilterNodes in series with their default (a-rate) params, as the JS builds them:
// while a gain moves (fx.eq.* rampTo tau 15 ms) the coefficients follow per frame, exactly as Chromium's
// BiquadFilterHandler does for a-rate automation; constant gains use one coefficient set per quantum. (The frozen
// header's "k-rate" note describes the slot EQ; the master EQ nodes are not switched to k-rate in fx.js.) The set
// handler `fx.eq.` belongs to the master chain (T03, BUILD_PLAN), which owns this object.
#include "mix/master_eq.h"

#include <algorithm>

#include "dsp/biquad.h"

namespace rig {

struct MasterEq::Impl {
  wa::BiquadFilter bq[3] = {wa::BiquadFilter(wa::BiquadType::Lowshelf, 100, 1, 0),
                            wa::BiquadFilter(wa::BiquadType::Peaking, 1000, 0.8, 0),
                            wa::BiquadFilter(wa::BiquadType::Highshelf, 8000, 1, 0)};
};

MasterEq::MasterEq(double, double lowDb, double midDb, double highDb) : impl_(new Impl) {
  const double db[3] = {lowDb, midDb, highDb};
  for (int b = 0; b < 3; ++b) impl_->bq[b].gain().setValue(db[b]);
}

MasterEq::~MasterEq() {
  delete impl_;
}

void MasterEq::setSampleRate(double) {}  // coefficients follow the rate passed to process()

wa::Param *MasterEq::gain(int band) {
  return band >= 0 && band < 3 ? &impl_->bq[band].gain() : nullptr;
}

void MasterEq::process(Bus &bus, std::int64_t frame0, double sampleRate) {
  const unsigned nch = std::clamp(bus.channels, 1u, 2u);
  float *ch[2] = {bus.ch[0], bus.ch[1]};
  for (auto &f : impl_->bq) f.process(ch, nch, kQ, frame0, sampleRate);
}

}  // namespace rig
