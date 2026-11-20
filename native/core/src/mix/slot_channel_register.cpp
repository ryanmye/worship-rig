// Registration of the strip module (T02): unit kind "strip" (SlotChannel, replaces the builtin skeleton strip), the
// set handlers of the strip rows it owns and the "strip" service that coalesces them (audio.js _setSlotParam).
//   slots.<i>.eq.*      one coalescing key per slot (`slots.<i>.eq`); the flush sends the slot's whole EQ as it is
//                       then (round3-eq M1) to SlotEq.set (StripOp::SetEq, applied at call time)
//   slots.<i>.width     coalesced; Channel.setWidth(width x widthDefault) = StripOp::SetSlotWidth
//   slots.<i>.pan       coalesced; rampTo tau 15 ms (Model::moveParam)
//   slots.<i>.sends.*   coalesced per row; rampTo tau 15 ms
// slots.<i>.gain stays with the Model (trackedMove; T13). Coalescing (10 ms per key, fx.js Coalescer) lives here
// until the Model's set dispatch coalesces (T13); then these handlers apply directly.
#include <cstdio>
#include <string>

#include "api/registry.h"
#include "mix/slot_channel.h"
#include "mix/slot_channel_api.h"
#include "model/model.h"
#include "params/params.h"

namespace rig {
namespace {

std::string key(int slot, const char *rest) {
  char b[64];
  std::snprintf(b, sizeof b, "slots.%d.%s", slot, rest);
  return b;
}

bool hasStrip(const Model &m, int slot) {
  return slot >= 0 && slot <= 3 && !m.attachedKind(stripSlot(static_cast<std::size_t>(slot))).empty();
}

StripService *svc(Model &m) {
  return m.service<StripService>();
}

bool setEqRow(Model &m, const SetRequest &r) {
  if (r.slot < 0 || r.slot > 3 || !r.row) return false;
  const std::string_view rp(r.row->path);
  const std::string field(rp.substr(std::string_view("slots.<i>.eq.").size()));
  SlotEqSpec &eq = m.patchMut().slots[r.slot].spec.eq;
  if (!storeSlotEqRow(eq, field.c_str(), r.value)) return false;
  if (!m.committed() || !hasStrip(m, r.slot)) return true;  // stored; a fresh strip is built from the patch
  StripService *s = svc(m);
  const int slot = r.slot;
  sendSlotEqStored(m, slot, eq);  // audio.js: cfg.eq changes at once, the strip at the coalesced flush
  auto apply = [&m, slot](double tt) { sendSlotEq(m, slot, m.patch().slots[slot].spec.eq, tt); };
  const double when = r.when >= 0 ? r.when : m.now();
  if (s) s->coalescer().push(key(slot, "eq"), when, apply);
  else apply(when);
  return true;
}

bool setWidthRow(Model &m, const SetRequest &r) {
  if (!hasStrip(m, r.slot)) return true;
  const int slot = r.slot;
  auto apply = [&m, slot](double tt) { sendSlotWidth(m, slot, m.patch().slots[slot].width, tt); };
  const double when = r.when >= 0 ? r.when : m.now();
  if (StripService *s = svc(m)) s->coalescer().push(key(slot, "width"), when, apply);
  else apply(when);
  return true;
}

bool setPanRow(Model &m, const SetRequest &r) {
  if (!hasStrip(m, r.slot)) return true;
  const int slot = r.slot;
  const double v = r.value;
  auto apply = [&m, slot, v](double tt) {
    m.moveParam(stripSlot(static_cast<std::size_t>(slot)), kStripPan, v, tt, 0);
  };
  const double when = r.when >= 0 ? r.when : m.now();
  if (StripService *s = svc(m)) s->coalescer().push(key(slot, "pan"), when, apply);
  else apply(when);
  return true;
}

bool setSendRow(Model &m, const SetRequest &r) {
  if (!hasStrip(m, r.slot) || !r.row) return true;
  const std::string_view rp(r.row->path);
  const std::uint32_t idx = rp.ends_with(".reverb") ? kStripSendReverb : rp.ends_with(".delay") ? kStripSendDelay
                                                                                               : kStripSendChorus;
  const int slot = r.slot;
  const double v = r.value;
  auto apply = [&m, slot, idx, v](double tt) { m.moveParam(stripSlot(static_cast<std::size_t>(slot)), idx, v, tt, 0); };
  const char *k = idx == kStripSendReverb ? "sends.reverb" : idx == kStripSendDelay ? "sends.delay" : "sends.chorus";
  const double when = r.when >= 0 ? r.when : m.now();
  if (StripService *s = svc(m)) s->coalescer().push(key(slot, k), when, apply);
  else apply(when);
  return true;
}

Service *makeStripService(Model &m) {
  return new StripService(m);
}

}  // namespace

StripService::StripService(Model &m)
    : m_(m), co_([&m](double at, std::function<void(double)> fn) { m.sink().at(at, std::move(fn)); }) {}

void StripService::onCommit(const PatchSpec &, double) {
  // audio.js commit: pending song-level writes never reach the next song's channels (round3-eq M1); a commit also
  // ends every EQ audition (fresh strips start un-auditioned)
  co_.cancelAll([](std::string_view k) { return k.rfind("slots.", 0) == 0; });
  (void)m_;
}

bool sendSlotEq(Model &m, int slot, const SlotEqSpec &spec, double when, bool step) {
  if (!hasStrip(m, slot)) return false;
  auto *p = new SlotEqChange();
  p->spec = spec;
  p->when = when;
  p->step = step;
  return m.sendOwned(stripSlot(static_cast<std::size_t>(slot)), opOf(StripOp::SetEq), p, -1.0, kEqChangeSet);
}

bool sendSlotEqStored(Model &m, int slot, const SlotEqSpec &spec) {
  if (!hasStrip(m, slot)) return false;
  auto *p = new SlotEqChange();
  p->spec = spec;
  return m.sendOwned(stripSlot(static_cast<std::size_t>(slot)), opOf(StripOp::SetEq), p, -1.0, kEqChangeStore);
}

bool sendSlotWidth(Model &m, int slot, double width, double when) {
  if (!hasStrip(m, slot)) return false;
  Command c{};
  c.op = opOf(StripOp::SetSlotWidth);
  c.f.a = width;
  c.f.b = when;
  return m.sendUnitOp(stripSlot(static_cast<std::size_t>(slot)), c, -1.0);
}

bool sendWidthDefault(Model &m, int slot, double widthDefault, double when) {
  if (!hasStrip(m, slot)) return false;
  Command c{};
  c.op = opOf(StripOp::SetWidthDefault);
  c.f.a = widthDefault;
  return m.sendUnitOp(stripSlot(static_cast<std::size_t>(slot)), c, when);
}

}  // namespace rig

void rig_register_mix_slot_channel(rig::Registry &r) {
  r.addUnit(rig::kKindStrip, &rig::makeSlotChannel);
  r.addSetHandler("slots.<i>.eq.", &rig::setEqRow);
  r.addSetHandler("slots.<i>.width", &rig::setWidthRow);
  r.addSetHandler("slots.<i>.pan", &rig::setPanRow);
  r.addSetHandler("slots.<i>.sends.", &rig::setSendRow);
  r.addService(rig::StripService::kName, &rig::makeStripService);
}
