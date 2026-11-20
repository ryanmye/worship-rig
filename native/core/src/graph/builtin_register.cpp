// Builtin skeleton unit at kBuiltinPriority (a module registering the same kind replaces it). T00c removed the
// builtin "strip" and "master": T02's SlotChannel and T03's MasterChain are the only ones now.
#include "api/registry.h"
#include "graph/builtin_units.h"

void rig_register_graph_builtin(rig::Registry &r) {
  r.addUnit("inst.test", &rig::makeTestInstrument, {}, rig::kBuiltinPriority);
}
