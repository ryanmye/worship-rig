// Epoch-based reclamation (ARCHITECTURE 3.4; SETUP_REVIEW 1e). FROZEN by T00b.
// The graph advances the epoch once per rendered quantum (audio thread). Shared immutable data (sample buffers,
// reverb kernels, wavetables) detached at control-side epoch E may be freed once the graph has published an epoch
// > E + 1: by then every quantum that could still hold the raw pointer has finished.
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <utility>
#include <vector>

namespace rig {

class EpochCounter {
 public:
  /** Audio thread, end of each quantum. */
  void advance() { epoch_.fetch_add(1, std::memory_order_release); }
  /** Any thread. */
  std::uint64_t current() const { return epoch_.load(std::memory_order_acquire); }

 private:
  std::atomic<std::uint64_t> epoch_{0};
};

/** Control-thread list of frees waiting for the graph to pass an epoch. Not thread-safe (control thread only). */
class DeferredFree {
 public:
  /** Free `fn` once epoch > `detachEpoch` + 1. */
  void add(std::uint64_t detachEpoch, std::function<void()> fn) { items_.emplace_back(detachEpoch, std::move(fn)); }
  /** Run what is safe at the graph's current epoch; returns how many ran. */
  std::size_t collect(std::uint64_t graphEpoch) {
    std::size_t n = 0;
    for (std::size_t i = 0; i < items_.size();) {
      if (graphEpoch > items_[i].first + 1) {
        auto fn = std::move(items_[i].second);
        items_[i] = std::move(items_.back());
        items_.pop_back();
        fn();
        ++n;
      } else {
        ++i;
      }
    }
    return n;
  }
  /** Shutdown: the graph is gone, everything is safe. */
  void drainAll() {
    for (auto &it : items_) it.second();
    items_.clear();
  }
  std::size_t pending() const { return items_.size(); }

 private:
  std::vector<std::pair<std::uint64_t, std::function<void()>>> items_;
};

}  // namespace rig
