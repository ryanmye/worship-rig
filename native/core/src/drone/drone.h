// Drone (UnitSlot::Drone). Interface FROZEN by T00b; T16 implements (drone/) and registers kind "drone", the "drone"
// DroneService (model/services.h) and set handler "drone.".
//
// Contract 3.9: layers (drone-osc voices via an Instrument of kind "inst.synth" owned by the unit) -> synth bus trim
// -> HPF 80 -> width matrix -> level -> wheel -> bend -> io.out (summed into `sum`); io.sends[kSendReverb] += out *
// sendGate (.4 synth, 0 files/frozen). Construction: from UnitSpec::patch->drone (DronePatch) + the drone config
// held by the service.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindDrone = "drone";

enum DroneParam : std::uint32_t { kDroneLevel = 0, kDroneWidthA = 1, kDroneWidthB = 2, kDroneSendGate = 3 };

enum class DroneOp : std::uint16_t {
  Reserved = kOpBaseT16,
  // T16 appends below. Decoded by drone/drone_unit.cpp; `slot` = an instrument slot of the unit (< kMaxInst), `pad`
  // a pad player (< kMaxPads), `loop` a frozen-loop player (< kMaxLoops). Times are engine seconds.
  Param,      // sub = param index (drone_unit.h), aux = ParamCall, a = value, b = time, c = time constant
  SetInst,    // aux = slot, sub = kSubOwnedPayload, p.ptr = InstBox* (the old one goes back as Garbage)
  DropInst,   // aux = slot: the instrument goes back as Garbage (disposed on the control thread)
  Arm,        // aux = slot, a = 1 rendered into the synth bus / 0 waiting disconnected (drone.js idle-cpu #1)
  NoteOn,     // aux = slot, a = note, b = time, c = velocity 0..1
  NoteOff,    // aux = slot, a = note, b = time
  AllOff,     // aux = slot, b = time (voice.js allOff: every voice fades)
  InstParam,  // aux = slot, sub = param index (synth_patches.h), a = value, b = time
  Morph,      // aux = slot, a = 0..1, b = time
  Bend,       // aux = slot, a = semitones, b = time
  InstWaves,  // aux = slot, sub = kSubOwnedPayload, p.ptr = inst::WavesPayload* (rate change, T11a O4)
  PadStart,   // aux = pad, sub = kSubOwnedPayload, p.ptr = BufRef*; p.u0..u2 = bit_cast when, offset, loop (0/1)
  PadStop,    // aux = pad: stop now and hand the buffer back
  LoopStart,  // aux = loop, sub = kSubOwnedPayload, p.ptr = BufRef*; p.u0, u1 = bit_cast when, offset
  LoopStop,   // aux = loop: stop now and hand the buffer back
};

struct UnitEnv;
struct UnitSpec;
Unit *makeDrone(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
