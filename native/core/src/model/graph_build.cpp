// T13 graph building: units of fresh slot channels are built at prepare (audio.js prepare: registry.create + new
// Channel) and attached at commit. See model/graph_build.h and model/song.h.
#include "model/graph_build.h"

#include <string>

#include "api/registry.h"
#include "inst/sampler.h"
#include "mix/slot_channel.h"
#include "model/model.h"
#include "model/song.h"

namespace rig {

BuiltChannel SongGraph::build(const PatchSpec &patch, int slot) {
  BuiltChannel b;
  const SlotPatch &sp = patch.slots[slot];
  const std::string kind = "inst." + sp.instType;
  const Registry::UnitEntry *ie = Registry::global().unit(kind);
  const Registry::UnitEntry *se = Registry::global().unit(kKindStrip);
  m_.env_.sampleRate = m_.sink_.timeBase().sampleRate;
  UnitSpec spec;
  spec.channel = slot;
  spec.patch = &patch;
  spec.song = &m_.song_;
  if (ie) {
    spec.slot = instSlot(static_cast<std::size_t>(slot));
    spec.instSeq = ++m_.instSeq_;  // audio.js: ++this._instSeq per instrument created (contract 7.15)
    if (Unit *u = ie->factory(m_.env_, spec)) {
      b.inst = new InstShell(u);
      b.kind = kind;
      b.instSeq = spec.instSeq;
    }
  }
  if (!b.inst) {
    // audio.js prepare: registry.create threw -> the slot plays nothing (plan null). An unknown type is warned here;
    // a factory that declines an id (e.g. a synth-extra id without T15) is warned by its service at commit.
    if (!ie)
      m_.warn("instrument type '" + sp.instType + "' is not available in this build (slot stays silent)",
              "unsupported");
    return b;
  }
  if (se) {
    spec.slot = stripSlot(static_cast<std::size_t>(slot));
    spec.instSeq = 0;
    b.strip = se->factory(m_.env_, spec);
  }
  ++n_.built;
  return b;
}

void SongGraph::discard(Plan &plan) {
  for (PlanSlot &ps : plan.slots) {  // never attached: they die here, on the control thread
    delete ps.built.inst;
    delete ps.built.strip;
    ps.built = BuiltChannel{};
  }
  ++n_.discarded;
}

void SongGraph::instrumentSetup(UnitSlot slot, const std::string &kind, std::int64_t frame) {
  // INTERFACE-CHANGE(T00c) D1: the cap reaches the instrument before any note (same frame, FIFO)
  Command vc{};
  vc.op = Op::VoiceCap;
  vc.target = static_cast<std::uint32_t>(slot);
  vc.frame = frame;
  vc.aux = m_.polyphony_;
  m_.send(vc);
  if (kind == kKindSampler && dynRange_ != 1.0) {  // T12 O1: a new sampler starts at range 1
    Command dc{};
    dc.op = opOf(SamplerOp::DynamicRange);
    dc.target = static_cast<std::uint32_t>(slot);
    dc.frame = frame;
    dc.f.a = dynRange_;
    m_.send(dc);
  }
}

bool SongGraph::attachBuilt(UnitSlot slot, const std::string &kind, Unit *u, double when, int channel) {
  const Registry::UnitEntry *e = Registry::global().unit(kind);
  Command c{};
  c.op = Op::AttachUnit;
  c.target = static_cast<std::uint32_t>(slot);
  c.frame = m_.frameFor(when);
  c.p.ptr = u;
  (void)channel;
  if (!m_.send(c)) {
    delete u;
    return false;
  }
  if (kind.rfind("inst.", 0) == 0) instrumentSetup(slot, kind, c.frame);
  Model::Attached &a = m_.attached_[static_cast<std::size_t>(slot)];
  a.kind = kind;
  a.module = e && e->priority > kBuiltinPriority;
  for (auto it = m_.tracked_.begin(); it != m_.tracked_.end();)  // a new unit starts from its own defaults
    it = paramUnit(it->first) == slot ? m_.tracked_.erase(it) : std::next(it);
  ++m_.stats_.unitsAttached;
  return true;
}

}  // namespace rig
