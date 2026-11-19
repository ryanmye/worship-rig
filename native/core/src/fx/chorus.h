// Chorus send effect (UnitSlot::Chorus). Interface FROZEN by T00b; T05 implements (fx/chorus.cpp) and registers kind
// "chorus" + set handler "fx.chorus.".
//
// Contract 3.6: mono input 1/2(L+R); two DelayNode voices 7 ms + sine LFO (dsp/oscillator.h with a PeriodicWave
// real=[0, sin phi], imag=[0, cos phi]; phi0 = rngFor(seed, 'chorus').next()*2pi, voice 2 phi0 + pi/2), depth gain
// 0.002*depth s, rates r and 1.07r, r = clamp(rate, .15, 1.5); voice 0 -> L, voice 1 -> R; LFO tau 50 ms.
// Tap "fx.chorus.output" = io.out, inject "fx.chorus.input" = io.in.
// Construction: from UnitSpec::patch->chorus (ChorusPatch) and UnitEnv::seed.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindChorus = "chorus";

enum ChorusParam : std::uint32_t { kChorusReturnGain = 0, kChorusRate = 1, kChorusDepth = 2 };

enum class ChorusOp : std::uint16_t {
  Reserved = kOpBaseT05 + 0x40,  // chorus uses 0x0540..0x057F
};

struct UnitEnv;
struct UnitSpec;
Unit *makeChorus(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
