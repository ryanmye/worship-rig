// Control -> audio commands (64-byte POD) and audio -> control events (32-byte POD).
// FROZEN by T00b (BUILD_PLAN "Interfaces"): layout, the core opcodes below and the per-task opcode RANGES. A task
// never adds lines to `enum class Op`: it declares its own opcodes in its module header as
//   enum class ReverbOp : std::uint16_t { SetBucket = kOpBaseT04, ... };
// and sends them with `opOf(ReverbOp::SetBucket)`. The graph routes every opcode >= kOpModuleFirst to the unit in
// unit slot `target` (graph/unit.h `UnitSlot`), which decodes it in `Unit::apply`. Core opcodes are routed by the
// graph itself (params, attach/detach, notes to instrument slots, test hooks).
#pragma once
#include <cstdint>
#include <type_traits>

namespace rig {

/** Frame sentinel: "first frame of the next quantum that dequeues the command". */
inline constexpr std::int64_t kFrameNow = INT64_MIN;

// ---- opcode ranges ------------------------------------------------------------------------------------------------
// | range           | owner | module                                   |
// |-----------------|-------|------------------------------------------|
// | 0x0000..0x00FF  | core  | this file (orchestrator only)            |
// | 0x0100..0x01FF  | T01   | time/ (e.g. valueCurve, cancelScheduled) |
// | 0x0200..0x02FF  | T02   | mix/slot_channel, slot_eq, master_eq     |
// | 0x0300..0x03FF  | T03   | mix/master_chain, dsp/compressor         |
// | 0x0400..0x04FF  | T04   | fx/reverb                                |
// | 0x0500..0x05FF  | T05   | fx/delay, fx/chorus, fx/lofi             |
// | 0x0600..0x06FF  | T06   | samples/ (cache side; rarely RT)         |
// | 0x0700..0x07FF  | T07   | click/, midi/                            |
// | 0x0800..0x08FF  | T08   | runtime/, meter/, rec/                   |
// | 0x0B00..0x0BFF  | T11   | inst/voice, synth, allocator             |
// | 0x0C00..0x0CFF  | T12   | inst/sampler                             |
// | 0x0D00..0x0DFF  | T13   | model graph_build (retire, routing)      |
// | 0x0E00..0x0EFF  | T14   | model perform (wheels, bend, swell)      |
// | 0x0F00..0x0FFF  | T15   | inst/synth_extra, inst/organ             |
// | 0x1000..0x10FF  | T16   | drone/                                   |
// | 0x1A00..0x1AFF  | T11a  | dsp sources (oscillator, buffer source)  |
// | 0x7F00..0x7FFF  | tests | scratch modules under tests/ only        |
// Unlisted values are reserved. A range is 256 opcodes; ask the orchestrator for a second one.
inline constexpr std::uint16_t kOpModuleFirst = 0x0100;
inline constexpr std::uint16_t kOpBaseT01 = 0x0100, kOpBaseT02 = 0x0200, kOpBaseT03 = 0x0300, kOpBaseT04 = 0x0400,
                               kOpBaseT05 = 0x0500, kOpBaseT06 = 0x0600, kOpBaseT07 = 0x0700, kOpBaseT08 = 0x0800,
                               kOpBaseT11 = 0x0B00, kOpBaseT12 = 0x0C00, kOpBaseT13 = 0x0D00, kOpBaseT14 = 0x0E00,
                               kOpBaseT15 = 0x0F00, kOpBaseT16 = 0x1000, kOpBaseT11a = 0x1A00,
                               kOpBaseTests = 0x7F00;
inline constexpr std::uint16_t kOpRangeSize = 0x0100;

enum class Op : std::uint16_t {
  None = 0,
  // Param timeline events: target = ParamTarget (graph/unit.h paramTarget()), a = value, b = time (s),
  // c = time constant / duration.
  ParamSet = 1,         // setValueAtTime(a, b)
  ParamLinear = 2,      // linearRampToValueAtTime(a, b)
  ParamExp = 3,         // exponentialRampToValueAtTime(a, b)
  ParamTarget = 4,      // setTargetAtTime(a, b, c)
  ParamCancelHold = 5,  // cancelAndHoldAtTime(b)
  // Object management (ptr owned by the control side until handed back through a Garbage event).
  AttachSlot = 6,  // legacy T00 skeleton: target = slot 0..3, ptr = SlotSpec* (builtin strip + test instrument)
  // Perform. target = unit slot of an instrument (UnitSlot::Inst0..15, RetireInst*) or kAllSlots.
  NoteOn = 7,       // aux = note | vel << 8, f.c = velocity gain (0..1, after the touch curve; 0 = derive from vel)
  NoteOff = 8,      // aux = note; sub = 1: forced release (ignore pedal)
  AllNotesOff = 9,  // 30 ms fade of every voice (panic of instruments)
  // Test hooks.
  TestTap = 10,     // aux = test point index (graph/test_points.h)
  TestInject = 11,  // aux = test point index, ptr = InjectBuffer* (garbage when replaced)
  Panic = 12,       // hard kill of every voice (no fade)
  // ---- T00b additions (frozen) ----
  AttachUnit = 16,   // target = UnitSlot, ptr = Unit* (the previous unit in that slot goes back as Garbage);
                     // T00c: into a RetireStrip slot, aux = origin slot + 1 (its slot meter; 0 = none)
  DetachUnit = 17,   // target = UnitSlot (the unit goes back as Garbage; the slot renders silence / pass-through)
  Sustain = 18,      // target = instrument slot or kAllSlots, aux = 1 down / 0 up (pedal-held bookkeeping)
  Bend = 19,         // target = instrument slot, a = semitones (Instrument::setBend)
  LegatoTo = 20,     // target = instrument slot, aux = from | to << 8, f.c = glide seconds
  InstParam = 21,    // target = instrument slot, aux = param index (Instrument::paramIndex), a = value, b = time,
                     // c = glide / tau
  ReleaseVoice = 22,  // target = instrument slot, aux = voice id; f.a = fade seconds (pedalHold, steal, retire)
  ClickRoute = 23,    // graph: aux bit 0 = click on device channels 3-4 (else added to out 1-2), bit 1 = recorded
  // INTERFACE-CHANGE(T00c) D1: per-slot polyphony cap. target = instrument slot, aux = cap (32 | 64 | 128);
  // decoded into Instrument::setVoiceCap. The Model sends it right after every instrument AttachUnit and on change.
  VoiceCap = 24,
  // INTERFACE-CHANGE(T00c) D3 / T08 #1: move a live unit (state kept) from slot `aux` to slot `target`, e.g. a
  // slot's instrument and strip into retiring channels at a commit (T13). The unit previously in `target` goes back
  // as Garbage; `aux` is left empty. A strip moved from Strip<i> into a RetireStrip slot keeps metering slot i
  // (rig_meters slot arrays); RetireStrip -> RetireStrip keeps its origin. Never allocates.
  MoveUnit = 25
};

/** A module opcode from its own enum (see the range table). */
template <class E>
constexpr Op opOf(E e) {
  static_assert(sizeof(E) == sizeof(std::uint16_t), "module opcodes are uint16 enums");
  return static_cast<Op>(static_cast<std::uint16_t>(e));
}
constexpr bool isModuleOp(Op op) {
  return static_cast<std::uint16_t>(op) >= kOpModuleFirst;
}

inline constexpr std::uint32_t kAllSlots = 0xffffffffu;

/** Command::sub of a module opcode whose p.ptr is an rig::Owned* payload: if no unit can take it (slot empty, heap
 *  full, shutdown) the graph / engine hands it back or deletes it instead of leaking it. The receiving unit owns it
 *  and returns it with Unit::giveBack. */
inline constexpr std::uint16_t kSubOwnedPayload = 0xffff;

struct Command {
  std::int64_t frame;  // engine (time-grid) frame the command takes effect (kFrameNow = next quantum)
  std::uint32_t seq;   // control-side sequence number (FIFO among equal frames)
  Op op;
  std::uint16_t sub;
  std::uint32_t target;
  std::uint32_t aux;
  struct FloatArgs {
    double a, b, c, d, e;
  };
  struct PtrArgs {
    void *ptr;
    std::uint64_t u0, u1, u2, u3;
  };
  union {
    FloatArgs f;
    PtrArgs p;
  };
};
static_assert(sizeof(Command) == 64, "Command is one cache line");
static_assert(std::is_trivially_copyable_v<Command>, "Command is a POD");

enum class EventKind : std::uint16_t {
  None = 0,
  VoiceEnded = 1,  // a = unit slot, b = voice id, frame
  Garbage = 2,     // ptr handed back to the control thread (free it there); aux = GarbageKind
  Xrun = 3,
  TimerDue = 4,     // earliest due control timer passed (quantum index in frame)
  RateChanged = 5,  // the audio thread adopted a new sample rate at `frame` (a = new rate, b = old rate)
  UnitEvent = 6,    // module-defined: aux = UnitSlot, sub = module event code (its own opcode range), a/b = payload
  Dropped = 7       // the ring was full earlier: aux = events lost (T08 adds the ended-bits scan, SETUP_REVIEW 18)
};

// Owned = rig::Owned* (graph/unit.h, virtual destructor): every module payload. Unit = rig::Unit*.
enum class GarbageKind : std::uint32_t { SlotSpec = 1, InjectBuffer = 2, Unit = 3, Owned = 4 };

struct AudioEvent {
  std::int64_t frame;
  EventKind kind;
  std::uint16_t sub;
  std::uint32_t aux;
  struct FloatArgs {
    double a, b;
  };
  union {
    FloatArgs f;
    void *ptr;
  };
};
static_assert(sizeof(AudioEvent) == 32, "AudioEvent is 32 bytes");
static_assert(std::is_trivially_copyable_v<AudioEvent>, "AudioEvent is a POD");

}  // namespace rig
