// synth-extra dispatch hook (inst/synth_dispatch.h).
#include "inst/synth_dispatch.h"

namespace rig::inst {
namespace {
UnitFactory g_extra = nullptr;  // written only from rig_register_* (process start), read by factories afterwards
}

bool isSynthExtraId(std::string_view id) {
  for (const char *x : kSynthExtraIds)
    if (id == x) return true;
  return false;
}

void registerSynthExtra(UnitFactory factory) {
  g_extra = factory;
}

// MACFIX: every read of the hook first runs the module registration (once per process; a no-op atomic check after
// that). Before, the hook was only filled by the first rig_create, so a reader that ran before any engine existed
// (a test calling makeSynth / synthExtraFactory directly, or saving the hook to override it) saw nullptr, and an
// override made then was replaced by the registration of the next rig_create. That is what failed Mac check #3
// (unit.synth, unit.synth-extra): without native/golden/out the earlier golden test cases skip and create no engine.
// Never call these from a rig_register_* function (std::call_once is not reentrant); none does.
UnitFactory synthExtraFactory() {
  ensureModulesRegistered();
  return g_extra;
}

Unit *makeSynthExtra(const UnitEnv &env, const UnitSpec &spec) {
  const UnitFactory f = synthExtraFactory();
  return f ? f(env, spec) : nullptr;
}

}  // namespace rig::inst
