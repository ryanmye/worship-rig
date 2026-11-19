// Lofi (UnitSlot::Lofi, after the sum). Interface FROZEN by T00b; T05 implements (fx/lofi.cpp) and registers kind
// "lofi" + set handler "fx.lofi.". Absent unit = exact pass-through (amount 0 behaviour).
//
// Contract 3.7: amount 0 => dry gain exactly 1, wet disconnected. Wet: x.25 -> tanh WaveShaper 4x
// (dsp/waveshaper.h, T03) -> quantiser -> tape delay (5 ms + wow .35 Hz + flutter 5 Hz LFOs, dsp/oscillator.h)
// -> HPF -> LPF -> x4, + crackle loop (6 s, rngFor(seed,'crackle'), dsp/buffer_source.h) -> BPF 2500 -> gain.
// Engage 30 ms after .0075 + 320/sr. Tap "fx.lofi.output" = io.out (= the master EQ input `eqIn`).
// Construction: from UnitSpec::patch->lofi (LofiPatch), RIG_FLAG_NO_LOFI => the Model does not attach one.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindLofi = "lofi";

enum LofiParam : std::uint32_t { kLofiDry = 0, kLofiWet = 1, kLofiLpfHz = 2, kLofiHpfHz = 3, kLofiCrackleGain = 4 };

enum class LofiOp : std::uint16_t {
  Apply = kOpBaseT05 + 0x80,  // ptr = resolved lofi state (T05 type): curves stepped, engage/disengage; 0x0580..0x05FF
};

struct UnitEnv;
struct UnitSpec;
Unit *makeLofi(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
