// rig_register_inst_synth (T11): unit kind "inst.synth" (inst/synth.h; synth-extra ids through the dispatch hook in
// inst/synth_dispatch.h), the "instruments" service (inst/instrument_service.h: `get instruments`, rate-change
// wavetables, 'unsupported' warnings) and the set handler of the instrument params `slots.<i>.params.<key>`.
#include "api/registry.h"
#include "inst/instrument_service.h"
#include "inst/synth.h"
#include "model/model.h"

namespace {

rig::Service *makeInstrumentService(rig::Model &m) {
  return new rig::inst::InstrumentServiceImpl(m);
}

}  // namespace

void rig_register_inst_synth(rig::Registry &r) {
  r.addUnit(rig::inst::kKindSynth, &rig::inst::makeSynth);
  r.addService(rig::InstrumentService::kName, &makeInstrumentService);
  r.addSetHandler("slots.<i>.params.", &rig::inst::setInstrumentParam);
}
