// rig_register_inst_synth_extra (T15): the synth-extra.js patches behind T11's "inst.synth" dispatch hook
// (inst/synth_dispatch.h: the synth.js factory hands every id it does not know to makeSynthExtraUnit), and the
// "t15-tables" service (inst/synth_extra_tables.h: rate-change wavetables, organ drawbar rebuilds).
#include "api/registry.h"
#include "inst/synth_dispatch.h"
#include "inst/synth_extra.h"
#include "inst/synth_extra_tables.h"
#include "model/model.h"

namespace {

rig::Service *makeTablesService(rig::Model &m) {
  return new rig::inst::T15TablesService(m);
}

}  // namespace

void rig_register_inst_synth_extra(rig::Registry &r) {
  rig::inst::registerSynthExtra(&rig::inst::makeSynthExtraUnit);
  r.addService(rig::inst::T15TablesService::kName, &makeTablesService);
}
