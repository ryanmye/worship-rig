// Reverb send effect (UnitSlot::Reverb). Interface FROZEN by T00b; T04 implements (fx/reverb.cpp, fx/ir_gen*,
// dsp/convolver*) and registers kind "reverb" + the "reverb" ReverbService (model/services.h) + set handler
// "fx.reverb.".
//
// Chain (contract 3.4): io.in (send bus) -> HPF 180 -> LPF 9k -> predelay (2 lines, 0.5 s xfade) -> convolver unit
// (0.8 s equal-power unit crossfade) -> returnGain -> wheel -> io.out. Tap "fx.reverb.output" = io.out, inject
// "fx.reverb.input" = io.in (graph buses, graph/test_points.h).
// Construction: from UnitSpec::patch->reverb (ReverbPatch: size, damp, predelay, returnGain); the IR kernel is built
// on the IR worker (inline offline) and attached with ReverbOp::AttachKernel.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindReverb = "reverb";

enum ReverbParam : std::uint32_t { kReverbReturnGain = 0, kReverbWheel = 1 };

enum class ReverbOp : std::uint16_t {
  AttachKernel = kOpBaseT04,  // ptr = kernel object (T04 type), crossfade per contract 3.4; old one -> Garbage
  SetPredelay,                // a = seconds (0.5 s equal-power crossfade between the two lines)
  // T04 appends below.
  Reactivate,  // aux = slot: swap back to the unit still held in that slot (a = when, b = fade, c = predelay,
               // d = slot to fade out or -1); T04 (fx/reverb_unit.h)
  Release,     // aux = slot: hand the slot's unit back (pool eviction, memory trim); T04
  Feed,        // aux = slot, a = 1 connect / 0 disconnect the slot's input (sleep / wake); T04
};

struct UnitEnv;
struct UnitSpec;
Unit *makeReverb(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
