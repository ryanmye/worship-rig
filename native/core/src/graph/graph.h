// Render graph (audio thread). Executes Commands, renders 128-frame quanta through the FIXED topology of
// graph/unit.h over pluggable units. Orchestrator-owned and frozen after T00b: modules never edit it; they register
// units (api/registry.h) that the Model attaches with Op::AttachUnit.
//
// Clock (contract 6.3, SETUP_REVIEW 15/16): `frame()` is the TIME-GRID frame: engine time = frame / sampleRate,
// always. A device rate change is handed over lock-free (requestSampleRate, any thread) and adopted by the audio
// thread between two quanta: the grid is rebased to frame' = ceil(frame * new / old) (engine time continues, moves
// forward by < 1 sample, never backwards), pending command frames are rescaled the same way, every unit gets
// setSampleRate, and a RateChanged event tells the control side to rebuild rate-dependent tables. `rendered()` counts
// frames actually rendered (statistics only).
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>

#include "graph/epoch.h"
#include "graph/unit.h"
#include "mix/slot_spec.h"
#include "rig/rig_engine.h"
#include "runtime/command.h"
#include "runtime/seqlock.h"
#include "runtime/spsc.h"

namespace rig {

using CommandQueue = SpscQueue<Command, 16384>;
using EventQueue = SpscQueue<AudioEvent, 4096>;
// INTERFACE-CHANGE(T08): Garbage never shares the event ring (SETUP_REVIEW 18, WAVE0B_REVIEW V13). Its own ring is
// sized above every pointer that can be in flight (command ring 16384 + pending heap 8192 + 105 units); a full ring
// parks the pointer in a fixed stash retried every quantum, so a slow control thread delays frees but never leaks.
using GarbageQueue = SpscQueue<AudioEvent, 32768>;

struct GraphStats {  // written on the audio thread, read anywhere (relaxed)
  std::atomic<std::uint32_t> heapDropped{0}, voicesStolen{0}, paramDropped{0}, eventsDropped{0}, rateChanges{0};
  std::atomic<std::uint64_t> quanta{0};
  // INTERFACE-CHANGE(T08): garbage parked because its ring was full / lost because the stash was full too
  std::atomic<std::uint32_t> garbageParked{0}, garbageLost{0};
};

/** Published once per quantum (seqlock): what the control side needs to map engine time <-> frames. */
struct TimeBase {
  std::int64_t frame = 0;       // time-grid frame of the next quantum to render
  double sampleRate = 48000;    // rate of that grid
  std::uint64_t rendered = 0;   // frames rendered in total
  std::uint64_t epoch = 0;
  double time() const { return static_cast<double>(frame) / sampleRate; }
};

/** Frees what a never-applied command owns (shutdown path; control thread). */
void freeCommandPayload(const Command &c);
/** Frees a Garbage event's object (control thread). */
void freeGarbage(const AudioEvent &e);

class Graph final : private EventSink {
 public:
  static constexpr std::size_t kHeap = 8192;

  Graph(double sampleRate, CommandQueue &in, EventQueue &out, Seqlock<rig_meters> &meters);
  ~Graph();
  Graph(const Graph &) = delete;
  Graph &operator=(const Graph &) = delete;

  /** Move queued commands into the pending heap (audio thread; offline: the caller's thread). */
  void drainCommands();
  /** Render one quantum of RIG_QUANTUM_FRAMES into out[0..channels). Applies due commands first. */
  void renderQuantum(float *const *out, unsigned channels);

  /** Any thread, lock-free: the rate the next quantum is rendered at (rig_host_audio_started). */
  void requestSampleRate(double sr) { requestedSr_.store(sr, std::memory_order_release); }

  // Audio-thread views (offline driver: caller's thread).
  std::int64_t frame() const { return frame_; }
  double sampleRate() const { return sr_; }
  // Any thread.
  TimeBase timeBase() const { return timeBase_.read(); }
  const GraphStats &stats() const { return stats_; }
  std::uint64_t epoch() const { return epoch_.current(); }
  std::uint32_t liveVoices() const;
  // INTERFACE-CHANGE(T08) begin: control-thread consumers of the reliable paths (SETUP_REVIEW 18).
  /** Control thread: next handed-back object (free it with freeGarbage / Model::onAudioEvent). */
  bool popGarbage(AudioEvent &e) { return garbage_.pop(e); }
  /** Control thread: unit slots (bit = UnitSlot - 64 * word) whose VoiceEnded was lost to a full event ring since
   *  the last call; the owner rescans those slots (Dropped event, "ended bits"). T00c: two words (105 unit slots). */
  static constexpr unsigned kEndedWords = (kUnitSlots + 63) / 64;
  std::uint64_t takeEndedSlots(unsigned word = 0) {
    return word < kEndedWords ? endedLost_[word].exchange(0, std::memory_order_acq_rel) : 0;
  }
  // INTERFACE-CHANGE(T08) end
  /** INTERFACE-CHANGE(T00c) D3: slots of the committed song (1..16; 0 = none yet), copied into every meter
   *  snapshot (rig_meters.slot_count). Set by the bridge after a commit. [any] */
  void setSlotCount(std::uint32_t n) { slotCount_.store(n, std::memory_order_relaxed); }
  /** Host-side numbers folded into the next meter snapshot (audio thread). */
  void setHostStats(float cpu, std::uint32_t xruns) {
    cpu_ = cpu;
    xruns_ = xruns;
  }

 private:
  bool push(const AudioEvent &e) override;
  void apply(const Command &c);
  void applyParam(const Command &c);
  void adoptRate(double sr);
  void garbage(GarbageKind k, void *p);
  void renderChannel(UnitSlot inst, UnitSlot strip, bool injectHere, const RenderContext &base, Bus *tapBus);
  void runUnit(UnitSlot s, const RenderContext &base, UnitIO &io);
  void addInject(std::uint32_t point, Bus &bus);
  bool injectOverlaps(std::uint32_t point) const;
  void flushGarbageStash();                              // INTERFACE-CHANGE(T08)
  void slotAccumulate(std::size_t slot, const Bus &strip);  // INTERFACE-CHANGE(T00c) D3 / T08 #1
  void slotMeters();                                         // INTERFACE-CHANGE(T00c)

  double sr_;
  std::atomic<double> requestedSr_;
  CommandQueue &in_;
  EventQueue &out_;
  Seqlock<rig_meters> &meters_;
  Seqlock<TimeBase> timeBase_;
  EpochCounter epoch_;
  std::int64_t frame_ = 0;
  std::uint64_t rendered_ = 0;
  Unit *units_[kUnitSlots] = {};
  // buses (one quantum each)
  Bus instBus_, stripBus_, sends_[kSendBuses], sum_, fxBus_, eqIn_, outBus_, clickBus_, tapBus_;
  Command heap_[kHeap];
  std::size_t heapN_ = 0;
  int tap_ = 0;  // index into kTapPoints (0 = out)
  InjectBuffer *inject_ = nullptr;
  bool clickAux_ = false, clickRecord_ = false;
  float peakRing_[64][2] = {};
  unsigned peakPos_ = 0;
  GraphStats stats_;
  float cpu_ = 0;
  std::uint32_t xruns_ = 0;
  std::uint32_t lostEvents_ = 0;
  // INTERFACE-CHANGE(T08): reliable garbage path, lost-VoiceEnded bits, per-slot 256-frame level (rig_meters
  // slot_peak / slot_rms: post-pan strip output, mono down-mix 0.5 (L + R), two quanta; contract 3.11 slotLevel).
  GarbageQueue garbage_;
  static constexpr std::size_t kGarbageStash = 1024;
  AudioEvent stash_[kGarbageStash] = {};
  std::size_t stashN_ = 0;
  std::atomic<std::uint64_t> endedLost_[kEndedWords] = {};
  float slotPeakQ_[kChannels][2] = {};
  double slotSqQ_[kChannels][2] = {};
  // INTERFACE-CHANGE(T00c) D3 / T08 #1: per-slot mono accumulator of this quantum (the slot's strip + its retiring
  // strips, summed sample-wise, then peak / rms), the origin slot + 1 of each retiring strip (0 = none) and whether
  // a retiring strip of that origin sounded this quantum (rig_meters.slot_retiring).
  float slotAcc_[kChannels][kQ] = {};
  bool slotHas_[kChannels] = {}, slotRetiring_[kChannels] = {};
  std::uint8_t retireOrigin_[kRetiring] = {};
  std::atomic<std::uint32_t> slotCount_{0};
};

}  // namespace rig
