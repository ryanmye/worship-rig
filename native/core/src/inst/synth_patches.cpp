// synth.js PATCHES + gain-trims.json (see synth_patches.h).
#include "inst/synth_patches.h"

namespace rig::inst {
namespace {

constexpr ParamDef attack(double d) { return {"attack", "Attack", 0.002, 8, d, "s", "log"}; }
constexpr ParamDef decay(double d) { return {"decay", "Decay", 0.02, 6, d, "s", "log"}; }
constexpr ParamDef sustain(double d) { return {"sustain", "Sustain", 0, 1, d, "lin", "lin"}; }
constexpr ParamDef release(double d, double max = 12) { return {"release", "Release", 0.03, max, d, "s", "log"}; }
constexpr ParamDef cutoff(double d, double min = 200, double max = 14000) {
  return {"cutoff", "Cutoff", min, max, d, "Hz", "log"};
}
constexpr ParamDef glide() { return {"glide", "Legato glide", 0, 0.5, 0.03, "s", "lin"}; }

constexpr ParamDef kWarm[] = {
    attack(1.2), decay(0.5), sustain(0.8), release(3), cutoff(1800),
    {"resonance", "Resonance", 0, 1, 0, "lin", "lin"},
    {"lfoRate", "LFO rate", 0.01, 2, 0.08, "Hz", "log"},
    {"lfoDepth", "LFO depth (cents)", 0, 1200, 300, "lin", "lin"},
    {"detune", "Detune (cents)", 0, 40, 17, "lin", "lin"},
    {"sub", "Sub level", 0, 1, 0.5, "lin", "lin"},
};
constexpr ParamDef kGlass[] = {
    attack(0.8), decay(1.5), sustain(0.85), release(3.5), cutoff(6000),
    {"detune", "Detune (cents)", 0, 25, 6, "lin", "lin"},
    {"chorus", "Chorus", 0, 1, 0.6, "lin", "lin"},
    {"bloom", "Octave bloom", 0, 1, 0, "lin", "lin"},
};
constexpr ParamDef kStrings[] = {
    attack(0.4), release(1.8), cutoff(4000, 500),
    {"detune", "Detune (cents)", 0, 30, 12, "lin", "lin"},
    {"vibRate", "Vibrato rate", 2, 8, 5, "Hz", "lin"},
    {"vibDepth", "Vibrato depth (cents)", 0, 30, 8, "lin", "lin"},
    {"vibDelay", "Vibrato delay", 0, 2, 0.5, "s", "lin"},
};
constexpr ParamDef kSubBass[] = {
    attack(0.005), release(0.25, 4), cutoff(250, 60, 1000),
    {"drive", "Drive", 0, 1, 0.3, "lin", "lin"},
    {"tri", "Triangle", 0, 1, 0.35, "lin", "lin"},
    glide(),
};
constexpr ParamDef kSoftKeys[] = {
    {"decay", "Decay", 0.3, 3, 1, "lin", "log"},
    release(0.3, 3),
    {"tone", "Tone", 0, 2, 1, "lin", "lin"},
    {"tine", "Tine", 0, 2, 1, "lin", "lin"},
    {"tremolo", "Tremolo", 0, 1, 0.25, "lin", "lin"},
    {"tremRate", "Tremolo rate", 1, 10, 4.5, "Hz", "lin"},
    {"drive", "Drive", 0, 1, 0.3, "lin", "lin"},
    glide(),
};
constexpr ParamDef kBell[] = {
    attack(0.002),
    {"decay", "Decay", 0.5, 12, 4, "s", "log"},
    release(2.5, 8),
    {"ratio", "FM ratio", 1, 8, 3.5, "lin", "lin"},
    {"index", "FM index", 0, 6, 2, "lin", "lin"},
    {"indexDecay", "Index decay", 0.1, 6, 1.2, "s", "log"},
    glide(),
};
constexpr ParamDef kDrone[] = {
    attack(2.5), release(4, 20), cutoff(1400),
    {"detune", "Detune (cents)", 0, 30, 10, "lin", "lin"},
    {"drift", "Drift (cents)", 0, 10, 3, "lin", "lin"},
    {"unisonDrift", "Unison drift (cents)", 0, 15, 4, "lin", "lin"},
    {"sub", "Sub level", 0, 1, 0.3, "lin", "lin"},
    {"lfoRate", "LFO rate", 0.01, 2, 0.05, "Hz", "log"},
    {"lfoDepth", "LFO depth (cents)", 0, 1200, 200, "lin", "lin"},
};

template <std::size_t N>
constexpr std::size_t count(const ParamDef (&)[N]) {
  return N;
}

const PatchDef kPatches[kPatchCount] = {
    {PatchId::WarmPad, "Warm Pad", "warm-pad", "Synth Pads", false, kWarm, count(kWarm), 3.5, 0.55},
    {PatchId::GlassPad, "Glass Pad", "glass-pad", "Synth Pads", false, kGlass, count(kGlass), 3.3, 0.4},
    {PatchId::Strings, "Strings", "strings", "Synth Pads", false, kStrings, count(kStrings), 3.4, 0.46},
    {PatchId::SubBass, "Sub Bass", "sub-bass", "Bass", false, kSubBass, count(kSubBass), 5.8, 0.28},
    {PatchId::SoftKeys, "Soft Keys", "soft-keys", "Synth Keys", false, kSoftKeys, count(kSoftKeys), 1.3, 0.6},
    {PatchId::Bell, "Bell", "bell", "Synth Keys", false, kBell, count(kBell), 2.8, 0.5},
    {PatchId::DroneOsc, "Drone Oscillator", "drone-osc", "Synth Pads", true, kDrone, count(kDrone), 2.8, 0.45},
};

}  // namespace

const PatchDef &patchDef(PatchId id) {
  return kPatches[static_cast<std::size_t>(id)];
}

const PatchDef *findPatch(std::string_view id) {
  for (const PatchDef &p : kPatches)
    if (id == p.idStr) return &p;
  return nullptr;
}

int paramIndex(const PatchDef &p, std::string_view key) {
  for (std::size_t i = 0; i < p.nParams; ++i)
    if (key == p.params[i].key) return static_cast<int>(i);
  return -1;
}

}  // namespace rig::inst
