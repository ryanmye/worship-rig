// Port of fx.js Coalescer (SPEC §3.1, contract §0 "Coalescing"): at most one apply per key per `interval` seconds of
// event time; the latest value wins; a trailing flush runs on the timer at last + interval with the timer's time.
// Keys are the param path, or the group keys `slots.<i>.eq`, `fx.delay.time`, `fx.lofi`, `wheels`, `bend`.
// Control thread only.
#pragma once
#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace rig {

class Coalescer {
 public:
  using Apply = std::function<void(double /*when*/)>;
  /** Schedules fn(t) at engine time `at` (Engine::at / TimerQueue::at with the engine rate). */
  using Schedule = std::function<void(double at, std::function<void(double)> fn)>;

  explicit Coalescer(Schedule schedule, double interval = 0.01) : schedule_(std::move(schedule)), interval_(interval) {}

  void push(std::string_view key, double when, Apply apply) {
    std::string k(key);
    auto last = last_.find(k);
    if (last == last_.end() || when - last->second >= interval_) {
      last_[k] = when;
      pending_.erase(k);
      apply(when);
      return;
    }
    const bool had = pending_.count(k) != 0;
    pending_[k] = std::move(apply);
    if (!had) {
      schedule_(last->second + interval_, [this, k](double t) {
        auto it = pending_.find(k);
        if (it == pending_.end()) return;
        Apply fn = std::move(it->second);
        pending_.erase(it);
        if (fn) {
          last_[k] = t;
          fn(t);
        }
      });
    }
  }

  /** Drop pending (not yet flushed) writes, all of them or those whose key passes `pred` (round3-eq M1). */
  void cancelAll(const std::function<bool(std::string_view)> &pred = nullptr) {
    if (!pred) {
      pending_.clear();
      return;
    }
    for (auto it = pending_.begin(); it != pending_.end();) {
      if (pred(it->first)) it = pending_.erase(it);
      else ++it;
    }
  }

  bool hasPending(std::string_view key) const { return pending_.count(std::string(key)) != 0; }
  double interval() const { return interval_; }

 private:
  Schedule schedule_;
  double interval_;
  std::unordered_map<std::string, double> last_;
  std::unordered_map<std::string, Apply> pending_;
};

}  // namespace rig
