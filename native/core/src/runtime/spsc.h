// Lock-free single-producer single-consumer ring (power-of-two capacity, cache-line padded indices).
// push() is called by exactly one thread, pop() by exactly one other. Neither allocates or blocks.
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <new>
#include <type_traits>

namespace rig {

inline constexpr std::size_t kCacheLine = 64;

template <class T, std::size_t N>
class SpscQueue {
  static_assert(N >= 2 && (N & (N - 1)) == 0, "capacity must be a power of two");
  static_assert(std::is_trivially_copyable_v<T>, "queue payloads are PODs");

 public:
  static constexpr std::size_t capacity() { return N; }

  /** Producer side. False when full (nothing is written). */
  bool push(const T &v) {
    const std::size_t h = head_.load(std::memory_order_relaxed);
    const std::size_t t = tail_.load(std::memory_order_acquire);
    if (h - t >= N) return false;
    buf_[h & (N - 1)] = v;
    head_.store(h + 1, std::memory_order_release);
    return true;
  }

  /** Consumer side. False when empty. */
  bool pop(T &out) {
    const std::size_t t = tail_.load(std::memory_order_relaxed);
    const std::size_t h = head_.load(std::memory_order_acquire);
    if (t == h) return false;
    out = buf_[t & (N - 1)];
    tail_.store(t + 1, std::memory_order_release);
    return true;
  }

  /** Approximate occupancy (exact when called from either end while the other is idle). */
  std::size_t size() const {
    return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire);
  }
  bool empty() const { return size() == 0; }

 private:
  alignas(kCacheLine) std::atomic<std::size_t> head_{0};
  alignas(kCacheLine) std::atomic<std::size_t> tail_{0};
  alignas(kCacheLine) T buf_[N];
};

}  // namespace rig
