// Scratch module proving the T00b freeze (SETUP_REVIEW 1 "Done"): a unit kind, a module opcode, a set handler and a
// service registered from this directory alone, without editing any shared file. Kept as a regression test.
#pragma once
#include <cstdint>

#include "api/registry.h"
#include "runtime/command.h"

namespace dummy {

inline constexpr const char *kKind = "test.dummy";
inline constexpr const char *kService = "test.dummy";

enum class DummyOp : std::uint16_t {
  SetDc = rig::kOpBaseTests,  // a = DC offset added to the output
};

/** Between builtins (0) and modules (10): a real "fx.chorus." handler replaces the dummy's. */
inline constexpr int kSetPriority = 5;

/** The dummy's set handler (the test checks whether it is the active one). */
bool onSet(rig::Model &m, const rig::SetRequest &req);

/** Counters the test reads back. */
struct Counters {
  int commits = 0, sets = 0, built = 0;
};
Counters &counters();

}  // namespace dummy
