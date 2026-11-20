// rig_register_fx_reverb: kind "reverb" (fx/reverb.h), the "reverb" service (fx/reverb_service.h) and the set
// handler for the PARAMS rows fx.reverb.{size,damp,predelay,returnGain} (contract 2.3; audio.js setParam 'reverb').
#include "api/registry.h"
#include "fx/reverb.h"
#include "fx/reverb_service.h"
#include "model/model.h"
#include "params/params.h"

namespace {

rig::Service *makePool(rig::Model &m) {
  return new rig::fx::ReverbPool(m);
}

bool onSet(rig::Model &m, const rig::SetRequest &req) {
  if (!req.row) return false;
  const std::string_view path(req.row->path);
  // stored in the patch already (Model::set); applied by the unit when it is built (JS: "applied by start()")
  if (m.attachedKind(rig::UnitSlot::Reverb) != rig::kKindReverb) return true;
  auto *pool = dynamic_cast<rig::fx::ReverbPool *>(m.service(rig::ReverbService::kName));
  if (path == "fx.reverb.returnGain") {
    // T13 coalesces song writes for 10 ms (Coalescer); the move itself is rampTo(ret.gain, v) (tau 15 ms)
    m.moveParam(rig::UnitSlot::Reverb, rig::kReverbReturnGain, req.value, req.when, req.glide);
    return true;
  }
  if (!pool) return false;
  const rig::ReverbPatch &rp = m.patch().reverb;
  if (path == "fx.reverb.size" || path == "fx.reverb.damp") {
    pool->request(rp.size, rp.damp, m.timeFor(req.when));  // T14: lerp(size, .9, wash) when a wheel drives wash
    return true;
  }
  if (path == "fx.reverb.predelay") {
    pool->setPredelay(req.value, req.when);
    return true;
  }
  return false;
}

}  // namespace

void rig_register_fx_reverb(rig::Registry &r) {
  r.addUnit(rig::kKindReverb, &rig::makeReverb);
  r.addService(rig::ReverbService::kName, &makePool);
  r.addSetHandler("fx.reverb.", &onSet);
}
