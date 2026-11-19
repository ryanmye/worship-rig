// Render units: the pluggable audio-thread objects the Graph renders in a FIXED topology (contract section 3 diagram).
// FROZEN by T00b. A module (reverb, delay, strip, instrument, ...) implements `Unit`, registers a factory for its
// kind name in api/registry.h from its own `<name>_register.cpp`, and the Model attaches instances to a UnitSlot with
// Op::AttachUnit. Nothing in graph/ changes when a module lands.
//
// Topology per quantum (graph.cpp, orchestrator-owned):
//   for each channel c in {Inst0..3 + Strip0..3, RetireInst/RetireStrip 0..15}:
//     inst  -> instBus (source: io.in = null)          [inject "slot0.strip" is added to slot 0's instBus]
//     strip -> stripOut, += sends[Reverb|Delay|Chorus] [tap "slot0.pan"/"slot1.pan" = Strip0/1 out]
//     sum += stripOut
//   Drone -> droneOut, += sends[Reverb]; sum += droneOut
//   [inject fx.reverb.input / fx.delay.input / fx.chorus.input into the send buses]
//   Reverb(sendReverb) -> sum += out; Delay(sendDelay) -> sum += out; Chorus(sendChorus) -> sum += out
//   [inject/tap fx.sum]
//   Lofi(sum) -> eqIn                (absent: pass-through)       [inject fx.eqIn, tap fx.lofi.output]
//   MasterChain(eqIn) -> out         (absent: pass-through)       [unit-local: tap fx.eqOut/fx.master, inject preComp]
//   Click -> clickBus (mono); main: out += click, aux: device channels 3-4 (record flag: Recorder sees it)
//   Meter(in = out), Recorder(in = out [+ click]) are sinks (io.out = null)
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "rig/rig_engine.h"
#include "runtime/command.h"

namespace rig {
namespace wa {
class Param;
}

inline constexpr std::size_t kQ = RIG_QUANTUM_FRAMES;

/** One quantum of up to 2 channels. `channels` follows Web Audio channel-count propagation (1 = mono source). */
struct Bus {
  alignas(16) float ch[2][kQ];
  unsigned channels = 2;

  void clear(unsigned n = 2) {
    std::memset(ch, 0, sizeof ch);
    channels = n;
  }
  /** this += src with Web Audio "speakers" up-mix (mono into stereo = both channels); stereo into mono keeps
   *  this bus stereo (a mixing bus takes the max channel count). */
  void add(const Bus &src) {
    if (src.channels == 1) {
      for (std::size_t i = 0; i < kQ; ++i) ch[0][i] += src.ch[0][i];
      if (channels == 2)
        for (std::size_t i = 0; i < kQ; ++i) ch[1][i] += src.ch[0][i];
      return;
    }
    if (channels == 1) {  // widen: the existing mono content goes to both channels first
      std::memcpy(ch[1], ch[0], sizeof ch[0]);
      channels = 2;
    }
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < kQ; ++i) ch[c][i] += src.ch[c][i];
  }
};

/** Base of command payloads that go back through a Garbage event (GarbageKind::Owned) and are deleted on the
 *  control thread through this virtual destructor: modules derive their payload structs from it. */
struct Owned {
  virtual ~Owned() = default;
};

/** Fixed unit slots of the graph. Values are frozen (Command::target, test point table, ParamTarget). */
enum class UnitSlot : std::uint16_t {
  Inst0 = 0,  // Inst0..Inst3 = 0..3: the instrument of slot i
  Strip0 = 4,  // Strip0..Strip3 = 4..7: the SlotChannel (strip) of slot i
  RetireInst0 = 8,  // 8..23: retiring channels' instruments (T13; contract 1.2 commit)
  RetireStrip0 = 24,  // 24..39: retiring channels' strips
  Drone = 40,
  Reverb = 41,
  Delay = 42,
  Chorus = 43,
  Lofi = 44,
  MasterChain = 45,
  Click = 46,
  Meter = 47,     // sink: per-quantum peaks, slot taps, RTA (T08)
  Recorder = 48,  // sink: rec ring (T08)
  Count = 49
};
inline constexpr std::size_t kUnitSlots = static_cast<std::size_t>(UnitSlot::Count);
inline constexpr std::size_t kChannels = 4, kRetiring = 16;
constexpr UnitSlot instSlot(std::size_t i) {
  return static_cast<UnitSlot>(static_cast<std::uint16_t>(UnitSlot::Inst0) + i);
}
constexpr UnitSlot stripSlot(std::size_t i) {
  return static_cast<UnitSlot>(static_cast<std::uint16_t>(UnitSlot::Strip0) + i);
}
constexpr UnitSlot retireInstSlot(std::size_t i) {
  return static_cast<UnitSlot>(static_cast<std::uint16_t>(UnitSlot::RetireInst0) + i);
}
constexpr UnitSlot retireStripSlot(std::size_t i) {
  return static_cast<UnitSlot>(static_cast<std::uint16_t>(UnitSlot::RetireStrip0) + i);
}

/** Command::target of the Param* ops: unit slot in the high 16 bits, the unit's own param index in the low 16. */
constexpr std::uint32_t paramTarget(UnitSlot s, std::uint32_t index) {
  return (static_cast<std::uint32_t>(s) << 16) | (index & 0xffffu);
}
constexpr UnitSlot paramUnit(std::uint32_t target) {
  return static_cast<UnitSlot>(target >> 16);
}
constexpr std::uint32_t paramIndex(std::uint32_t target) {
  return target & 0xffffu;
}

/** Send buses (post-pan sends of the strips; the drone's send gate). */
enum SendBus : unsigned { kSendReverb = 0, kSendDelay = 1, kSendChorus = 2, kSendBuses = 3 };

/** Audio -> control events from inside a unit (voice ended, module events). Never blocks, never allocates. */
class EventSink {
 public:
  virtual bool push(const AudioEvent &e) = 0;  // false = ring full (counted, Dropped event later)

 protected:
  ~EventSink() = default;
};

struct RenderContext {
  std::int64_t frame0;  // first time-grid frame of the quantum: engine time of frame f = f / sampleRate
  double sampleRate;    // current rate (changes only between quanta, Unit::setSampleRate is called first)
  std::uint64_t epoch;  // quantum counter since creation (graph/epoch.h)
  UnitSlot self;        // the slot being rendered (for events)
  EventSink *events;
};

struct UnitIO {
  const Bus *in = nullptr;           // null for sources (instruments, drone, click)
  Bus *out = nullptr;                // OVERWRITTEN by the unit (set out->channels); null for sinks
  Bus *sends[kSendBuses] = {};       // ACCUMULATED (+=) by strips and the drone; null for other units
  const Bus *inject = nullptr;       // unit-local test injection (see Unit::kInject*), else null
  std::uint32_t injectPoint = 0;
  Bus *tap = nullptr;                // unit-local test tap to fill (see Unit::kTap*), else null
  std::uint32_t tapPoint = 0;
};

/**
 * Base of every render object. Construction, destruction and setup happen on the control thread (or a worker);
 * process/apply/param/setSampleRate run on the audio thread and must be real-time safe (no allocation, locks, I/O).
 * Ownership: the Model allocates, the graph holds the raw pointer between AttachUnit and the Garbage event.
 */
class Unit {
 public:
  virtual ~Unit() = default;

  /** Render one quantum. Must write every frame of io.out (silence included) and set io.out->channels. */
  virtual void process(const RenderContext &ctx, UnitIO &io) = 0;
  /** Module opcodes (range table in runtime/command.h) and the core per-unit ops (notes for instruments). */
  virtual void apply(const Command &) {}
  /** Param timeline by the unit's own index (its header's enum); null = no such param (command dropped). */
  virtual wa::Param *param(std::uint32_t index) {
    (void)index;
    return nullptr;
  }
  /** Audio thread, between quanta, when the device rate changes: recompute coefficients only (no allocation).
   *  Rate-dependent tables (IRs, wavetables, resampled buffers) are rebuilt by the control side on the
   *  RateChanged event and re-attached. */
  virtual void setSampleRate(double sr) { (void)sr; }
  /** Hand a no-longer-used payload back to the control thread (never free on the audio thread). */
  static void giveBack(const RenderContext &ctx, Owned *p) {
    if (!p) return;
    AudioEvent e{};
    e.frame = ctx.frame0;
    e.kind = EventKind::Garbage;
    e.aux = static_cast<std::uint32_t>(GarbageKind::Owned);
    e.ptr = p;
    ctx.events->push(e);  // a full ring leaks it (counted); never frees here
  }
  /** Live voices (instruments) or 1 while a tail rings (FX); feeds meters/stats and retire polling. */
  virtual std::uint32_t liveVoices() const { return 0; }
};

}  // namespace rig
