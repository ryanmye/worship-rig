// Port of Chromium 157.0.8103.78 third_party/blink/renderer/modules/webaudio/audio_param_handler.cc (timeline part).
// Copyright 2011 The Chromium Authors. Use of this source code is governed by a BSD-style license (BSD-3).
// Structure, names and comments follow the original so the two can be read side by side; see param.h.
#include "time/param.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "num/fdlibm_embed.h"

namespace rig::wa {

namespace {

// Chromium's fdlibm (Blink calls fdlibm::exp / fdlibm::pow here), compiled into this TU (num/fdlibm_embed.h).
namespace fdlibm = rig::fdlibm_internal::v8::base::ieee754;

constexpr float kTimeConstantsToConverge = 10.0f;
constexpr float kSetTargetThreshold = 4.539992976248485e-05f;  // exp(-10)

bool hasSetTargetConverged(float value, float target, double currentTime, double startTime, double timeConstant) {
  if (currentTime > startTime + kTimeConstantsToConverge * timeConstant) return true;
  if (target == 0 && std::fabs(value) < kSetTargetThreshold) return true;
  // libc++'s float fabs overload: the threshold product is a float product
  if (target != 0 && std::fabs(target - value) < kSetTargetThreshold * std::fabs(value)) return true;
  return false;
}

float linearRampAtTime(double t, float value1, double time1, float value2, double time2) {
  return static_cast<float>(value1 + (value2 - value1) * (t - time1) / (time2 - time1));
}

float exponentialRampAtTime(double t, float value1, double time1, float value2, double time2) {
  return (value1 == 0.0f || std::signbit(value1) != std::signbit(value2))
             ? value1
             : static_cast<float>(value1 * fdlibm::pow(value2 / value1, (t - time1) / (time2 - time1)));
}

float valueCurveAtTime(double t, double time1, double duration, const float *curve, std::uint32_t n) {
  const double curveIndex = (n - 1) / duration * (t - time1);
  const std::size_t k = std::min(static_cast<std::size_t>(curveIndex), static_cast<std::size_t>(n - 1));
  const std::size_t k1 = std::min(k + 1, static_cast<std::size_t>(n - 1));
  const float c0 = curve[k];
  const float c1 = curve[k1];
  const double delta = std::min(curveIndex - static_cast<double>(k), 1.0);
  return static_cast<float>(c0 + (c1 - c0) * delta);
}

/** audio_utilities::DiscreteTimeConstantForSampleRate */
double discreteTimeConstant(double timeConstant, double sampleRate) {
  return 1 - fdlibm::exp(-1 / (sampleRate * timeConstant));
}

/** WebIDL `float` conversion: non-finite or out-of-range (rounds to ±Infinity) throws a TypeError. */
bool toFloat(double v, float &out) {
  if (!std::isfinite(v)) return false;
  out = static_cast<float>(v);
  return std::isfinite(out);
}

void fill(float *values, std::size_t from, std::size_t to, float v) {
  for (std::size_t i = from; i < to; ++i) values[i] = v;
}

}  // namespace

// ---- insertion --------------------------------------------------------------------------------------------------

bool Param::setValueAttribute(double v) {
  float f;
  if (!toFloat(v, f)) return false;
  setValue(f);
  return setValueAtTime(intrinsic_, currentTime());
}

bool Param::setValueAtTime(double v, double t) {
  float f;
  if (!toFloat(v, f) || !std::isfinite(t) || !(t >= 0)) return false;
  Event e;
  e.type = Type::SetValue;
  e.value = f;
  e.time = clampedToCurrentTime(t);
  return insertEvent(e);
}

bool Param::linearRampToValueAtTime(double v, double t) {
  float f;
  if (!toFloat(v, f) || !std::isfinite(t) || !(t >= 0)) return false;
  Event e;
  e.type = Type::Linear;
  e.value = f;
  e.time = clampedToCurrentTime(t);
  e.initialValue = intrinsic_;
  e.callTime = currentTime();
  return insertEvent(e);
}

bool Param::exponentialRampToValueAtTime(double v, double t) {
  float f;
  if (!toFloat(v, f) || !std::isfinite(t) || !(t >= 0)) return false;
  if (!f) return false;  // RangeError: target in (-denorm_min, denorm_min)
  Event e;
  e.type = Type::Exp;
  e.value = f;
  e.time = clampedToCurrentTime(t);
  e.initialValue = intrinsic_;
  e.callTime = currentTime();
  return insertEvent(e);
}

bool Param::setTargetAtTime(double target, double t, double tau) {
  float f;
  if (!toFloat(target, f) || !std::isfinite(t) || !(t >= 0) || !std::isfinite(tau) || !(tau >= 0)) return false;
  Event e;
  e.value = f;
  e.time = clampedToCurrentTime(t);
  if (tau == 0) {
    e.type = Type::SetValue;  // instantly jump to the target
  } else {
    e.type = Type::SetTarget;
    e.timeConstant = tau;
  }
  return insertEvent(e);
}

bool Param::setValueCurveAtTime(const float *curve, std::uint32_t n, double t, double duration) {
  if (!std::isfinite(t) || !(t >= 0) || !std::isfinite(duration) || !(duration > 0)) return false;
  if (!curve || n < 2) return false;
  for (std::uint32_t i = 0; i < n; ++i)
    if (!std::isfinite(curve[i])) return false;
  t = clampedToCurrentTime(t);
  Event e;
  e.type = Type::Curve;
  e.time = t;
  e.duration = duration;
  e.curve = curve;
  e.curveLen = n;
  e.curvePointsPerSecond = (n - 1) / duration;
  e.curveEndValue = curve[n - 1];
  pruneOld();
  if (count_ + 2 > kCapacity) {  // both events must fit
    ++dropped_;
    return false;
  }
  if (!insertEvent(e)) return false;
  // A setValueAtTime too, so all following events process from the end of the curve instead of the beginning.
  Event end;
  end.type = Type::CurveEnd;
  end.value = curve[n - 1];
  end.time = t + duration;
  return insertEvent(end);
}

void Param::pruneOld() {
  // InsertEvent prunes old events (Chromium does this to bound memory in disconnected nodes).
  if (count_ == 0) return;
  std::size_t skipped = 0;
  for (std::size_t i = 0; i < count_; ++i) {
    const Event *next = i + 1 < count_ ? &ev_[i + 1] : nullptr;
    if (isEventCurrent(ev_[i], next, frame_, sr_ > 0 ? sr_ : 1.0)) break;
    ++skipped;
  }
  if (skipped > 0) removeOldEvents(skipped);
}

void Param::insertAt(std::size_t idx, const Event &e) {
  for (std::size_t i = count_; i > idx; --i) ev_[i] = ev_[i - 1];
  ev_[idx] = e;
  ++count_;
}

void Param::eraseRange(std::size_t first, std::size_t n) {
  for (std::size_t i = first; i + n < count_; ++i) ev_[i] = ev_[i + n];
  count_ -= n;
}

bool Param::insertEvent(const Event &in) {
  Event event = in;
  event.isNew = true;
  const double insertTime = event.time;

  pruneOld();

  const bool needsStart = count_ == 0 && (event.type == Type::Linear || event.type == Type::Exp);
  if (count_ + (needsStart ? 2 : 1) > kCapacity) {
    ++dropped_;
    return false;
  }

  if (needsStart) {
    // No events precede these ramps: insert a setValueAtTime to set their starting point.
    Event s;
    s.type = Type::SetValue;
    s.value = event.initialValue;
    s.time = currentTime();
    s.isNew = true;
    insertAt(0, s);
  }

  if (count_ == 0) {
    insertAt(0, event);
    return true;
  }

  // Insert after the last event with time <= insertTime (upper bound).
  std::size_t insertionIdx = count_;
  std::size_t ub = insertionIdx - 1;  // upper bound of events that can overlap
  if (ev_[count_ - 1].time > insertTime) {
    std::size_t lo = 0, hi = count_;
    while (lo < hi) {
      const std::size_t mid = (lo + hi) / 2;
      if (insertTime < ev_[mid].time) hi = mid;
      else lo = mid + 1;
    }
    insertionIdx = lo;
    ub = insertionIdx;
  }

  if (event.type == Type::Curve) {
    const double endTime = event.time + event.duration;
    for (std::ptrdiff_t i = static_cast<std::ptrdiff_t>(ub); i >= 0; --i) {
      const Event &t = ev_[i];
      if (t.type == Type::CurveEnd || t.type == Type::Cancel) continue;
      if (t.type == Type::Curve) {
        const double testEnd = t.time + t.duration;
        if (event.time < testEnd && t.time < endTime) return false;  // NotSupportedError: overlap
      } else if (t.time > event.time && t.time < endTime) {
        return false;  // an existing event starts in the middle of this curve
      }
      if (t.time < insertTime) break;
    }
  } else {
    for (std::ptrdiff_t i = static_cast<std::ptrdiff_t>(ub); i >= 0; --i) {
      const Event &t = ev_[i];
      if (t.type == Type::CurveEnd || t.type == Type::Cancel) continue;
      if (t.type == Type::Curve) {
        const double endTime = t.time + t.duration;
        if (event.type != Type::CurveEnd && event.time >= t.time && event.time < endTime) return false;
      }
      if (t.time < insertTime) break;
    }
  }

  insertAt(insertionIdx, event);
  return true;
}

bool Param::cancelScheduledValues(double cancelTime) {
  if (!std::isfinite(cancelTime) || !(cancelTime >= 0)) return false;
  cancelTime = clampedToCurrentTime(cancelTime);
  for (std::size_t i = 0; i < count_; ++i) {
    const double start = ev_[i].time;
    if (start >= cancelTime ||
        (ev_[i].type == Type::Curve && start <= cancelTime && start + ev_[i].duration > cancelTime)) {
      count_ = i;  // RemoveCancelledEvents(i)
      break;
    }
  }
  return true;
}

bool Param::cancelAndHoldAtTime(double cancelTime) {
  if (!std::isfinite(cancelTime) || !(cancelTime >= 0)) return false;
  cancelTime = clampedToCurrentTime(cancelTime);

  // Find the first event at or just past cancelTime.
  std::size_t i = 0;
  for (; i < count_; ++i)
    if (ev_[i].time > cancelTime) break;

  // The event that is being cancelled: the one just past cancelTime, if any.
  std::size_t cancelledIndex = i;
  // If the event just before cancelTime is a SetTarget or SetValueCurve, handle that one instead.
  if (i > 0 && (ev_[i - 1].type == Type::SetTarget || ev_[i - 1].type == Type::Curve)) {
    cancelledIndex = i - 1;
  } else if (i >= count_) {
    return true;  // nothing after cancelTime and the previous event is not SetTarget/SetValueCurve
  }

  const Event cancelled = ev_[cancelledIndex];
  bool haveNew = false, haveNewSet = false;
  Event newEvent, newSet;

  switch (cancelled.type) {
    case Type::Linear:
    case Type::Exp:
      // Remember the ramp in a CancelValues event to cancel it properly and hold the value it reaches.
      newEvent.type = Type::Cancel;
      newEvent.time = cancelTime;
      newEvent.hasSaved = true;
      newEvent.savedType = cancelled.type;
      newEvent.savedValue = cancelled.value;
      newEvent.savedTime = cancelled.time;
      haveNew = true;
      break;
    case Type::SetTarget:
      if (cancelled.time < cancelTime) {
        // Keep the SetTarget that started before the cancel time, stop it there with a CancelValues event.
        ++cancelledIndex;
        newEvent.type = Type::Cancel;
        newEvent.time = cancelTime;
        haveNew = true;
      }
      break;
    case Type::Curve:
      if (cancelled.time < cancelTime) {
        if (cancelTime > cancelled.time + cancelled.duration) {
          ++cancelledIndex;  // past the end of the curve: only remove the following events
        } else {
          // In the middle of the curve: replace it with a shorter one and a SetValue at its new end.
          const double newDuration = cancelTime - cancelled.time;
          const float endValue =
              valueCurveAtTime(cancelTime, cancelled.time, cancelled.duration, cancelled.curve, cancelled.curveLen);
          newEvent = cancelled;
          newEvent.isNew = false;
          newEvent.duration = newDuration;
          newEvent.curveEndValue = endValue;
          haveNew = true;
          newSet.type = Type::SetValue;
          newSet.value = endValue;
          newSet.time = cancelled.time + newDuration;
          haveNewSet = true;
        }
      }
      break;
    case Type::SetValue:
    case Type::CurveEnd:
    case Type::Cancel:
      break;  // nothing needs to be done
  }

  if (cancelledIndex < count_) count_ = cancelledIndex;  // RemoveCancelledEvents
  if (haveNew) {
    if (!insertEvent(newEvent)) return false;
    if (haveNewSet && !insertEvent(newSet)) return false;
  }
  return true;
}

// ---- render-time helpers ----------------------------------------------------------------------------------------

void Param::removeOldEvents(std::size_t n) {
  // Always leave at least one event in the event list.
  if (count_ > 1) eraseRange(0, std::min(n, count_ - 1));
}

bool Param::isEventCurrent(const Event &e, const Event *next, std::size_t currentFrame, double sr) const {
  if (!next) return true;
  if (next->time * sr >= static_cast<double>(currentFrame)) return true;
  // A SetValue between currentFrame - 1 and currentFrame must not be skipped.
  const double eventFrame = e.time * sr;
  const double cf = static_cast<double>(currentFrame);
  return (e.type == Type::SetValue || e.type == Type::CurveEnd) && eventFrame <= cf && cf < eventFrame + 1;
}

void Param::clampNewEventsToCurrentTime(double t) {
  bool clamped = false;
  for (std::size_t i = 0; i < count_; ++i) {
    Event &e = ev_[i];
    if (!e.isNew) continue;
    e.isNew = false;
    // Clamping SetValueCurve start times would shift the curve past its end event.
    if (e.type == Type::Curve || e.type == Type::CurveEnd) continue;
    if (e.time < t) {
      e.time = t;
      clamped = true;
    }
  }
  if (clamped) {
    // std::stable_sort, but in place: the libstdc++ one allocates a temporary buffer (audio thread, ≤ 64 events)
    for (std::size_t i = 1; i < count_; ++i) {
      const Event e = ev_[i];
      std::size_t j = i;
      for (; j > 0 && e.time < ev_[j - 1].time; --j) ev_[j] = ev_[j - 1];
      ev_[j] = e;
    }
  }
}

bool Param::handleAllEventsInThePast(double currentTimeS, double sr, float &defaultValue, float *values,
                                     std::size_t n) {
  const Event &last = ev_[count_ - 1];
  if (last.time + 1.5 * static_cast<double>(kQuantum) / sr < currentTimeS) {
    if (last.type == Type::SetTarget) {
      if (hasSetTargetConverged(defaultValue, last.value, currentTimeS, last.time, last.timeConstant)) {
        defaultValue = last.value;  // converged: slam the default value with the target value
      } else {
        return false;
      }
    }
    fill(values, 0, n, defaultValue);
    removeOldEvents(count_);
    return true;
  }
  return false;
}

void Param::processSetTargetFollowedByRamp(std::size_t i, Type nextType, std::size_t currentFrame, double sr,
                                           double controlRate, float &value) {
  Event &e = ev_[i];
  if (e.type == Type::SetTarget && (nextType == Type::Linear || nextType == Type::Exp)) {
    // The ramp starts wherever the SetTarget processing has reached: replace the SetTarget with a SetValue.
    if (std::fabs(2 * sr * e.time - static_cast<double>(2 * currentFrame) + 1) <= 1) {
      value = static_cast<float>(
          e.value + (value - e.value) * fdlibm::exp(-(static_cast<double>(currentFrame) / sr - e.time) /
                                                    e.timeConstant));
    } else {
      const float dtc = static_cast<float>(discreteTimeConstant(e.timeConstant, controlRate));
      value += (e.value - value) * dtc;
    }
    Event s;
    s.type = Type::SetValue;
    s.value = value;
    s.time = static_cast<double>(currentFrame) / sr;
    e = s;
  }
}

void Param::processLinearRamp(Cursor &c, std::size_t fillTo, double time1, double time2, float value1,
                              float value2, double sr, float *values) const {
  const double deltaTime = time2 - time1;
  // 1/deltaTime can overflow a float: treat deltaTime below float min as zero.
  const float k = deltaTime <= std::numeric_limits<float>::min() ? 0.0f : static_cast<float>(1 / deltaTime);
  const float valueDelta = value2 - value1;
  // x86 SSE path (ARCH_CPU_X86_FAMILY), lane by lane in float.
  if (fillTo > c.write) {
    const float invSr = static_cast<float>(1 / sr);
    const float base = static_cast<float>(static_cast<double>(c.frame) / sr - time1);
    const float kd = k * valueDelta;
    const float inc = static_cast<float>(4 / sr * k * valueDelta);
    float lane[4];
    for (int j = 0; j < 4; ++j) {
      lane[j] = invSr * static_cast<float>(j);
      lane[j] = lane[j] + base;
      lane[j] = lane[j] * kd;
      lane[j] = lane[j] + value1;
    }
    const std::size_t trunc = c.write + ((fillTo - c.write) / 4) * 4;
    c.frame += trunc - c.write;
    for (; c.write < trunc; c.write += 4) {
      for (int j = 0; j < 4; ++j) {
        values[c.write + static_cast<std::size_t>(j)] = lane[j];
        lane[j] = lane[j] + inc;
      }
    }
  }
  if (c.write >= 1) c.value = values[c.write - 1];
  // Serially process remaining values.
  for (; c.write < fillTo; ++c.write) {
    const float x = static_cast<float>((static_cast<double>(c.frame) / sr - time1) * k);
    c.value = value1 + x * valueDelta;
    ++c.frame;
    values[c.write] = c.value;
  }
}

void Param::processExponentialRamp(Cursor &c, std::size_t fillTo, double time1, double time2, float value1,
                                   float value2, double sr, float *values) const {
  if (value1 * value2 <= 0 || time1 >= time2) {
    // Opposite signs, a zero, or no duration: propagate the previous value.
    c.value = value1;
    fill(values, c.write, fillTo, c.value);
    c.write = fillTo;
    return;
  }
  const double deltaTime = time2 - time1;
  const double numSampleFrames = deltaTime * sr;
  // v((c+k)/F) = V*m^k with V = v1*(v2/v1)^((c/F-t1)/(t2-t1)), m = (v2/v1)^(1/(F*(t2-t1)))
  const double multiplier = fdlibm::pow(value2 / value1, 1.0 / numSampleFrames);
  c.value = static_cast<float>(value1 * fdlibm::pow(value2 / static_cast<double>(value1),
                                                    (static_cast<double>(c.frame) / sr - time1) / deltaTime));
  double accumulator = c.value;
  for (; c.write < fillTo; ++c.write) {
    c.value = static_cast<float>(accumulator);
    accumulator *= multiplier;
    ++c.frame;
    values[c.write] = c.value;
  }
  // Due to roundoff the value can exceed value2: clip to value2 within 1/2 frame of time2.
  if (static_cast<double>(c.frame) > time2 * sr - 0.5) c.value = value2;
}

void Param::processSetTarget(Cursor &c, std::size_t fillTo, double time1, float value1, double sr,
                             double controlRate, std::size_t fillToEnd, const Event &e, float *values) const {
  // v(t) = v2 + (v1 - v2)*exp(-(t-t1/tau))
  const float target = value1;
  const float timeConstant = static_cast<float>(e.timeConstant);
  const float dtc = static_cast<float>(discreteTimeConstant(timeConstant, controlRate));

  // Set the starting value correctly when the current time is "equal" to the start time of this event.
  {
    const double rampStartFrame = time1 * sr;
    const double cf = static_cast<double>(c.frame);
    if (rampStartFrame <= cf && cf < rampStartFrame + 1) {
      c.value = static_cast<float>(target + (c.value - target) * fdlibm::exp(-(cf / sr - time1) / timeConstant));
    } else {
      c.value += (target - c.value) * dtc;  // one frame on from the last computed value
    }
  }

  if (hasSetTargetConverged(c.value, target, static_cast<double>(c.frame) / sr, time1, timeConstant)) {
    c.frame += fillTo - c.write;
    fill(values, c.write, fillTo, target);
    c.write = fillTo;
    return;
  }
  // x86 SSE path: 4 steps per iteration, v_k = v + (t - v) * c_k.
  if (fillTo > c.write) {
    const float c0 = dtc;
    const float c1 = c0 * (2 - c0);
    const float c2 = c0 * ((c0 - 3) * c0 + 3);
    const float c3 = c0 * (c0 * ((4 - c0) * c0 - 6) + 4);
    const float vc[4] = {0, c0, c1, c2};
    const std::size_t trunc = c.write + ((fillTo - c.write) / 4) * 4;
    for (; c.write < trunc; c.write += 4) {
      const float delta = target - c.value;
      for (int j = 0; j < 4; ++j) {
        const float prod = delta * vc[j];
        values[c.write + static_cast<std::size_t>(j)] = c.value + prod;
      }
      c.value += delta * c3;
    }
  }
  for (; c.write < fillTo; ++c.write) {
    const float v = c.value;
    c.value += (target - c.value) * dtc;
    values[c.write] = v;
  }
  // The loops may have updated the value one extra time: reset it to the last computed value.
  if (c.write >= 1) c.value = values[c.write - 1];
  c.frame = fillToEnd;
}

void Param::processSetValueCurve(Cursor &c, std::size_t fillTo, double time1, double sr, std::size_t startFrame,
                                 std::size_t endFrame, std::size_t fillToEnd, std::size_t n, const Event &e,
                                 float *values) const {
  const float *curve = e.curve;
  const std::size_t len = e.curveLen;
  const float curveEndValue = e.curveEndValue;
  const double duration = e.duration;
  const double curvePointsPerFrame = e.curvePointsPerSecond / sr;  // (N - 1)/Td per frame

  if (!curve || len == 0 || duration <= 0 || sr <= 0) {
    c.frame = fillToEnd;
    fill(values, c.write, fillTo, c.value);
    c.write = fillTo;
    return;
  }
  const std::size_t nextEventFillTo = fillTo;
  {
    const double curveEndFrame = std::ceil(sr * (time1 + duration));
    fillToEnd = static_cast<double>(endFrame) > curveEndFrame ? static_cast<std::size_t>(curveEndFrame) : endFrame;
  }
  fillTo = fillToEnd < startFrame ? 0 : fillToEnd - startFrame;
  fillTo = std::min({fillTo, n, nextEventFillTo});

  double curveVirtualIndex = 0;
  if (time1 < static_cast<double>(c.frame) / sr) {
    const double frameOffset = static_cast<double>(c.frame) - time1 * sr;
    curveVirtualIndex = curvePointsPerFrame * frameOffset;
  }
  c.value = curveEndValue;  // in case fillTo is 0

  std::size_t k = 0;
  // x86 SSE path in float lanes.
  if (fillTo > c.write) {
    const float vIndex = static_cast<float>(curveVirtualIndex);
    const float vPerFrame = static_cast<float>(curvePointsPerFrame);
    const float vLastIndex = static_cast<float>(len - 1);
    float vk[4] = {0, 1, 2, 3};
    const std::size_t truncated = ((fillTo - c.write) / 4) * 4;
    const std::size_t trunc = c.write + truncated;
    for (; c.write < trunc; c.write += 4) {
      for (int j = 0; j < 4; ++j) {
        const float prod = vk[j] * vPerFrame;
        const float cur = vIndex + prod;
        vk[j] = vk[j] + 4.0f;
        const float a0 = std::min(cur, vLastIndex);  // minps(cur, last): cur unless cur > last
        const float cur1 = cur + 1.0f;
        const float a1 = std::min(cur1, vLastIndex);
        const auto i0 = static_cast<std::int32_t>(a0);  // cvttps: truncation
        const auto i1 = static_cast<std::int32_t>(a1);
        const float c0 = curve[i0];
        const float c1 = curve[i1];
        const float d = std::min(cur - static_cast<float>(i0), 1.0f);
        const float diff = c1 - c0;
        values[c.write + static_cast<std::size_t>(j)] = c0 + diff * d;
      }
    }
    k = truncated;
  }
  if (c.write >= 1) c.value = values[c.write - 1];

  for (; c.write < fillTo; ++c.write) {
    const double cur = curveVirtualIndex + static_cast<double>(k) * curvePointsPerFrame;
    std::size_t i0 = cur < static_cast<double>(len) ? static_cast<std::size_t>(cur) : len - 1;
    if (i0 > len - 1) i0 = len - 1;  // guards a index between len - 1 and len (Chromium DCHECKs it never happens)
    const std::size_t i1 = std::min(i0 + 1, len - 1);
    const float c0 = curve[i0];
    const float c1 = curve[i1];
    const double delta = std::min(cur - static_cast<double>(i0), 1.0);
    ++k;
    c.value = static_cast<float>(c0 + (c1 - c0) * delta);
    values[c.write] = c.value;
  }
  // Time left after the curve and before the next event: hold the curve's last value.
  if (c.write < nextEventFillTo) {
    c.value = curveEndValue;
    fill(values, c.write, nextEventFillTo, c.value);
    c.write = nextEventFillTo;
  }
  c.frame += nextEventFillTo;  // sic (audio_param_handler.cc: current_frame += next_event_fill_to_frame)
}

void Param::processCancelValues(Cursor &c, std::size_t fillTo, double time1, double sr, double controlRate,
                                std::size_t fillToEnd, const Event &e, std::size_t index, float *values) const {
  if (e.hasDefaultCancelledValue) {
    c.value = e.value;
  } else {
    const double cancelFrame = time1 * sr;
    const double cf = static_cast<double>(c.frame);
    if (index >= 1 && cancelFrame <= cf && cf < cancelFrame + 1) {
      const Event &prev = ev_[index - 1];
      if (prev.type == Type::SetTarget) {
        const float target = prev.value;
        const float timeConstant = static_cast<float>(prev.timeConstant);
        const float dtc = static_cast<float>(discreteTimeConstant(timeConstant, controlRate));
        c.value += (target - c.value) * dtc;
      }
    }
  }
  fill(values, c.write, fillTo, c.value);
  c.write = fillTo;
  c.frame = fillToEnd;
}

void Param::valuesForFrameRangeImpl(std::size_t startFrame, std::size_t endFrame, float defaultValue,
                                    float *values, std::size_t n, double sr, double controlRate) {
  if (count_ == 0 || static_cast<double>(endFrame) / sr <= ev_[0].time) {
    fill(values, 0, n, defaultValue);
    return;
  }
  // Clamp new events before the list can be mutated.
  clampNewEventsToCurrentTime(static_cast<double>(startFrame) / sr);
  if (handleAllEventsInThePast(static_cast<double>(startFrame) / sr, sr, defaultValue, values, n)) return;

  Cursor c{startFrame, defaultValue, 0};
  // HandleFirstEvent: fill with the default value until the first event.
  {
    const double firstTime = ev_[0].time;
    if (firstTime > static_cast<double>(startFrame) / sr) {
      std::size_t fillToEnd = endFrame;
      const double firstFrame = std::ceil(firstTime * sr);
      if (static_cast<double>(endFrame) > firstFrame) fillToEnd = static_cast<std::size_t>(firstFrame);
      std::size_t fillTo = std::min(fillToEnd - startFrame, n);
      fill(values, c.write, fillTo, defaultValue);
      c.write = fillTo;
      c.frame += fillTo;
    }
  }
  c.value = defaultValue;

  const std::size_t numberOfEvents = count_;
  std::size_t skipped = 0;
  for (std::size_t i = 0; i < numberOfEvents && c.write < n; ++i) {
    const Event *next = i + 1 < numberOfEvents ? &ev_[i + 1] : nullptr;
    if (!isEventCurrent(ev_[i], next, c.frame, sr)) {
      ++skipped;  // in the past
      continue;
    }
    // No next event = Chromium's kLastType; Cancel stands in for it here (only the ramp types matter).
    processSetTargetFollowedByRamp(i, next ? next->type : Type::Cancel, c.frame, sr, controlRate, c.value);
    const Event &event = ev_[i];
    const float value1 = event.value;
    const double time1 = event.time;

    // HandleCancelValues
    float value2 = next ? next->value : value1;
    double time2 = next ? next->time : static_cast<double>(endFrame) / sr + 1;
    bool nextIsLast = next == nullptr;
    Type nextType = next ? next->type : Type::Cancel;
    if (next && next->type == Type::Cancel && next->hasSaved) {
      switch (event.type) {
        case Type::Cancel:
        case Type::Linear:
        case Type::Exp:
        case Type::CurveEnd:
        case Type::SetValue: {
          Event &ne = ev_[i + 1];
          time2 = ne.time;
          nextType = ne.savedType;
          if (ne.hasDefaultCancelledValue) {
            value2 = ne.value;
          } else {
            if (ne.savedType == Type::Linear)
              value2 = linearRampAtTime(ne.time, value1, time1, ne.savedValue, ne.savedTime);
            else
              value2 = exponentialRampAtTime(ne.time, value1, time1, ne.savedValue, ne.savedTime);
            ne.value = value2;  // SetCancelledValue: cache it
            ne.hasDefaultCancelledValue = true;
          }
        } break;
        case Type::Curve:
        case Type::SetTarget:
          break;
      }
    }

    const double t2sr = time2 * sr;
    const std::size_t fillToEnd =
        static_cast<double>(endFrame) > t2sr ? static_cast<std::size_t>(std::ceil(t2sr)) : endFrame;
    const std::size_t fillTo = std::min(fillToEnd - startFrame, n);

    if (!nextIsLast && nextType == Type::Linear) {
      processLinearRamp(c, fillTo, time1, time2, value1, value2, sr, values);
    } else if (!nextIsLast && nextType == Type::Exp) {
      processExponentialRamp(c, fillTo, time1, time2, value1, value2, sr, values);
    } else {
      switch (event.type) {
        case Type::SetValue:
        case Type::CurveEnd:
        case Type::Linear:
        case Type::Exp:
          // Stay at a constant value (also after the end of a ramp).
          c.frame = fillToEnd;
          c.value = event.value;
          fill(values, c.write, fillTo, c.value);
          c.write = fillTo;
          break;
        case Type::Cancel:
          processCancelValues(c, fillTo, time1, sr, controlRate, fillToEnd, event, i, values);
          break;
        case Type::SetTarget:
          processSetTarget(c, fillTo, time1, value1, sr, controlRate, fillToEnd, event, values);
          break;
        case Type::Curve:
          processSetValueCurve(c, fillTo, time1, sr, startFrame, endFrame, fillToEnd, n, event, values);
          break;
      }
    }
  }
  if (skipped > 0) removeOldEvents(skipped);
  fill(values, c.write, n, c.value);
}

float Param::valuesForFrameRange(std::size_t startFrame, std::size_t endFrame, float defaultValue, float *values,
                                 std::size_t n, double sr, double controlRate) {
  valuesForFrameRangeImpl(startFrame, endFrame, defaultValue, values, n, sr, controlRate);
  for (std::size_t i = 0; i < n; ++i) values[i] = clampF(values[i], min_, max_);  // Vclip
  return values[n - 1];
}

float Param::finalValue(std::size_t frame0, double sr) {
  // CalculateFinalValues(sample_accurate = false) → ValueForContextTime
  float value = intrinsic_;
  if (count_ > 0 && !(static_cast<double>(frame0) / sr < ev_[0].time)) {
    float v = 0.0f;
    value = valuesForFrameRange(frame0, frame0 + 1, value, &v, 1, sr, sr / static_cast<double>(kQuantum));
  }
  setValue(value);
  return intrinsic_;
}

bool Param::hasSampleAccurateValues(std::int64_t frame0, double sr) const {
  if (count_ == 0) return false;
  const double f = static_cast<double>(frame0);
  const double q = static_cast<double>(kQuantum);
  const Event &first = ev_[0];
  if (first.time > (f + q) / sr &&
      (first.type == Type::SetTarget || first.type == Type::SetValue || first.type == Type::Curve))
    return false;
  if (count_ >= 2) return true;
  switch (first.type) {
    case Type::SetTarget:
      return first.time <= (f + q) / sr;
    case Type::SetValue:
    case Type::Linear:
    case Type::Exp:
    case Type::Cancel:
    case Type::CurveEnd:
      return !(first.time < f / sr);
    case Type::Curve: {
      const double now = f / sr;
      return first.time <= now && now < first.time + first.duration;
    }
  }
  return true;
}

void Param::processARate(std::int64_t frame0, double sampleRate, float *out, std::size_t n) {
  if (n == 0) return;
  const std::size_t start = frame0 < 0 ? 0 : static_cast<std::size_t>(frame0);
  frame_ = start;
  sr_ = sampleRate;
  if (hasSampleAccurateValues(frame0, sampleRate)) {
    setValue(valuesForFrameRange(start, start + n, intrinsic_, out, n, sampleRate, sampleRate));
  } else {
    fill(out, 0, n, finalValue(start, sampleRate));
  }
  frame_ = start + kQuantum;  // the main thread sees the context after this quantum
}

float Param::processKRate(std::int64_t frame0, double sampleRate) {
  const std::size_t start = frame0 < 0 ? 0 : static_cast<std::size_t>(frame0);
  frame_ = start;
  sr_ = sampleRate;
  const float v = finalValue(start, sampleRate);
  frame_ = start + kQuantum;
  return v;
}

void Param::process(Rate rate, std::int64_t frame0, double sampleRate, float *out, std::size_t n) {
  if (rate == Rate::ARate) {
    processARate(frame0, sampleRate, out, n);
  } else {
    fill(out, 0, n, processKRate(frame0, sampleRate));
  }
}

// ---- diagnostics ------------------------------------------------------------------------------------------------

double Param::valueAt(double t) const {
  // Spec formulas over the event list (continuous time), starting from the intrinsic value.
  double v = intrinsic_;
  double prevTime = 0;
  for (std::size_t i = 0; i < count_; ++i) {
    const Event &e = ev_[i];
    if (e.type == Type::Linear || e.type == Type::Exp || (e.type == Type::Cancel && e.hasSaved)) {
      const double v0 = v, t0 = prevTime;
      const Type rt = e.type == Type::Cancel ? e.savedType : e.type;
      const double v1 = e.type == Type::Cancel ? e.savedValue : e.value;
      const double t1 = e.type == Type::Cancel ? e.savedTime : e.time;
      auto ramp = [&](double tt) {
        if (t1 <= t0) return v1;
        const double x = (tt - t0) / (t1 - t0);
        if (rt == Type::Linear) return v0 + (v1 - v0) * x;
        if (v0 == 0 || (v0 < 0) != (v1 < 0)) return v0;
        return v0 * std::pow(v1 / v0, x);
      };
      const double endT = e.time;
      if (t < endT) return ramp(t);
      v = e.type == Type::Cancel ? ramp(endT) : v1;
      prevTime = endT;
      continue;
    }
    if (t < e.time) return v;
    switch (e.type) {
      case Type::SetValue:
      case Type::CurveEnd:
        v = e.value;
        break;
      case Type::Cancel:
        break;  // hold
      case Type::SetTarget: {
        const double v0 = v;
        const double endT = i + 1 < count_ ? ev_[i + 1].time : std::numeric_limits<double>::infinity();
        const double tt = std::min(t, endT);
        v = e.value + (v0 - e.value) * std::exp(-(tt - e.time) / e.timeConstant);
        if (t < endT) return v;
        break;
      }
      case Type::Curve: {
        if (t < e.time + e.duration) return valueCurveAtTime(t, e.time, e.duration, e.curve, e.curveLen);
        v = e.curveEndValue;
        break;
      }
      default:
        break;
    }
    prevTime = e.time;
  }
  return v;
}

bool Param::settledAt(double t) const {
  if (count_ == 0) return true;
  const Event &last = ev_[count_ - 1];
  if (last.type == Type::SetTarget) return false;
  return last.time <= t;
}

}  // namespace rig::wa
