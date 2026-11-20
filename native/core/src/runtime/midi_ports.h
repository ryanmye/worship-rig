// MIDI port table (T08, SETUP_REVIEW 21c): rig_midi_in's port id string -> a stable uint16 index, replacing the
// T00 string hash (collisions). Indices are assigned in order of first appearance (rig_host_midi_ports lists, then
// unknown ids seen by rig_midi_in) and never reused for the engine's lifetime, so the "midi" service (T07) can keep
// its own id <-> index table by interning the same ports in the same order, or ask Engine::midiPortId(index).
// intern() may be called from any thread (lock-free; slots are claimed with a CAS and published with a release
// flag); lookup is wait-free and RT-safe (at most kMax short string compares).
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace rig {

class MidiPortTable {
 public:
  static constexpr std::size_t kMax = 128, kIdLen = 96;
  static constexpr std::uint16_t kNone = 0xffff;

  /** Index of `id`, adding it when new. kNone when the table is full or id is empty/too long. */
  std::uint16_t intern(const char *id) {
    const std::uint16_t f = find(id);
    if (f != kNone || !id) return f;
    const std::size_t n = std::strlen(id);
    if (n == 0 || n >= kIdLen) return kNone;
    for (;;) {
      std::size_t i = count_.load(std::memory_order_acquire);
      if (i >= kMax) return kNone;
      if (!count_.compare_exchange_weak(i, i + 1, std::memory_order_acq_rel)) continue;
      for (std::size_t k = 0; k < n; ++k) slots_[i].id[k].store(id[k], std::memory_order_relaxed);
      slots_[i].id[n].store(0, std::memory_order_relaxed);
      slots_[i].ready.store(true, std::memory_order_release);
      // two threads interning the same new id race to two slots: the lower index wins every later lookup
      const std::uint16_t first = find(id);
      return first != kNone ? first : static_cast<std::uint16_t>(i);
    }
  }

  /** Index of `id` or kNone (RT-safe). */
  std::uint16_t find(const char *id) const {
    if (!id || !*id) return kNone;
    const std::size_t n = count_.load(std::memory_order_acquire);
    for (std::size_t i = 0; i < n; ++i) {
      if (!slots_[i].ready.load(std::memory_order_acquire)) continue;
      std::size_t k = 0;
      for (; k < kIdLen; ++k) {
        const char c = slots_[i].id[k].load(std::memory_order_relaxed);
        if (c != id[k]) break;
        if (c == 0) return static_cast<std::uint16_t>(i);
      }
    }
    return kNone;
  }

  /** Copy the id of `index` into buf (NUL-terminated); false when unknown. */
  bool id(std::uint16_t index, char *buf, std::size_t cap) const {
    if (index >= count_.load(std::memory_order_acquire) || !slots_[index].ready.load(std::memory_order_acquire) ||
        cap == 0)
      return false;
    std::size_t k = 0;
    for (; k + 1 < cap && k < kIdLen; ++k) {
      buf[k] = slots_[index].id[k].load(std::memory_order_relaxed);
      if (!buf[k]) return true;
    }
    buf[k] = 0;
    return true;
  }

  std::size_t size() const { return count_.load(std::memory_order_acquire); }

 private:
  struct Slot {
    std::atomic<bool> ready{false};
    std::atomic<char> id[kIdLen] = {};
  };
  std::atomic<std::size_t> count_{0};
  Slot slots_[kMax];
};

}  // namespace rig
