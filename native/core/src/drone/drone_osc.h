// The drone's drone-osc instruments (T16): drone.js _buildInst = registry.create(ctx, this.o.rng.fork(), DRONE_REF,
// params) on T11's inst::SynthInstrument, with the same PRNG stream as the JS one (contract 0: the instrument forks
// the stream it is given, InstrumentBase asRng).
#pragma once
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

#include "inst/synth.h"
#include "num/prng.h"

namespace rig::drone {

/** drone.js _instParams() as JSON (slots.<i>.params form): drift, unisonDrift, lfoDepth from movement 0..1. */
std::string droneOscParams(double movement);

/** registry.create(ctx, parent.fork(), {synth, drone-osc}, paramsJson): draws one fork from `parent`. */
std::unique_ptr<inst::SynthInstrument> makeDroneOsc(Rng &parent, double sampleRate, std::string_view paramsJson);

/** drone-osc param indices (inst/synth_patches.h kDrone). */
int droneOscParam(std::string_view key);
/** drone-osc's own attack default (s): 2.5 (synth.js). */
double droneOscAttack();

}  // namespace rig::drone
