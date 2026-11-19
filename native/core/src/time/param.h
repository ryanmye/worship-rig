// wa::Param: AudioParam timeline (Web Audio / Chromium AudioParamTimeline semantics), fixed capacity, no allocation.
// T00 skeleton version: setValue / linear / exponential / setTarget / cancelAndHold with per-sample evaluation.
// T01 replaces the internals (valueCurve, Chromium's exact event-insertion and ramp-start rules, k-rate ties) but
// keeps this interface. Differences from Chromium that T01 must verify are marked VERIFY in param.cpp.
#pragma once
#include <cstddef>
#include <cstdint>

namespace rig::wa {

class Param {
 public:
  static constexpr std::size_t kCapacity = 64;

  explicit Param(double defaultValue = 0.0) : value_(defaultValue) {}

  /** `param.value = v` without events: the intrinsic value (used while the timeline is empty / before its events). */
  void setValue(double v) { value_ = v; }
  double intrinsic() const { return value_; }

  // Timeline events. Times are engine seconds. Return false (and count a drop) when the list is full.
  bool setValueAtTime(double v, double t);
  bool linearRampToValueAtTime(double v, double t);
  bool exponentialRampToValueAtTime(double v, double t);
  bool setTargetAtTime(double target, double t, double tau);
  /** Drop everything scheduled after t and hold the value the timeline has at t from t on. */
  void cancelAndHoldAtTime(double t);
  void cancelScheduledValues(double t);

  /** Value at time t (double precision, no state change except the search cursor). */
  double valueAt(double t) const;

  /** a-rate: out[i] = value at (frame0 + i) / sampleRate. Folds past events first (keeps the last one before frame0). */
  void processARate(std::int64_t frame0, double sampleRate, float *out, std::size_t n);
  /** k-rate: the value at the first frame of the quantum. */
  float processKRate(std::int64_t frame0, double sampleRate);

  std::size_t eventCount() const { return count_; }
  std::uint32_t dropped() const { return dropped_; }
  /** True when no event can change the value at or after time t (everything is in the past). */
  bool settledAt(double t) const;

 private:
  enum class Type : std::uint8_t { Set, Linear, Exp, Target };
  struct Event {
    Type type;
    double value;   // target value (Set/Linear/Exp end value, Target asymptote)
    double time;    // event time (ramp: END time)
    double tau;     // Target time constant
    double start;   // Target: value of the timeline at `time` before this event (the curve's starting value)
  };
  bool insert(const Event &e);
  double endValue(const Event &e) const { return e.value; }
  double eval(double t, std::size_t &cursor) const;
  void fold(double t);

  double value_;
  Event ev_[kCapacity];
  std::size_t count_ = 0;
  mutable std::size_t cursor_ = 0;
  std::uint32_t dropped_ = 0;
};

}  // namespace rig::wa
