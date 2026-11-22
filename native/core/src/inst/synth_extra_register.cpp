// rig_register_inst_synth_extra (T15): the synth-extra.js patches behind T11's "inst.synth" dispatch hook
// (inst/synth_dispatch.h: the synth.js factory hands every id it does not know to makeSynthExtraUnit), and the
// "t15-tables" service: after a device rate change (T11a O4) every live synth-extra / organ unit gets the new rate's
// wavetables (T15Op::SetTables; the oscillators keep their phase). Retiring channels keep the old tables until they
// end (as T11 O3 for synth.js).
#include <algorithm>
#include <string>

#include "api/registry.h"
#include "inst/organ.h"
#include "inst/synth.h"
#include "inst/synth_dispatch.h"
#include "inst/synth_extra.h"
#include "model/model.h"
#include "model/patch.h"

namespace {

class TablesService final : public rig::Service {
 public:
  explicit TablesService(rig::Model &m) : m_(m) {}
  void onRateChanged(double sampleRate) override {
    using namespace rig::inst;
    const rig::PatchSpec &p = m_.patch();
    const std::size_t slots = std::min<std::size_t>(rig::kChannels, sizeof(p.slots) / sizeof(p.slots[0]));
    for (std::size_t i = 0; i < slots; ++i) {
      const rig::UnitSlot u = rig::instSlot(i);
      const std::string &kind = m_.attachedKind(u);
      const rig::SlotPatch &sp = p.slots[i];
      if (kind == kKindSynth && findXPatch(sp.instId)) {
        const XPatch id = findXPatch(sp.instId)->id;
        auto *w = new XTablesPayload();
        w->bank = WaveBank::get(sampleRate, kWaveSaw | kWaveBasic);
        w->xbank = XWaveBank::get(sampleRate, id != XPatch::ShimmerPad, id == XPatch::ShimmerPad,
                                  id == XPatch::DxEpiano);
        m_.sendOwned(u, rig::opOf(T15Op::SetTables), w, -1.0);
      } else if (kind == kKindOrgan) {
        const OrganPresetDef *pd = findOrganPreset(sp.instId);
        if (!pd) pd = &organPresetDef(OrganPreset::Gospel);
        double params[16] = {};
        organParams(*pd, sp.paramsJson, params);
        auto *w = new XTablesPayload();
        w->bank = WaveBank::get(sampleRate, kWaveSine | kWaveBasic);
        w->xbank = XWaveBank::get(sampleRate, false, false);
        drawbarWaves(params, sampleRate, w->drawbars);
        m_.sendOwned(u, rig::opOf(T15Op::SetTables), w, -1.0);
      }
    }
  }

 private:
  rig::Model &m_;
};

rig::Service *makeTablesService(rig::Model &m) {
  return new TablesService(m);
}

}  // namespace

void rig_register_inst_synth_extra(rig::Registry &r) {
  rig::inst::registerSynthExtra(&rig::inst::makeSynthExtraUnit);
  r.addService("t15-tables", &makeTablesService);
}
