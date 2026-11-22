// rig_register_inst_organ (T15): unit kind "inst.organ" (inst/organ.h). Params reach it through T11's generic
// `slots.<i>.params.` set handler (catalogue index -> Op::InstParam).
#include "api/registry.h"
#include "inst/organ.h"

void rig_register_inst_organ(rig::Registry &r) {
  r.addUnit(rig::inst::kKindOrgan, &rig::inst::makeOrgan);
}
