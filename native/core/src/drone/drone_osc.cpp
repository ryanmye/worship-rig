// drone-osc construction for the drone (T16). See drone/drone_osc.h.
#include "drone/drone_osc.h"

#include <algorithm>
#include <cstdio>

#include "inst/synth_patches.h"

namespace rig::drone {
namespace {

std::string num17(double v) {
  char b[40];
  std::snprintf(b, sizeof b, "%.17g", v);
  return b;
}

}  // namespace

int droneOscParam(std::string_view key) {
  return inst::paramIndex(inst::patchDef(inst::PatchId::DroneOsc), key);
}

double droneOscAttack() {
  const inst::PatchDef &p = inst::patchDef(inst::PatchId::DroneOsc);
  const int i = inst::paramIndex(p, "attack");
  return i >= 0 ? p.params[i].def : 2.5;
}

std::string droneOscParams(double movement) {
  // drone.js _instParams: only the keys drone-osc has (drift, unisonDrift, lfoDepth), in that order
  const double m = std::clamp(movement, 0.0, 1.0);
  return "{\"drift\":" + num17(1 + 6 * m) + ",\"unisonDrift\":" + num17(1.6 + 8 * m) +
         ",\"lfoDepth\":" + num17(20 + 600 * m) + "}";
}

std::unique_ptr<inst::SynthInstrument> makeDroneOsc(Rng &parent, double sampleRate, std::string_view paramsJson) {
  // registry.create(ctx, rng.fork(), ...): the drone forks its stream once, the instrument forks what it is given
  // (InstrumentBase asRng) once more: T11's Rng constructor (T16 review O3; replaces the FNV-1a preimage name)
  return std::make_unique<inst::SynthInstrument>(inst::patchDef(inst::PatchId::DroneOsc), sampleRate, parent.fork(),
                                                 paramsJson, 0.0);
}

}  // namespace rig::drone
