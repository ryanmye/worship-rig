// Control-thread timers on 128-frame quanta (AudioTimer semantics, contract 0): a timer at engine time t is due in
// quantum k = ceil(t * sr / 128 - 1e-6). Offline: the driver runs the due timers before rendering quantum k.
#pragma once
#include <cmath>
#include <cstdint>
#include <functional>
#include <vector>

namespace rig {

class TimerQueue {
 public:
  using Fn = std::function<void(double /*engine time the callback is run for*/)>;

  static std::int64_t quantumOf(double t, double sr) {
    return static_cast<std::int64_t>(std::ceil(t * sr / 128.0 - 1e-6));
  }

  void at(double t, double sr, Fn fn) {
    items_.push_back({quantumOf(t, sr), seq_++, t, std::move(fn)});
  }

  /** Run every timer whose quantum is <= q, in (quantum, submission) order; callbacks may schedule more. */
  void runDue(std::int64_t q) {
    for (;;) {
      std::size_t best = items_.size();
      for (std::size_t i = 0; i < items_.size(); ++i) {
        if (items_[i].k > q) continue;
        if (best == items_.size() || items_[i].k < items_[best].k ||
            (items_[i].k == items_[best].k && items_[i].seq < items_[best].seq))
          best = i;
      }
      if (best == items_.size()) return;
      Item it = std::move(items_[best]);
      items_.erase(items_.begin() + static_cast<std::ptrdiff_t>(best));
      it.fn(it.t);
    }
  }
  std::size_t pending() const { return items_.size(); }

 private:
  struct Item {
    std::int64_t k;
    std::uint64_t seq;
    double t;
    Fn fn;
  };
  std::vector<Item> items_;
  std::uint64_t seq_ = 0;
};

}  // namespace rig
