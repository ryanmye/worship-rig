// The "t15-tables" service (inst/synth_extra_tables.h). Control thread.
#include "inst/synth_extra_tables.h"

#include <algorithm>
#include <string>

#include "inst/organ.h"
#include "inst/synth_extra.h"
#include "model/model.h"

namespace rig::inst {

namespace {
constexpr double kDrawbarDebounce = 0.03;  // organ.js _scheduleWave: timer.stop(t + 0.03)
}  // namespace

void T15TablesService::onRateChanged(double sampleRate) {
  const PatchSpec &p = m_.patch();
  const std::size_t slots = std::min<std::size_t>(kChannels, sizeof(p.slots) / sizeof(p.slots[0]));
  for (std::size_t i = 0; i < slots; ++i) {
    const UnitSlot u = instSlot(i);
    const std::string &kind = m_.attachedKind(u);
    const SlotPatch &sp = p.slots[i];
    if (kind == kKindSynth && findXPatch(sp.instId)) {
      const XPatch id = findXPatch(sp.instId)->id;
      auto *w = new XTablesPayload();
      w->bank = WaveBank::get(sampleRate, kWaveSaw | kWaveBasic);
      w->xbank = XWaveBank::get(sampleRate, id != XPatch::ShimmerPad, id == XPatch::ShimmerPad,
                                id == XPatch::DxEpiano);
      w->sampleRate = sampleRate;  // T15 review item 4: the chorus DelayNodes follow
      m_.sendOwned(u, opOf(T15Op::SetTables), w, -1.0);
    } else if (kind == kKindOrgan) {
      const OrganPresetDef *pd = findOrganPreset(sp.instId);
      if (!pd) pd = &organPresetDef(OrganPreset::Gospel);
      double params[16] = {};
      organParams(*pd, sp.paramsJson, params);
      auto *w = new XTablesPayload();
      w->bank = WaveBank::get(sampleRate, kWaveSine | kWaveBasic);
      w->xbank = XWaveBank::get(sampleRate, false, false);
      drawbarWaves(params, sampleRate, w->drawbars);
      w->sampleRate = sampleRate;  // T15 review item 4: the horn DelayNodes follow
      m_.sendOwned(u, opOf(T15Op::SetTables), w, -1.0);
    }
  }
}

void T15TablesService::drawbarsChanged(int slot, double when) {
  if (slot < 0 || slot >= kMaxSlots || pending_[slot]) return;  // organ.js: `if (this._waveTimer) return`
  pending_[slot] = true;
  std::weak_ptr<bool> alive = alive_;
  m_.sink().at(m_.timeFor(when) + kDrawbarDebounce, [this, alive, slot](double) {
    const std::shared_ptr<bool> a = alive.lock();
    if (!a || !*a) return;
    pending_[slot] = false;
    rebuildDrawbars(slot);
  });
}

void T15TablesService::rebuildDrawbars(int slot) {
  // organ.js onended: this.waves = drawbarWaves(ctx, this._bars()) from the params as they are now
  const UnitSlot u = instSlot(static_cast<std::size_t>(slot));
  const SlotPatch &sp = m_.patch().slots[slot];
  if (m_.attachedKind(u) != kKindOrgan || !sp.present || sp.instType != "organ") return;
  const OrganPresetDef *pd = findOrganPreset(sp.instId);
  if (!pd) pd = &organPresetDef(OrganPreset::Gospel);
  double params[16] = {};
  organParams(*pd, sp.paramsJson, params);
  const double sr = m_.sink().timeBase().sampleRate;
  auto *w = new XTablesPayload();  // drawbars only: the unit keeps its bank_ / xbank_
  drawbarWaves(params, sr, w->drawbars);
  w->sampleRate = sr;
  m_.sendOwned(u, opOf(T15Op::SetTables), w, -1.0);
  ++rebuilds_;
}

void organDrawbarsChanged(Model &m, int slot, double when) {
  if (auto *s = dynamic_cast<T15TablesService *>(m.service(T15TablesService::kName))) s->drawbarsChanged(slot, when);
}

}  // namespace rig::inst
