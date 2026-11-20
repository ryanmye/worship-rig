// Registration of the master chain (T03): unit kind "master" (replaces the builtin volume-only master), set handlers
// for the PARAMS rows fx.eq.*, fx.comp.amount and master.volume, and the "master" service that re-applies the FX
// master rows at every commit (audio.js commit -> _applyFx: setEq / setGlue / rampTo(master.gain)) and forwards the
// song-level mono switch (config {mono} -> Model::setMono -> onSongState -> MasterOp::SetMono).
#include <string_view>

#include "api/registry.h"
#include "graph/test_points.h"
#include "mix/master_chain.h"
#include "model/model.h"
#include "model/patch.h"
#include "model/services.h"

namespace rig {
namespace {

constexpr UnitSlot kSlot = UnitSlot::MasterChain;

bool masterAttached(const Model &m) {
  return !m.attachedKind(kSlot).empty() && m.attachedIsModule(kSlot);
}

void sendGlue(Model &m, double amount, double when) {
  Command c{};
  c.op = opOf(MasterOp::SetGlue);
  c.f.a = amount;
  c.f.b = m.timeFor(when);
  c.f.c = m.now();
  m.sendUnitOp(kSlot, c, -1.0);  // connected at the next quantum, as fx.js connects at call time
}

/** fx.eq.{low,mid,high}: FxGraph.setEq -> rampTo(gain, dB, when, TAU). */
bool setEq(Model &m, const SetRequest &r) {
  if (!masterAttached(m)) return true;  // stored in the patch; the unit is built from it
  const std::string_view k = r.path.substr(r.path.rfind('.') + 1);
  const std::uint32_t band = k == "low" ? 0u : k == "mid" ? 1u : k == "high" ? 2u : 3u;
  if (band > 2) return false;
  m.moveParam(kSlot, kMasterEqLow + band, r.value, r.when, 0.0);
  return true;
}

/** fx.comp.amount: FxGraph.setGlue(amount, when). */
bool setComp(Model &m, const SetRequest &r) {
  if (r.path != "fx.comp.amount") return false;
  if (!masterAttached(m)) return true;
  sendGlue(m, r.value, r.when);
  return true;
}

/** master.volume: rampTo(fx.master.gain, v, when) (audio.js setParam; glide is ignored there). */
bool setMaster(Model &m, const SetRequest &r) {
  if (r.path != "master.volume") return false;
  if (!masterAttached(m)) return true;
  m.moveParam(kSlot, kMasterVolume, r.value, r.when, 0.0);
  return true;
}

class MasterService final : public Service {
 public:
  static constexpr const char *kName = "master";
  explicit MasterService(Model &m) : m_(m) {}

  void onCommit(const PatchSpec &p, double when) override {
    if (!masterAttached(m_)) return;
    // _applyFx(p.fx, t, ..., init = false): setEq(fx.eq, t) (rampTo each band), setGlue, rampTo(master.gain)
    m_.moveParam(kSlot, kMasterEqLow, p.master.eqLow, when, 0.0);
    m_.moveParam(kSlot, kMasterEqMid, p.master.eqMid, when, 0.0);
    m_.moveParam(kSlot, kMasterEqHigh, p.master.eqHigh, when, 0.0);
    sendGlue(m_, p.master.compAmount, when);
    m_.moveParam(kSlot, kMasterVolume, p.master.volume, when, 0.0);
  }

  void onSongState(const SongState &s) override {
    if (s.mono == mono_) return;
    mono_ = s.mono;
    if (!masterAttached(m_)) return;  // a unit built later reads SongState::mono
    Command c{};
    c.op = opOf(MasterOp::SetMono);
    c.f.a = s.mono ? 1.0 : 0.0;
    c.f.b = m_.now();  // AudioEngine.setMono uses ctx.currentTime
    c.f.c = c.f.b;
    m_.sendUnitOp(kSlot, c, -1.0);
  }

 private:
  Model &m_;
  bool mono_ = false;
};

Service *makeMasterService(Model &m) {
  return new MasterService(m);
}

}  // namespace
}  // namespace rig

void rig_register_mix_master_chain(rig::Registry &r) {
  rig::UnitInfo info;
  info.tapPoints = (1u << rig::kTapEqOut) | (1u << rig::kTapMaster);
  info.injectPoints = 1u << rig::kInjectPreComp;
  r.addUnit(rig::kKindMaster, &rig::makeMasterChain, info);
  r.addSetHandler("fx.eq.", &rig::setEq);
  r.addSetHandler("fx.comp.", &rig::setComp);
  r.addSetHandler("master.", &rig::setMaster);
  r.addService(rig::MasterService::kName, &rig::makeMasterService);
}
