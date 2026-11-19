// SlotChannel: the strip of a slot (UnitSlot::Strip0..3, RetireStrip0..15). Interface FROZEN by T00b; T02 implements
// it in mix/slot_channel.cpp and registers kind "strip" (replacing the builtin skeleton strip of
// graph/builtin_units.cpp, which only has fader -> SlotEq -> pan).
//
// Chain (contract 3.1-3.3): in (instrument, armed while voices live) -> fader -> wheel -> width (M/S) -> SlotEq ->
// pan -> out; sends are post-pan: io.sends[kSendReverb|kSendDelay|kSendChorus] += out * send gain.
// Construction: from UnitSpec::patch->slots[UnitSpec::channel] (gain, pan, width x instrument widthDefault, sends,
// spec.eq). A fresh strip starts with the fader at 0; the Model SETS it to the slot gain at the commit instant.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "mix/slot_eq.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindStrip = "strip";

/** Param indices (paramTarget(stripSlot(i), index)). */
enum StripParam : std::uint32_t {
  kStripFader = 0,
  kStripPan = 1,
  kStripWheel = 2,        // wheel factor (contract 2.6)
  kStripWidthNarrow = 3,  // wNarrow = min(w,1) - 1 (contract 2.3 width row)
  kStripWidthWide = 4,    // wWide = max(0, w - 1)
  kStripSendReverb = 5,
  kStripSendDelay = 6,
  kStripSendChorus = 7,
};

/** Module opcodes (T02 range). */
enum class StripOp : std::uint16_t {
  SetEq = kOpBaseT02,  // ptr = SlotEqSpec* (control-owned until Garbage), aux = SlotEq::Change kind (T02 defines)
  EqAudition,          // aux = 1 bypass / 0 on (contract 1.3 eqAudition; ends at commit)
  SetWidthDefault,     // a = instrument widthDefault
  // T02 appends below; values are stable once used.
};

struct UnitEnv;
struct UnitSpec;
/** Factory registered under kKindStrip by T02 (mix/slot_channel_register.cpp). */
Unit *makeSlotChannel(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
