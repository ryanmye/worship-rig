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

UnitFactory synthExtraFactory() {
  return g_extra;
}

Unit *makeSynthExtra(const UnitEnv &env, const UnitSpec &spec) {
  return g_extra ? g_extra(env, spec) : nullptr;
}

}  // namespace rig::inst
