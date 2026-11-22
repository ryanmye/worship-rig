// rig_register_inst_synth_extra (T15): the synth-extra.js patches behind T11's "inst.synth" dispatch hook
// (inst/synth_dispatch.h): the synth.js factory hands every id it does not know to makeSynthExtraUnit.
#include "api/registry.h"
#include "inst/synth_dispatch.h"
#include "inst/synth_extra.h"

void rig_register_inst_synth_extra(rig::Registry &r) {
  (void)r;
  rig::inst::registerSynthExtra(&rig::inst::makeSynthExtraUnit);
}
