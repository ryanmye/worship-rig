// Immutable per-slot description built on the control thread and attached to the graph by pointer.
#pragma once
#include "mix/slot_eq.h"

namespace rig {

enum class InstKind : unsigned char { None = 0, TestSine, TestSaw };

struct SlotSpec {
  InstKind inst = InstKind::None;
  double attack = 0.01, decay = 0.1, sustain = 0.7, release = 0.2;  // test voice ADSR (decay/release are time constants)
  int lowNote = 0, highNote = 127;
  SlotEqSpec eq;
};

/** Stimulus injected at a node (rig_test_inject): control-side allocation, graph reads it, then hands it back. */
struct InjectBuffer {
  unsigned channels = 1;
  unsigned long long frames = 0;
  long long startFrame = 0;
  float gain = 1.0f;
  float *data[2] = {nullptr, nullptr};  // points into storage
  float *storage = nullptr;
  ~InjectBuffer() { delete[] storage; }
};

}  // namespace rig
