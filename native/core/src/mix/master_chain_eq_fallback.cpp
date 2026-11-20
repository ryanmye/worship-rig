// T03 stand-in for T02's MasterEq (mix/master_eq.h is FROZEN; its implementation mix/master_eq.cpp is T02's). Compiled
// only while src/mix/master_eq.cpp does not exist (src/mix/master_chain.cmake defines RIG_T03_MASTER_EQ_FALLBACK),
// so the master chain links and its golden fixtures render before T02 lands; it disables itself the moment T02's
// file appears (CMake re-globs). Behaviour: contract 3.8 master EQ = lowshelf 100 Hz, peaking 1 kHz Q .8, highshelf
// 8 kHz through wa::Biquad (Chromium coefficient formulas), gains k-rate (one value per quantum).
#include "mix/master_eq.h"

namespace rig {
/** Present in every build so the TU is never empty. */
extern const bool kMasterEqFallback;
#ifdef RIG_T03_MASTER_EQ_FALLBACK
const bool kMasterEqFallback = true;
#else
const bool kMasterEqFallback = false;
#endif
}  // namespace rig

#ifdef RIG_T03_MASTER_EQ_FALLBACK
#include <algorithm>

#include "dsp/biquad.h"
#include "time/param.h"

namespace rig {

struct MasterEq::Impl {
  double sr;
  wa::Param gain[3]{wa::Param(0.0, -40.0f, 40.0f), wa::Param(0.0, -40.0f, 40.0f), wa::Param(0.0, -40.0f, 40.0f)};
  float last[3] = {0, 0, 0};
  wa::Biquad bq[2][3];
  void configure(int b) {
    static constexpr wa::BiquadType kType[3] = {wa::BiquadType::Lowshelf, wa::BiquadType::Peaking,
                                                wa::BiquadType::Highshelf};
    static constexpr double kHz[3] = {100.0, 1000.0, 8000.0}, kQs[3] = {1.0, 0.8, 1.0};
    for (auto &ch : bq) ch[b].set(kType[b], kHz[b], kQs[b], last[b], sr);
  }
};

MasterEq::MasterEq(double sampleRate, double lowDb, double midDb, double highDb) : impl_(new Impl) {
  impl_->sr = sampleRate;
  const double db[3] = {lowDb, midDb, highDb};
  for (int b = 0; b < 3; ++b) {
    impl_->gain[b].setValue(db[b]);
    impl_->last[b] = static_cast<float>(impl_->gain[b].intrinsic());
    impl_->configure(b);
  }
}

MasterEq::~MasterEq() {
  delete impl_;
}

void MasterEq::setSampleRate(double sr) {
  impl_->sr = sr;
  for (int b = 0; b < 3; ++b) impl_->configure(b);
}

wa::Param *MasterEq::gain(int band) {
  return band >= 0 && band < 3 ? &impl_->gain[band] : nullptr;
}

void MasterEq::process(Bus &bus, std::int64_t frame0, double sampleRate) {
  Impl &m = *impl_;
  for (int b = 0; b < 3; ++b) {
    const float g = m.gain[b].processKRate(frame0, sampleRate);
    if (g != m.last[b] || sampleRate != m.sr) {
      m.last[b] = g;
      m.sr = sampleRate;
      m.configure(b);
    }
  }
  const unsigned nch = std::min(bus.channels, 2u);
  for (unsigned c = 0; c < nch; ++c)
    for (auto &f : m.bq[c]) f.process(bus.ch[c], bus.ch[c], kQ);
}

}  // namespace rig
#endif
