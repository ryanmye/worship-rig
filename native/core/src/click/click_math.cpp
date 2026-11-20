// Ports of app/js/shared/click-math.js (meterOf, ClickGrid) and metronome.js clickSamples (T07). See click_math.h.
#include "click/click_math.h"

#include <cmath>

#include "num/js_math.h"

namespace rig::click {

double jsFloor(double x) {
  return std::floor(x);
}
double jsRound(double x) {
  return js::round(x);
}

namespace {

struct SigRow {
  const char *sig;
  double n, d;
};
constexpr SigRow kSigs[] = {{"4/4", 4, 4}, {"3/4", 3, 4}, {"2/4", 2, 4}, {"5/4", 5, 4}, {"6/8", 6, 8}, {"12/8", 12, 8}};

/** Math.max(a, b) for the non-NaN values used here, with +0 over -0 (as JS). */
double jsMax(double a, double b) {
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

}  // namespace

Meter meterOf(std::string_view sig) {
  const SigRow *r = &kSigs[0];
  for (const SigRow &s : kSigs)
    if (sig == s.sig) r = &s;
  const bool compound = r->d == 8 && std::fmod(r->n, 3) == 0;
  Meter m;
  m.sig = r->sig;
  m.beats = compound ? r->n / 3 : r->n;
  m.sub = compound ? 3 : 1;
  m.ppb = compound ? kMidiPpq * 1.5 : kMidiPpq;
  return m;
}

double ClickGrid::jsMod(double a, double n) {
  return std::fmod(a, n);
}
double ClickGrid::posMod(double a, double n) {
  return std::fmod(std::fmod(a, n) + n, n);
}
double ClickGrid::floorEps(double beat) {
  return std::floor(beat + kEps);
}

ClickGrid::ClickGrid(double t0, double bpm, std::string_view sig, int countIn) {
  const Meter meter = meterOf(sig);
  segs_.push_back({t0, 0, 60 / bpm, meter, 0});
  countInBars_ = (countIn == 0 || countIn == 1 || countIn == 2) ? countIn : 0;  // COUNT_IN_BARS.includes
  downbeat_ = countInBars_ * meter.beats;
}

const ClickGrid::Segment &ClickGrid::segOfBeat(double b) const {
  std::size_t i = segs_.size() - 1;
  while (i > 0 && segs_[i].beat0 > b + kEps) --i;
  return segs_[i];
}

const ClickGrid::Segment &ClickGrid::segOfTime(double t) const {
  std::size_t i = segs_.size() - 1;
  while (i > 0 && segs_[i].t0 > t + kEps) --i;
  return segs_[i];
}

double ClickGrid::beatTime(double b) const {
  const Segment &g = segOfBeat(b);
  return g.t0 + (b - g.beat0) * g.spb;
}

double ClickGrid::beatAt(double t) const {
  const Segment &g = segOfTime(t);
  return g.beat0 + (t - g.t0) / g.spb;
}

ClickGrid::Retimed ClickGrid::retime(double tMin, double bpm, std::string_view sig, bool newBar) {
  const double b = jsMax(std::ceil(beatAt(tMin) - 1e-6), 0);
  const double t = beatTime(b);
  const Segment base = segOfBeat(b);  // copy: the list is filtered below
  const Meter meter = sig.empty() ? base.meter : meterOf(sig);
  const bool barStart = newBar || std::string_view(meter.sig) != base.meter.sig ||
                        (std::fabs(base.beat0 - b) < kEps && base.bar0 == b);
  std::vector<Segment> kept;
  kept.reserve(segs_.size() + 1);
  for (const Segment &g : segs_)
    if (g.beat0 < b - kEps) kept.push_back(g);
  kept.push_back({t, b, bpm > 0 ? 60 / bpm : base.spb, meter, barStart ? b : base.bar0});
  segs_.swap(kept);
  if (barStart && b < downbeat_) downbeat_ = b + countInBars_ * meter.beats;  // the count-in restarts
  return {b, t};
}

// ---- click sound ---------------------------------------------------------------------------------------------------

namespace {
constexpr double kLenSec = 0.04, kAttackSec = 0.0003, kDecayTc = 0.008;  // CLICK_LEN_SEC, _ATTACK_SEC, _DECAY_TC
constexpr double kPeak = 0.5;                                              // CLICK_PEAK
}  // namespace

double clickHz(TickKind k) {
  return k == TickKind::Accent ? 1980 : 1320;
}
double clickPeak(TickKind k) {
  return kPeak * (k == TickKind::Accent ? 1 : k == TickKind::Beat ? 0.55 : 0.3);
}

std::vector<float> clickSamples(double sr, double hz, double peak) {
  const double nd = js::round(kLenSec * sr);
  const std::size_t n = nd > 0 ? static_cast<std::size_t>(nd) : 0;
  const double att = jsMax(1, js::round(kAttackSec * sr));
  const double fade = js::round(0.005 * sr);
  std::vector<float> out(n);
  double max = 0;
  for (std::size_t i = 0; i < n; ++i) {
    const double di = static_cast<double>(i);
    const double env = std::fmin(1, (di + 1) / att) * js::exp(-di / (kDecayTc * sr)) *
                       std::fmin(1, (nd - 1 - di) / fade);
    const double w = 2 * js::kPi * hz * (di / sr);
    out[i] = static_cast<float>(env * (js::cos(w) + 0.25 * js::cos(2 * w)));
    max = jsMax(max, std::fabs(static_cast<double>(out[i])));
  }
  const double k = max > 0 ? peak / max : 0;
  for (std::size_t i = 0; i < n; ++i) out[i] = static_cast<float>(static_cast<double>(out[i]) * k);
  return out;
}

}  // namespace rig::click
