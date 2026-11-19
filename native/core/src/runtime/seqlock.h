// Single-writer seqlock for small POD snapshots (meters). write() is wait-free; read() retries on a torn read.
#pragma once
#include <atomic>
#include <cstdint>
#include <cstring>
#include <type_traits>

namespace rig {

template <class T>
class Seqlock {
  static_assert(std::is_trivially_copyable_v<T>, "seqlock payloads are PODs");

 public:
  // All accesses are seq_cst: no standalone fences (ThreadSanitizer cannot model them) and the cost is a few
  // stores once per 128-frame quantum.
  void write(const T &v) {
    const std::uint32_t s = seq_.load(std::memory_order_relaxed);
    seq_.store(s + 1, std::memory_order_seq_cst);
    copyIn(v);
    seq_.store(s + 2, std::memory_order_seq_cst);
  }

  T read() const {
    T out;
    for (;;) {
      const std::uint32_t s0 = seq_.load(std::memory_order_seq_cst);
      if (s0 & 1u) continue;
      copyOut(out);
      if (seq_.load(std::memory_order_seq_cst) == s0) return out;
    }
  }

 private:
  // Atomic word copies keep the racy read well-defined for the sanitizers.
  static constexpr std::size_t kWords = (sizeof(T) + 3) / 4;
  void copyIn(const T &v) {
    std::uint32_t w[kWords] = {};
    std::memcpy(w, &v, sizeof(T));
    for (std::size_t i = 0; i < kWords; ++i) words_[i].store(w[i], std::memory_order_seq_cst);
  }
  void copyOut(T &v) const {
    std::uint32_t w[kWords];
    for (std::size_t i = 0; i < kWords; ++i) w[i] = words_[i].load(std::memory_order_seq_cst);
    std::memcpy(&v, w, sizeof(T));
  }
  std::atomic<std::uint32_t> seq_{0};
  std::atomic<std::uint32_t> words_[kWords] = {};
};

}  // namespace rig
