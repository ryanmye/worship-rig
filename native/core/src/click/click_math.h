// Click grid math and click sound (T07): ports of app/js/shared/click-math.js (meterOf, ClickGrid) and
// app/js/engine/metronome.js clickSamples(). Control thread only (the grid allocates its segment list).
// Every value follows the JS double arithmetic step by step (Math.floor/ceil/round, % and the EPS tests), so tick
// and MIDI-clock pulse times are bit-identical to the JS engine (tests/test_click_grid.cpp replays
// tools/golden/vectors/data/click-grid.txt, dumped from the real modules by tools/golden/vectors/dump-click.mjs).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

namespace rig::click {

// JS Math helpers (exact, no fast-math): Math.floor, Math.round (rig::js::round), Infinity.
double jsFloor(double x);
double jsRound(double x);
inline constexpr double kInf = __builtin_inf();

inline constexpr double kMidiPpq = 24;  // MIDI_PPQ
inline constexpr std::uint8_t kMidiClock = 0xf8, kMidiStart = 0xfa, kMidiStop = 0xfc;
inline constexpr double kDefaultLevel = 0.6;  // CLICK_DEFAULTS.level

/** meterOf(sig): a known time signature (TIME_SIGS) else 4/4. */
struct Meter {
  const char *sig = "4/4";
  double beats = 4;  // beats per bar
  double sub = 1;    // clicks per beat (3 for compound meters)
  double ppb = 24;   // MIDI clock pulses per beat (36 for compound meters)
};
Meter meterOf(std::string_view sig);

enum class TickKind : std::uint8_t { Accent = 0, Beat = 1, Sub = 2 };  // = ClickOp::Schedule aux

struct Tick {
  double t, beat;
  TickKind kind;
  bool countIn;
  double beatInBar;
};

/** ClickGrid (click-math.js): a list of tempo/meter segments in engine seconds. */
class ClickGrid {
 public:
  struct Segment {
    double t0, beat0, spb;
    Meter meter;
    double bar0;
  };

  ClickGrid(double t0, double bpm, std::string_view sig, int countIn);

  const Segment &segOfBeat(double b) const;
  const Segment &segOfTime(double t) const;
  double beatTime(double b) const;
  double beatAt(double t) const;
  double downbeatTime() const { return beatTime(downbeat_); }
  double downbeat() const { return downbeat_; }
  double bpm() const { return 60 / segs_.back().spb; }
  const Meter &meter() const { return segs_.back().meter; }
  const std::vector<Segment> &segments() const { return segs_; }

  struct Retimed {
    double beat, t;
  };
  /** retime(tMin, {bpm, sig, newBar}): bpm <= 0 / sig empty = unchanged ("undefined" in the JS). */
  Retimed retime(double tMin, double bpm, std::string_view sig, bool newBar);

  /** ticks(tFrom, tTo): fn(const Tick&) for each click with a time in [tFrom, tTo). */
  template <class F>
  void ticks(double tFrom, double tTo, F &&fn) const {
    walk(tFrom, tTo, false, [&](const Segment &g, double k, double t) {
      const double sub = g.meter.sub;
      const double beat = g.beat0 + k / sub;
      const bool whole = jsMod(k, sub) == 0;
      const double beatInBar = posMod(floorEps(beat) - g.bar0, g.meter.beats);
      const TickKind kind = !whole ? TickKind::Sub : beatInBar == 0 ? TickKind::Accent : TickKind::Beat;
      fn(Tick{t, beat, kind, beat < downbeat_ - kEps, beatInBar});
    });
  }
  /** pulses(tFrom, tTo): fn(t) for each MIDI clock pulse in [tFrom, tTo). */
  template <class F>
  void pulses(double tFrom, double tTo, F &&fn) const {
    walk(tFrom, tTo, true, [&](const Segment &, double, double t) { fn(t); });
  }

 private:
  static constexpr double kEps = 1e-9;
  static double jsMod(double a, double n);  // JS a % n
  static double posMod(double a, double n);  // mod(a, n) = ((a % n) + n) % n
  static double floorEps(double beat);        // Math.floor(beat + EPS)
  template <class F>
  void walk(double tFrom, double tTo, bool pulses, F &&fn) const;

  std::vector<Segment> segs_;
  double countInBars_ = 0;
  double downbeat_ = 0;
};

/** _walk (click-math.js): grid points of every segment (n per beat) with times in [tFrom, tTo). */
template <class F>
void ClickGrid::walk(double tFrom, double tTo, bool pulses, F &&fn) const {
  const std::size_t n = segs_.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Segment &g = segs_[i];
    const double per = pulses ? g.meter.ppb : g.meter.sub;
    const double step = g.spb / per;
    const Segment *next = i + 1 < n ? &segs_[i + 1] : nullptr;
    const double kEnd = next ? jsRound((next->beat0 - g.beat0) * per) : kInf;
    const double tEnd = next ? next->t0 : kInf;
    if (tEnd <= tFrom + kEps || g.t0 >= tTo) continue;
    double k = jsFloor((tFrom - g.t0) / step) - 1;
    if (!(k >= 0)) k = 0;
    for (; k < kEnd; ++k) {
      const double t = g.t0 + k * step;
      if (t >= tTo - kEps) break;
      if (t < tFrom - kEps) continue;
      fn(g, k, t);
    }
  }
}

/** clickSamples(sr, hz, peak) (metronome.js): 40 ms, Float32 storage at every step as the JS Float32Array. */
std::vector<float> clickSamples(double sr, double hz, double peak);
/** The three click sounds: KIND_HZ and CLICK_PEAK x CLICK_KIND_GAIN of metronome.js, by TickKind. */
double clickHz(TickKind k);
double clickPeak(TickKind k);


}  // namespace rig::click
