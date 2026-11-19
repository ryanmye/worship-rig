// Control-thread timers on 128-frame quanta: the offline semantics of fx.js AudioTimer (contract §0, ARCHITECTURE
// §3.5). A timer at engine time t is due in quantum k = ceil(t·sr/128 − 1e-6) (fx.js:180); the driver runs the due
// timers before rendering quantum k (`OfflineAudioContext.suspend(k·128/sr)`), realtime runs them when the graph
// reports that quantum. Order: due timers by (quantum, submission); a timer created by a callback that is already
// due runs after the current batch (AudioTimer's `_immediate` list). A callback receives max(t, now) with
// now = q·128/sr, so automation it schedules is never in the past. Control thread only (std::function, vector).
#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace rig {

class TimerQueue {
 public:
  using Fn = std::function<void(double /*max(t, now)*/)>;
  using Id = std::uint64_t;

  static std::int64_t quantumOf(double t, double sr) {
    return static_cast<std::int64_t>(std::ceil(t * sr / 128.0 - 1e-6));
  }

  /** at(when, cb): when non-finite or < 0 means 0. Returns an id for cancel(). */
  Id at(double t, double sr, Fn fn) {
    if (!std::isfinite(t) || t < 0) t = 0;
    sr_ = sr;
    const Id id = ++seq_;
    items_.push_back({quantumOf(t, sr), id, t, inRun_, std::move(fn)});
    return id;
  }

  /** Cancel a pending timer (no-op when it already ran). */
  void cancel(Id id) {
    for (auto &it : items_)
      if (it.id == id) it.fn = nullptr;
  }

  /** Run every timer due at quantum q (k <= q): first the ones that existed when the call started, by (k, id), then
   *  the ones their callbacks created, by id. */
  void runDue(std::int64_t q) {
    inRun_ = true;
    const double now = sr_ > 0 ? static_cast<double>(q) * 128.0 / sr_ : 0.0;
    for (;;) {
      std::size_t best = items_.size();
      for (std::size_t i = 0; i < items_.size(); ++i) {
        const Item &a = items_[i];
        if (a.k > q) continue;
        if (best == items_.size() || before(a, items_[best])) best = i;
      }
      if (best == items_.size()) break;
      Item it = std::move(items_[best]);
      items_.erase(items_.begin() + static_cast<std::ptrdiff_t>(best));
      if (it.fn) it.fn(it.t > now ? it.t : now);
    }
    inRun_ = false;
    for (auto &it : items_) it.late = false;
  }

  /** Pending timers (cancelled ones are dropped at their quantum). */
  std::size_t pending() const {
    std::size_t n = 0;
    for (const auto &it : items_) n += it.fn ? 1 : 0;
    return n;
  }
  /** Earliest quantum with a pending timer, or -1. */
  std::int64_t nextQuantum() const {
    std::int64_t k = -1;
    for (const auto &it : items_)
      if (it.fn && (k < 0 || it.k < k)) k = it.k;
    return k;
  }
  void clear() { items_.clear(); }

 private:
  struct Item {
    std::int64_t k;
    Id id;
    double t;
    bool late;  // created by a callback inside runDue: runs after the batch that was due when runDue started
    Fn fn;
  };
  static bool before(const Item &a, const Item &b) {
    if (a.late != b.late) return !a.late;
    if (a.late) return a.id < b.id;
    return a.k < b.k || (a.k == b.k && a.id < b.id);
  }
  std::vector<Item> items_;
  Id seq_ = 0;
  double sr_ = 0;
  bool inRun_ = false;
};

}  // namespace rig
