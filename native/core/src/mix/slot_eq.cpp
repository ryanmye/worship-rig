#include "mix/slot_eq.h"

#include <cmath>

namespace rig {
namespace {
const double kButterQ = 20.0 * std::log10(0.70710678118654752440);  // BUTTER2_Q (-3.0103 dB)
}

std::size_t buildEqChain(const SlotEqSpec &s, EqFilter out[kMaxEqFilters]) {
  std::size_t n = 0;
  if (s.cutHz > 20.5) out[n++] = {wa::BiquadType::Highpass, s.cutHz, kButterQ, 0.0};
  for (const EqBand &b : s.bands) {
    if (!b.on || b.type == EqOff) continue;
    switch (b.type) {
      case EqLowshelf: out[n++] = {wa::BiquadType::Lowshelf, b.hz, 0.0, b.db}; break;
      case EqHighshelf: out[n++] = {wa::BiquadType::Highshelf, b.hz, 0.0, b.db}; break;
      case EqPeak: out[n++] = {wa::BiquadType::Peaking, b.hz, b.q, b.db}; break;
      case EqNotch: out[n++] = {wa::BiquadType::Notch, b.hz, b.q, 0.0}; break;
      case EqLowcut: out[n++] = {wa::BiquadType::Highpass, b.hz, 20.0 * std::log10(b.q), 0.0}; break;
      case EqHighcut: out[n++] = {wa::BiquadType::Lowpass, b.hz, 20.0 * std::log10(b.q), 0.0}; break;
      default: break;
    }
  }
  if (s.hiCutHz < 19999.0) out[n++] = {wa::BiquadType::Lowpass, s.hiCutHz, kButterQ, 0.0};
  return n;
}

void SlotEq::configure(const SlotEqSpec &spec, double sr) {
  EqFilter nf[kMaxEqFilters];
  const std::size_t n = buildEqChain(spec, nf);
  bool same = n == count_;
  for (std::size_t i = 0; same && i < n; ++i) same = nf[i].type == f_[i].type;
  for (std::size_t i = 0; i < n; ++i) {
    f_[i] = nf[i];
    for (auto &ch : bq_) {
      if (!same) ch[i].reset();
      ch[i].set(f_[i].type, f_[i].hz, f_[i].q, f_[i].db, sr);
    }
  }
  count_ = n;
}

void SlotEq::process(float *const *ch, int nch, std::size_t n) {
  for (int c = 0; c < nch; ++c) {
    for (std::size_t i = 0; i < count_; ++i) bq_[c][i].process(ch[c], ch[c], n);
  }
}

}  // namespace rig
