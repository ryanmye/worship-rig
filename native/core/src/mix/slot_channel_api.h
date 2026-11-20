// T02 helpers around the frozen SlotChannel interface (mix/slot_channel.h): the StripOp payloads and the control-side
// "strip" service (10 ms coalescing of the strip rows, fx.js Coalescer; contract 2.3 "co").
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "mix/slot_eq.h"
#include "model/services.h"
#include "time/coalescer.h"

namespace rig {

class Model;

/** StripOp::SetEq aux values (the payload type travelling in Command::p.ptr). */
enum SlotEqChangeKind : std::uint32_t {
  kEqChangeSet = 1,  // SlotEqChange: SlotEq.set(spec, when, step) (fx.js Channel.setEq)
};

/** Payload of StripOp::SetEq with aux = kEqChangeSet. Sent with frame kFrameNow (applied at call time, as the JS). */
struct SlotEqChange : Owned {
  SlotEqSpec spec;   // resolved + stored rows
  double when = 0;   // automation time (s)
  bool step = false;  // fresh channel: set instantly
};

/** Send SetEq(spec, when, step) to the strip of channel `slot` (0..3) now. False when no strip is attached. */
bool sendSlotEq(Model &m, int slot, const SlotEqSpec &spec, double when, bool step = false);
/** Send SetSlotWidth(width, when) to the strip of channel `slot` now. */
bool sendSlotWidth(Model &m, int slot, double width, double when);
/** Send SetWidthDefault(d) (instrument widthDefault; steps the effective width) to the strip of `slot` at `when`. */
bool sendWidthDefault(Model &m, int slot, double widthDefault, double when);

/** Per-engine control state of the strip rows (registered as service "strip"). */
class StripService : public Service {
 public:
  static constexpr const char *kName = "strip";
  explicit StripService(Model &m);
  void onCommit(const PatchSpec &, double when) override;
  Coalescer &coalescer() { return co_; }

 private:
  Model &m_;
  Coalescer co_;
};

}  // namespace rig
