// TestHooks: the golden TAP / INJECT name tables. FROZEN by T00b; must equal tools/golden/page.js `TAP` and `INJECT`
// key for key (tests/test_test_points.cpp parses page.js and fails on any difference).
//
// A point is either a graph bus (`local == kGraphBus`: the graph copies/adds the bus itself) or a unit-local point of
// the unit in `unit` (passed to Unit::process through UnitIO::tap / UnitIO::inject). rig_test_tap / rig_test_inject
// return RIG_E_UNSUPPORTED until the point is served: graph buses that need no unit are always served; the others need
// a unit of a non-builtin kind attached (or scheduled) in `unit` whose registry UnitInfo lists the local point.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>

#include "graph/unit.h"

namespace rig {

inline constexpr std::uint32_t kGraphBus = 0xffffffffu;

/** Unit-local point ids (UnitIO::tapPoint / injectPoint). MasterChain is the only unit with internal points. */
enum MasterChainPoint : std::uint32_t { kTapEqOut = 0, kTapMaster = 1, kInjectPreComp = 0 };

struct TestPoint {
  const char *name;
  UnitSlot unit;        // the unit that produces (tap) / consumes (inject) the point
  std::uint32_t local;  // kGraphBus or a unit-local id
  bool needsUnit;       // false: served by the graph alone (builtin strips count as "always there")
};

/** page.js TAP, same order. */
inline constexpr TestPoint kTapPoints[] = {
    {"out", UnitSlot::MasterChain, kGraphBus, false},
    {"fx.sum", UnitSlot::Lofi, kGraphBus, false},
    {"fx.reverb.output", UnitSlot::Reverb, kGraphBus, true},
    {"fx.delay.output", UnitSlot::Delay, kGraphBus, true},
    {"fx.chorus.output", UnitSlot::Chorus, kGraphBus, true},
    {"fx.lofi.output", UnitSlot::Lofi, kGraphBus, true},
    {"fx.eqOut", UnitSlot::MasterChain, kTapEqOut, true},
    {"fx.master", UnitSlot::MasterChain, kTapMaster, true},
    {"slot0.pan", UnitSlot::Strip0, kGraphBus, false},
    {"slot1.pan", stripSlot(1), kGraphBus, false},
};
/** page.js INJECT, same order. */
inline constexpr TestPoint kInjectPoints[] = {
    {"fx.sum", UnitSlot::Lofi, kGraphBus, false},
    {"fx.reverb.input", UnitSlot::Reverb, kGraphBus, true},
    {"fx.delay.input", UnitSlot::Delay, kGraphBus, true},
    {"fx.chorus.input", UnitSlot::Chorus, kGraphBus, true},
    {"fx.eqIn", UnitSlot::MasterChain, kGraphBus, false},
    {"fx.preComp", UnitSlot::MasterChain, kInjectPreComp, true},
    {"slot0.strip", UnitSlot::Strip0, kGraphBus, false},
};
inline constexpr std::size_t kTapCount = sizeof kTapPoints / sizeof kTapPoints[0];
inline constexpr std::size_t kInjectCount = sizeof kInjectPoints / sizeof kInjectPoints[0];

/** Index into kTapPoints / kInjectPoints, or -1. */
inline int tapIndex(std::string_view name) {
  for (std::size_t i = 0; i < kTapCount; ++i)
    if (name == kTapPoints[i].name) return static_cast<int>(i);
  return -1;
}
inline int injectIndex(std::string_view name) {
  for (std::size_t i = 0; i < kInjectCount; ++i)
    if (name == kInjectPoints[i].name) return static_cast<int>(i);
  return -1;
}

}  // namespace rig
