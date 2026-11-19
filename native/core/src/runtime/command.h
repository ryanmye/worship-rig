// Control -> audio commands (64-byte POD) and audio -> control events (32-byte POD). Interfaces frozen by T00.
#pragma once
#include <cstdint>
#include <type_traits>

namespace rig {

/** Frame sentinel: "first frame of the next quantum that dequeues the command". */
inline constexpr std::int64_t kFrameNow = INT64_MIN;

enum class Op : std::uint16_t {
  None = 0,
  // Param timeline events: target = ParamTarget, a = value, b = time (s), c = time constant / duration.
  ParamSet,         // setValueAtTime(a, b)
  ParamLinear,      // linearRampToValueAtTime(a, b)
  ParamExp,         // exponentialRampToValueAtTime(a, b)
  ParamTarget,      // setTargetAtTime(a, b, c)
  ParamCancelHold,  // cancelAndHoldAtTime(b)
  // Object management (ptr owned by the control side until handed back through a Garbage event).
  AttachSlot,  // target = slot, ptr = const SlotSpec*
  // Perform.
  NoteOn,   // target = slot (or kAllSlots), aux = note | vel << 8
  NoteOff,  // target = slot, aux = note
  AllNotesOff,
  // Test hooks.
  TestTap,     // aux = tap id
  TestInject,  // aux = inject node id, ptr = const InjectBuffer* (garbage when replaced)
  Panic
};

inline constexpr std::uint32_t kAllSlots = 0xffffffffu;

struct Command {
  std::int64_t frame;  // engine frame the command takes effect (kFrameNow = next quantum)
  std::uint32_t seq;   // control-side sequence number (FIFO among equal frames)
  Op op;
  std::uint16_t sub;
  std::uint32_t target;
  std::uint32_t aux;
  union {
    struct {
      double a, b, c, d, e;
    } f;
    struct {
      void *ptr;
      std::uint64_t u0, u1, u2, u3;
    } p;
  };
};
static_assert(sizeof(Command) == 64, "Command is one cache line");
static_assert(std::is_trivially_copyable_v<Command>, "Command is a POD");

enum class EventKind : std::uint16_t {
  None = 0,
  VoiceEnded,  // a = slot, b = voice index, frame
  Garbage,     // ptr handed back to the control thread (free it there); aux = GarbageKind
  Xrun,
  TimerDue  // earliest due control timer passed (quantum index in frame)
};

enum class GarbageKind : std::uint32_t { SlotSpec = 1, InjectBuffer = 2 };

struct AudioEvent {
  std::int64_t frame;
  EventKind kind;
  std::uint16_t sub;
  std::uint32_t aux;
  union {
    struct {
      double a, b;
    } f;
    void *ptr;
  };
};
static_assert(sizeof(AudioEvent) == 32, "AudioEvent is 32 bytes");
static_assert(std::is_trivially_copyable_v<AudioEvent>, "AudioEvent is a POD");

}  // namespace rig
