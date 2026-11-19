#include "time/param.h"

#include <algorithm>
#include <cmath>

namespace rig::wa {

bool Param::insert(const Event &e) {
  if (count_ == kCapacity) {
    // Fold the past (relative to the last processed time) into the timeline; future events are never dropped.
    fold(now_);
    if (count_ == kCapacity) {
      ++dropped_;
      return false;
    }
  }
  // Events at equal times keep insertion order (spec: "placed in the list after them").
  std::size_t i = count_;
  while (i > 0 && ev_[i - 1].time > e.time) {
    ev_[i] = ev_[i - 1];
    --i;
  }
  ev_[i] = e;
  ++count_;
  cursor_ = 0;
  return true;
}

bool Param::setValueAtTime(double v, double t) {
  return insert({Type::Set, v, t, 0.0, 0.0});
}

bool Param::linearRampToValueAtTime(double v, double t) {
  return insert({Type::Linear, v, t, 0.0, 0.0});
}

bool Param::exponentialRampToValueAtTime(double v, double t) {
  return insert({Type::Exp, v, t, 0.0, 0.0});
}

bool Param::setTargetAtTime(double target, double t, double tau) {
  // VERIFY (T01): Chromium starts the curve from the value the timeline has at t.
  const double start = valueAt(t);
  return insert({Type::Target, target, t, tau, start});
}

void Param::cancelScheduledValues(double t) {
  std::size_t keep = 0;
  while (keep < count_ && ev_[keep].time < t) ++keep;
  count_ = keep;
  cursor_ = 0;
}

void Param::cancelAndHoldAtTime(double t) {
  // VERIFY (T01): Chromium truncates an in-flight ramp / setTarget at t and keeps the value reached there.
  const double v = valueAt(t);
  std::size_t keep = 0;
  while (keep < count_ && ev_[keep].time <= t) ++keep;
  count_ = keep;
  cursor_ = 0;
  insert({Type::Set, v, t, 0.0, 0.0});
}

double Param::eval(double t, std::size_t &cur) const {
  if (count_ == 0) return value_;
  // Number of events with time <= t (they have "happened"); the cursor makes monotone sweeps O(1).
  std::size_t idx = cur;
  if (idx > count_ || (idx > 0 && ev_[idx - 1].time > t)) idx = 0;
  while (idx < count_ && ev_[idx].time <= t) ++idx;
  cur = idx;
  const Event *prev = idx > 0 ? &ev_[idx - 1] : nullptr;
  const Event *next = idx < count_ ? &ev_[idx] : nullptr;
  if (next && (next->type == Type::Linear || next->type == Type::Exp)) {
    double v0;
    double t0;
    if (prev) {
      t0 = prev->time;
      v0 = prev->type == Type::Target ? prev->start : prev->value;  // VERIFY (T01): ramp after setTarget
    } else {
      t0 = 0.0;
      v0 = value_;
    }
    const double v1 = next->value;
    const double t1 = next->time;
    if (t1 <= t0) return v1;
    const double x = (t - t0) / (t1 - t0);
    if (next->type == Type::Linear) return v0 + (v1 - v0) * x;
    if (v0 == 0.0 || v1 == 0.0 || (v0 < 0.0) != (v1 < 0.0)) return v0;  // invalid exponential ramp: hold
    return v0 * std::pow(v1 / v0, x);
  }
  if (!prev) return value_;
  if (prev->type == Type::Target) {
    const double dt = t - prev->time;
    if (prev->tau <= 0.0) return prev->value;
    return prev->value + (prev->start - prev->value) * std::exp(-dt / prev->tau);
  }
  return prev->value;
}

double Param::valueAt(double t) const {
  return eval(t, cursor_);
}

void Param::fold(double t) {
  // Keep the last event that starts at or before t (it anchors what follows); drop the older ones.
  std::size_t idx = 0;
  while (idx < count_ && ev_[idx].time <= t) ++idx;
  if (idx <= 1) return;
  const std::size_t drop = idx - 1;
  for (std::size_t i = drop; i < count_; ++i) ev_[i - drop] = ev_[i];
  count_ -= drop;
  cursor_ = 0;
}

bool Param::settledAt(double t) const {
  if (count_ == 0) return true;
  const Event &last = ev_[count_ - 1];
  return last.time <= t && last.type != Type::Target;
}

void Param::processARate(std::int64_t frame0, double sampleRate, float *out, std::size_t n) {
  now_ = static_cast<double>(frame0) / sampleRate;
  if (count_ > 1) fold(now_);
  if (count_ == 0 || settledAt(static_cast<double>(frame0) / sampleRate)) {
    const float v = static_cast<float>(count_ == 0 ? value_ : ev_[count_ - 1].value);
    for (std::size_t i = 0; i < n; ++i) out[i] = v;
    return;
  }
  std::size_t cur = cursor_;
  for (std::size_t i = 0; i < n; ++i) {
    out[i] = static_cast<float>(eval(static_cast<double>(frame0 + static_cast<std::int64_t>(i)) / sampleRate, cur));
  }
  cursor_ = cur;
}

float Param::processKRate(std::int64_t frame0, double sampleRate) {
  const double t = static_cast<double>(frame0) / sampleRate;
  now_ = t;
  if (count_ > 1) fold(t);
  return static_cast<float>(eval(t, cursor_));
}

}  // namespace rig::wa
