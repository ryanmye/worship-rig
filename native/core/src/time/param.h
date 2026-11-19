// wa::Param: AudioParam timeline, a port of Chromium 157.0.8103.78
// third_party/blink/renderer/modules/webaudio/audio_param_handler.cc (BSD-3, The Chromium Authors) and the AudioParam
// bindings in audio_param.cc. Ported: event insertion (upper-bound placement after equal times, curve overlap
// checks, implicit SetValue before a first ramp, pruning of past events), cancelScheduledValues, cancelAndHoldAtTime
// (CancelValues events with saved ramps, truncated curves), clamping of late events to the render time, and the
// render loop ValuesForFrameRangeImpl with its helpers: float event values, double times, setTarget as the
// per-sample recursion v += (target - v)·(1 - e^(-1/(tau·rate))) with tau rounded to float, the 10-tau / 4.54e-5
// convergence snap, exponential ramps as a running double product, setTarget→ramp hand-over, and Chromium's x86
// SSE code paths (4-lane float evaluation of linear ramps, setTarget and curves; the goldens are x86-64 renders)
// emulated in portable scalar float arithmetic. Math inside the kernel is Chromium's fdlibm (rig::fdlibm).
//
// Fixed capacity (kCapacity events), no allocation, RT-safe. A curve passed to setValueCurveAtTime is referenced, not
// copied: it must outlive every event that uses it.
//
// Rendering follows what a Web Audio node does with its param each quantum:
//   processARate: `HasSampleAccurateValues() ? CalculateSampleAccurateValues() : FinalValue()` (GainNode,
//                 ConstantSourceNode, StereoPanner, DelayNode, …)
//   processKRate: `FinalValue()` (automationRate 'k-rate', or k-rate params such as BufferSource.playbackRate)
// The render frame passed in is the context's frame; it also becomes the param's notion of `currentTime` for later
// insertions (ClampedToCurrentTime, pruning, the implicit SetValue of a first ramp). Callers that insert into a param
// that was not rendered recently should call setContextTime() first.
#pragma once
#include <cfloat>
#include <cstddef>
#include <cstdint>

namespace rig::wa {

class Param {
 public:
  static constexpr std::size_t kCapacity = 64;
  static constexpr std::size_t kQuantum = 128;  // RenderQuantumFrames()

  enum class Rate : std::uint8_t { ARate, KRate };

  explicit Param(double defaultValue = 0.0, float minValue = -FLT_MAX, float maxValue = FLT_MAX)
      : intrinsic_(clampF(static_cast<float>(defaultValue), minValue, maxValue)),
        default_(static_cast<float>(defaultValue)),
        min_(minValue),
        max_(maxValue) {}

  /** AudioParamHandler::SetValue: set the intrinsic value (clamped), no event (construction / `.value` read-back). */
  void setValue(double v) { intrinsic_ = clampF(static_cast<float>(v), min_, max_); }
  /** JS `param.value = v`: SetValue(v) then setValueAtTime(intrinsic, currentTime). */
  bool setValueAttribute(double v);
  /** The intrinsic value: what JS `param.value` returns on the main thread (last rendered value, clamped). */
  double intrinsic() const { return intrinsic_; }
  double defaultValue() const { return default_; }
  float minValue() const { return min_; }
  float maxValue() const { return max_; }

  /** Context time for insertions (CurrentSampleFrame / sampleRate on the main thread). */
  void setContextTime(std::int64_t frame, double sampleRate) {
    frame_ = frame < 0 ? 0 : static_cast<std::size_t>(frame);
    sr_ = sampleRate;
  }

  // Timeline events (times in engine seconds). Each returns false where JS would throw (non-finite or out-of-range
  // arguments, exponential ramp to 0, curve overlap) or when the list is full after pruning (counted in dropped()).
  bool setValueAtTime(double v, double t);
  bool linearRampToValueAtTime(double v, double t);
  bool exponentialRampToValueAtTime(double v, double t);
  bool setTargetAtTime(double target, double t, double tau);
  bool setValueCurveAtTime(const float *curve, std::uint32_t n, double t, double duration);
  bool cancelScheduledValues(double t);
  bool cancelAndHoldAtTime(double t);

  /** a-rate rendering of n frames starting at the context frame frame0 (n ≤ 128). */
  void processARate(std::int64_t frame0, double sampleRate, float *out, std::size_t n);
  /** k-rate rendering: the value for the quantum starting at frame0 (FinalValue()). */
  float processKRate(std::int64_t frame0, double sampleRate);
  /** Render with the given automation rate: a-rate as processARate, k-rate fills out[] with processKRate. */
  void process(Rate rate, std::int64_t frame0, double sampleRate, float *out, std::size_t n);

  /** HasSampleAccurateValues() at the quantum starting at frame0 (true while automation runs or starts within it). */
  bool hasSampleAccurateValues(std::int64_t frame0, double sampleRate) const;

  /** Approximate value at time t from the spec formulas over the current events (continuous time, no state change).
   *  For tests and diagnostics; rendered values follow Chromium's discrete processing and can differ by float
   *  rounding (≈1e-7 relative) and by setTarget's per-sample recursion. */
  double valueAt(double t) const;

  std::size_t eventCount() const { return count_; }
  std::uint32_t dropped() const { return dropped_; }
  /** True when no event can change the value at or after time t. */
  bool settledAt(double t) const;

 private:
  enum class Type : std::uint8_t { SetValue, Linear, Exp, SetTarget, Curve, CurveEnd, Cancel };
  struct Event {
    Type type = Type::SetValue;
    float value = 0;
    double time = 0;
    float initialValue = 0;  // ramps: intrinsic value at call time (implicit SetValue of a first ramp)
    double callTime = 0;
    double timeConstant = 0;
    double duration = 0;  // curve
    const float *curve = nullptr;
    std::uint32_t curveLen = 0;
    double curvePointsPerSecond = 0;
    float curveEndValue = 0;
    bool hasSaved = false;  // Cancel: the ramp it cancelled
    Type savedType = Type::SetValue;
    float savedValue = 0;
    double savedTime = 0;
    bool hasDefaultCancelledValue = false;
    bool isNew = false;  // in Chromium's new_events_ (not yet clamped to the render time)
  };

  static float clampF(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
  double currentTime() const { return sr_ > 0 ? static_cast<double>(frame_) / sr_ : 0.0; }
  double clampedToCurrentTime(double t) const {
    const double c = currentTime();
    return t > c ? t : c;
  }

  bool insertEvent(const Event &e);
  void pruneOld();
  void insertAt(std::size_t idx, const Event &e);
  void eraseRange(std::size_t first, std::size_t n);
  void removeOldEvents(std::size_t n);
  bool isEventCurrent(const Event &e, const Event *next, std::size_t currentFrame, double sr) const;
  void clampNewEventsToCurrentTime(double t);
  bool handleAllEventsInThePast(double currentTimeS, double sr, float &defaultValue, float *values, std::size_t n);

  float valuesForFrameRange(std::size_t startFrame, std::size_t endFrame, float defaultValue, float *values,
                            std::size_t n, double sr, double controlRate);
  void valuesForFrameRangeImpl(std::size_t startFrame, std::size_t endFrame, float defaultValue, float *values,
                               std::size_t n, double sr, double controlRate);
  float finalValue(std::size_t frame0, double sr);

  struct Cursor {
    std::size_t frame;
    float value;
    std::size_t write;
  };
  void processSetTargetFollowedByRamp(std::size_t i, Type nextType, std::size_t currentFrame, double sr,
                                      double controlRate, float &value);
  void processLinearRamp(Cursor &c, std::size_t fillTo, double t1, double t2, float v1, float v2, double sr,
                         float *values) const;
  void processExponentialRamp(Cursor &c, std::size_t fillTo, double t1, double t2, float v1, float v2, double sr,
                              float *values) const;
  void processSetTarget(Cursor &c, std::size_t fillTo, double t1, float v1, double sr, double controlRate,
                        std::size_t fillToEnd, const Event &e, float *values) const;
  void processSetValueCurve(Cursor &c, std::size_t fillTo, double t1, double sr, std::size_t startFrame,
                            std::size_t endFrame, std::size_t fillToEnd, std::size_t n, const Event &e,
                            float *values) const;
  void processCancelValues(Cursor &c, std::size_t fillTo, double t1, double sr, double controlRate,
                           std::size_t fillToEnd, const Event &e, std::size_t index, float *values) const;

  float intrinsic_;
  float default_;
  float min_, max_;
  Event ev_[kCapacity];
  std::size_t count_ = 0;
  std::size_t frame_ = 0;  // context CurrentSampleFrame() as the main thread sees it
  double sr_ = 0.0;
  std::uint32_t dropped_ = 0;
};

}  // namespace rig::wa
