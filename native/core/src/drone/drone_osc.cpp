// drone-osc construction for the drone (T16). See drone/drone_osc.h.
#include "drone/drone_osc.h"

#include <algorithm>
#include <cstdio>
#include <vector>

#include "inst/synth_patches.h"
#include "num/hash_seed.h"

namespace rig::drone {
namespace {

constexpr std::uint32_t kFnvPrime = 0x01000193u;

constexpr std::uint32_t inverseOdd(std::uint32_t a) {
  std::uint32_t x = a;  // Newton: x <- x (2 - a x) doubles the correct low bits each step
  for (int i = 0; i < 5; ++i) x *= 2u - a * x;
  return x;
}
constexpr std::uint32_t kFnvPrimeInv = inverseOdd(kFnvPrime);
static_assert(kFnvPrime * kFnvPrimeInv == 1u, "FNV prime inverse");

std::string num17(double v) {
  char b[40];
  std::snprintf(b, sizeof b, "%.17g", v);
  return b;
}

}  // namespace

std::string rngNameFor(std::uint32_t state) {
  // hashSeed is FNV-1a: h = (h ^ c) * P with P odd, so each byte step can be undone. Meet in the middle on 4 free
  // bytes after a fixed prefix: 2 forward from the prefix, 2 backward from the target (65536 x 65536 pairs, ~1
  // expected match per tag byte; a few tags are tried).
  const std::string base = "drone-osc#";
  std::vector<std::uint64_t> fwd(65536);
  for (unsigned tag = 0; tag < 256; ++tag) {
    std::string prefix = base;
    prefix += static_cast<char>(tag);
    const std::uint32_t h0 = hashSeed("0|" + prefix);
    for (unsigned b1 = 0; b1 < 256; ++b1) {
      const std::uint32_t h1 = (h0 ^ b1) * kFnvPrime;
      for (unsigned b2 = 0; b2 < 256; ++b2) {
        const std::uint32_t h2 = (h1 ^ b2) * kFnvPrime;
        fwd[b1 << 8 | b2] = static_cast<std::uint64_t>(h2) << 16 | (b1 << 8 | b2);
      }
    }
    std::sort(fwd.begin(), fwd.end());
    for (unsigned b4 = 0; b4 < 256; ++b4) {
      const std::uint32_t h3 = (state * kFnvPrimeInv) ^ b4;
      for (unsigned b3 = 0; b3 < 256; ++b3) {
        const std::uint32_t h2 = (h3 * kFnvPrimeInv) ^ b3;
        const std::uint64_t key = static_cast<std::uint64_t>(h2) << 16;
        auto it = std::lower_bound(fwd.begin(), fwd.end(), key);
        if (it == fwd.end() || (*it >> 16) != h2) continue;
        const unsigned b12 = static_cast<unsigned>(*it & 0xffffu);
        std::string name = prefix;
        name += static_cast<char>(b12 >> 8);
        name += static_cast<char>(b12 & 0xff);
        name += static_cast<char>(b3);
        name += static_cast<char>(b4);
        return name;
      }
    }
  }
  return base;  // unreachable in practice (each tag finds a preimage with probability ~0.63)
}

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
  // registry.create(ctx, rng.fork(), ...): callableRng + InstrumentBase asRng fork the given stream once more, which
  // SynthInstrument does itself (rngFor(seed, name).fork()); so rngFor(0, name) must BE the forked stream
  Rng child = parent.fork();
  const std::string name = rngNameFor(child.seed());
  return std::make_unique<inst::SynthInstrument>(inst::patchDef(inst::PatchId::DroneOsc), sampleRate, 0u, name,
                                                 paramsJson, 0.0);
}

}  // namespace rig::drone
