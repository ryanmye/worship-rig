// Render graph (audio thread). Executes Commands, renders 128-frame quanta. Interfaces frozen by T00; the DSP behind
// it is a skeleton: 4 slot strips (fader -> SlotEq -> pan) carrying test voices, a sum and a master gain.
#pragma once
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

#include "rig/rig_engine.h"
#include "dsp/test_voice.h"
#include "mix/slot_spec.h"
#include "runtime/command.h"
#include "runtime/seqlock.h"
#include "runtime/spsc.h"
#include "time/param.h"

namespace rig {

using CommandQueue = SpscQueue<Command, 16384>;
using EventQueue = SpscQueue<AudioEvent, 4096>;

/** Param target ids carried by the Param* ops. */
namespace pid {
inline constexpr std::uint32_t kFader = 0, kPan = 1, kSlotStride = 8, kMasterVolume = 100;
inline constexpr std::uint32_t slot(std::uint32_t i, std::uint32_t which) { return i * kSlotStride + which; }
}  // namespace pid

enum class Tap : std::uint32_t { Out = 0, Slot0Pan, Slot1Pan, Slot2Pan, Slot3Pan };
enum class InjectNode : std::uint32_t { Slot0Strip = 0 };

struct GraphStats {  // written on the audio thread, read anywhere (relaxed)
  std::atomic<std::uint32_t> heapDropped{0}, voicesStolen{0}, paramDropped{0};
  std::atomic<std::uint64_t> quanta{0};
};

class Graph {
 public:
  static constexpr std::size_t kSlots = 4, kVoices = 16, kHeap = 8192;

  Graph(double sampleRate, CommandQueue &in, EventQueue &out, Seqlock<rig_meters> &meters);

  /** Move queued commands into the pending heap. */
  void drainCommands();
  /** Render one quantum of RIG_QUANTUM_FRAMES into out[0..channels). Applies due commands first. */
  void renderQuantum(float *const *out, unsigned channels);

  std::int64_t frame() const { return frame_; }
  double sampleRate() const { return sr_; }
  const GraphStats &stats() const { return stats_; }
  std::uint32_t liveVoices() const;
  void setSampleRate(double sr) { sr_ = sr; }
  /** Host-side numbers folded into the next meter snapshot (audio thread). */
  void setHostStats(float cpu, std::uint32_t xruns) { cpu_ = cpu; xruns_ = xruns; }

 private:
  struct Slot {
    const SlotSpec *spec = nullptr;
    wa::Param fader{0.0}, pan{0.0};
    SlotEq eq;
    std::array<TestVoice, kVoices> voices;
    std::uint32_t nextVoice = 0;
    int tail = 0;  // quanta left to render with silent input (EQ ring-out)
  };
  void apply(const Command &c);
  void renderSlot(std::size_t i, std::int64_t q0, float (*sum)[RIG_QUANTUM_FRAMES],
                  float (*tapBuf)[RIG_QUANTUM_FRAMES]);
  void garbage(GarbageKind k, void *p);
  void pushEvent(const AudioEvent &e);
  wa::Param *paramFor(std::uint32_t target);

  double sr_;
  CommandQueue &in_;
  EventQueue &out_;
  Seqlock<rig_meters> &meters_;
  std::int64_t frame_ = 0;
  Slot slots_[kSlots];
  wa::Param master_{0.5011872336272722};
  Command heap_[kHeap];
  std::size_t heapN_ = 0;
  Tap tap_ = Tap::Out;
  InjectBuffer *inject_ = nullptr;
  float peakRing_[64][2] = {};
  unsigned peakPos_ = 0;
  GraphStats stats_;
  float cpu_ = 0;
  std::uint32_t xruns_ = 0;
};

}  // namespace rig
