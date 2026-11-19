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
  // T16 appends below.
};

struct UnitEnv;
struct UnitSpec;
Unit *makeDrone(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
