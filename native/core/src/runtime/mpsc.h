// Bounded lock-free multi-producer queue (Vyukov sequence ring). Used many-to-one (MIDI threads -> control thread);
// push() is wait-free except for contended CAS retries, never allocates and never blocks, so it is RT-safe.
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "runtime/spsc.h"

namespace rig {

template <class T, std::size_t N>
class MpscQueue {
  static_assert(N >= 2 && (N & (N - 1)) == 0, "capacity must be a power of two");
  static_assert(std::is_trivially_copyable_v<T>, "queue payloads are PODs");

 public:
  MpscQueue() {
    for (std::size_t i = 0; i < N; ++i) cells_[i].seq.store(i, std::memory_order_relaxed);
  }

  bool push(const T &v) {
    std::size_t pos = enq_.load(std::memory_order_relaxed);
    for (;;) {
      Cell &c = cells_[pos & (N - 1)];
      const std::size_t seq = c.seq.load(std::memory_order_acquire);
      const std::intptr_t dif = static_cast<std::intptr_t>(seq) - static_cast<std::intptr_t>(pos);
      if (dif == 0) {
        if (enq_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) {
          c.data = v;
          c.seq.store(pos + 1, std::memory_order_release);
          return true;
        }
      } else if (dif < 0) {
        return false;  // full
      } else {
        pos = enq_.load(std::memory_order_relaxed);
      }
    }
  }

  /** Single consumer. */
  bool pop(T &out) {
    Cell &c = cells_[deq_ & (N - 1)];
    const std::size_t seq = c.seq.load(std::memory_order_acquire);
    if (static_cast<std::intptr_t>(seq) - static_cast<std::intptr_t>(deq_ + 1) < 0) return false;
    out = c.data;
    c.seq.store(deq_ + N, std::memory_order_release);
    ++deq_;
    return true;
  }

 private:
  struct Cell {
    std::atomic<std::size_t> seq;
    T data;
  };
  alignas(kCacheLine) std::atomic<std::size_t> enq_{0};
  alignas(kCacheLine) std::size_t deq_{0};
  alignas(kCacheLine) Cell cells_[N];
};

}  // namespace rig
