// Builtin skeleton units at kBuiltinPriority (any module registering the same kind replaces them).
#include "api/registry.h"
#include "graph/builtin_units.h"
#include "mix/master_chain.h"
#include "mix/slot_channel.h"

void rig_register_graph_builtin(rig::Registry &r) {
  r.addUnit(rig::kKindStrip, &rig::makeBuiltinStrip, {}, rig::kBuiltinPriority);
  r.addUnit("inst.test", &rig::makeTestInstrument, {}, rig::kBuiltinPriority);
  r.addUnit(rig::kKindMaster, &rig::makeBuiltinMaster, {}, rig::kBuiltinPriority);
}
