// synth.js PATCHES (app/js/engine/synth.js:23-98) and their gain trims (app/js/engine/gain-trims.json `synth`), as
// tables. Param *indices* are the position in the patch's list (Instrument::setParam index = Op::InstParam aux);
// keys, ranges and defaults equal the engine-api.json catalogue (tests/test_synth_catalogue.cpp checks every field).
#pragma once
#include <cstddef>
#include <string_view>

namespace rig::inst {

struct ParamDef {
  const char *key, *label;
  double min, max, def;
  const char *unit, *curve;
};

enum class PatchId : unsigned { WarmPad, GlassPad, Strings, SubBass, SoftKeys, Bell, DroneOsc, Count };

struct PatchDef {
  PatchId id;
  const char *name, *idStr, *group;
  bool hidden;
  const ParamDef *params;
  std::size_t nParams;
  double trimDb;     // gain-trims.json (registry `_trim`: a GainNode of 10^(dB/20) after the instrument output)
  double implTrim;   // synth.js IMPL[id].trim (the instrument's own output gain)
};

inline constexpr std::size_t kPatchCount = static_cast<std::size_t>(PatchId::Count);
const PatchDef &patchDef(PatchId id);
/** synth.js patch by id string; nullptr for anything else (synth-extra ids, unknown). */
const PatchDef *findPatch(std::string_view id);
/** Index of `key` in the patch's param list, -1 if absent. */
int paramIndex(const PatchDef &p, std::string_view key);

}  // namespace rig::inst
