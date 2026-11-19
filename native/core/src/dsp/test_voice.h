// Test voice: sine or naive saw with an ADSR driven by wa::Param (linear attack, setTarget decay and release).
// It exists to prove note scheduling, sub-quantum starts and param evaluation end to end; real instruments are T11+.
#pragma once
#include <cstddef>
#include <cstdint>

#include "mix/slot_spec.h"
#include "time/param.h"

namespace rig {

class TestVoice {
 public:
  bool active() const { return active_; }
  int note() const { return note_; }
  bool released() const { return released_; }
  /** Start at an absolute engine frame (sample-accurate: the first sample is rendered at `frame`). */
  void start(const SlotSpec &spec, int note, int vel, std::int64_t frame, double sampleRate);
  void release(const SlotSpec &spec, std::int64_t frame, double sampleRate);
  void kill() { active_ = false; }
  /** Adds into out[0..n) for frames [q0, q0 + n). Returns false once the voice has ended (release tail over). */
  bool render(float *out, std::int64_t q0, std::size_t n, double sampleRate);

 private:
  bool active_ = false, released_ = false;
  InstKind kind_ = InstKind::TestSine;
  int note_ = 0;
  float amp_ = 0;
  double inc_ = 0;  // phase increment per frame (cycles)
  std::int64_t start_ = 0;
  std::int64_t endFrame_ = INT64_MAX;
  wa::Param env_;
};

}  // namespace rig
