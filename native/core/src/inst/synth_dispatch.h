// The synth-extra dispatch hook of kind "inst.synth" (T11 owns it; T15 implements synth-extra.js). The Model attaches
// "inst." + instrument.type, and synth-extra.js patches share type "synth" with synth.js (instruments.js merges both
// PATCHES lists into one `synth` module), so the "inst.synth" factory (inst/synth.h makeSynth) builds the synth.js ids
// itself and hands every other id to the factory registered here. T15 registers from its own register file:
//     void rig_register_inst_synth_extra(rig::Registry &r) {
//       rig::inst::registerSynthExtra(&makeSynthExtraUnit);   // Unit *(const UnitEnv &, const UnitSpec &)
//     }
// (process start, before any engine exists, like every registry call). The factory reads the patch id from
// spec.patch->slots[spec.channel].instId and returns nullptr for an id it does not know. While nothing is registered
// the ten synth-extra ids render silence and the "instruments" service warns once per commit with code
// 'unsupported' (the golden runner lists them as skipped).
#pragma once
#include <cstddef>
#include <string_view>

#include "api/registry.h"

namespace rig::inst {

/** The synth-extra.js PATCHES ids (engine-api.json catalogue order). */
inline constexpr const char *kSynthExtraIds[] = {"supersaw-pad", "juno-pad",     "shimmer-pad", "dx-epiano",
                                                 "pluck",        "poly-stab",    "analog-brass", "square-lead",
                                                 "808-sub",      "synth-bass"};
inline constexpr std::size_t kSynthExtraCount = sizeof(kSynthExtraIds) / sizeof(kSynthExtraIds[0]);

bool isSynthExtraId(std::string_view id);
/** Register the synth-extra factory (T15). A later call replaces an earlier one. */
void registerSynthExtra(UnitFactory factory);
/** The registered factory, or nullptr. */
UnitFactory synthExtraFactory();
/** Build a synth-extra unit through the hook (nullptr when none is registered or the id is unknown to it). */
Unit *makeSynthExtra(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig::inst
