// Delay send effect (UnitSlot::Delay). Interface FROZEN by T00b; T05 implements (fx/delay.cpp) and registers kind
// "delay" + set handler "fx.delay.".
//
// Contract 3.5: two lines (sync time from SongState::tempo, glide <= 5 %, else line switch/flush), ping-pong matrix,
// tone LPF 1200*10^tone, feedback (4 gains, wash override), NO 128-frame feedback split (Q9), panic (feedback -> 0
// for max(0.2 s, longest line + 50 ms)). Tap "fx.delay.output" = io.out, inject "fx.delay.input" = io.in.
// Construction: from UnitSpec::patch->delay (DelayPatch) and UnitSpec::song->tempo.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindDelay = "delay";

enum DelayParam : std::uint32_t { kDelayReturnGain = 0, kDelayFeedback = 1, kDelayTone = 2, kDelayWheel = 3 };

enum class DelayOp : std::uint16_t {
  SetTime = kOpBaseT05,  // a = seconds (glide or line switch decided on the audio side per contract 3.5)
  SetPingPong,           // aux = 0/1
  Panic,                 // feedback -> 0 window (contract allNotesOff)
  // T05 appends below (shared range with chorus/lofi: 0x0500..0x05FF; delay uses 0x0500..0x053F).
};

struct UnitEnv;
struct UnitSpec;
Unit *makeDelay(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
