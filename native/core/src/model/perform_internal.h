// Perform internals shared by perform.cpp and wheels.cpp (T14): the AudioParam proxy the time/automation.h helpers
// drive (each timeline call becomes one param Command through the Model's gate) and small JS helpers.
#pragma once
#include <cmath>
#include <limits>

#include "graph/unit.h"
#include "model/perform.h"
#include "runtime/command.h"

namespace rig {

/** A Model-side AudioParam: rampTo / linFrom / glideFrom on it send ParamSet / ParamLinear / ... Commands. */
class Perform::ParamOut {
 public:
  ParamOut(Perform &p, UnitSlot unit, std::uint32_t index) : p_(p), target_(paramTarget(unit, index)) {}
  bool setValueAtTime(double v, double t) { return op(Op::ParamSet, v, t, 0); }
  bool linearRampToValueAtTime(double v, double t) { return op(Op::ParamLinear, v, t, 0); }
  bool exponentialRampToValueAtTime(double v, double t) { return op(Op::ParamExp, v, t, 0); }
  bool setTargetAtTime(double v, double t, double tau) { return op(Op::ParamTarget, v, t, tau); }
  bool cancelAndHoldAtTime(double t) { return op(Op::ParamCancelHold, 0, t, 0); }
  bool cancelScheduledValues(double) { return false; }  // not used by the helpers perform calls
  /** param.value is never read: every helper perform uses gets an explicit `from` (CLAUDE.md). */
  double intrinsic() const { return std::numeric_limits<double>::quiet_NaN(); }

 private:
  bool op(Op o, double a, double b, double c) {
    Command cmd{};
    cmd.op = o;
    cmd.frame = kFrameNow;
    cmd.target = target_;
    cmd.f.a = a;
    cmd.f.b = b;
    cmd.f.c = c;
    return p_.send(cmd);
  }
  Perform &p_;
  std::uint32_t target_;
};

namespace perf {
inline double lerp(double a, double b, double x) {
  return a + (b - a) * x;
}
inline double clamp01(double x) {
  return std::isfinite(x) ? (x < 0 ? 0.0 : x > 1 ? 1.0 : x) : 0.0;
}
}  // namespace perf

}  // namespace rig
