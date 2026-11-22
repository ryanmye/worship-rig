// T14 test probe: instrument kind "inst.t14probe" (patch type "t14probe") that records every Instrument virtual the
// graph decodes (tests/test_perform_probe_register.cpp), into a fixed log (no allocation on the audio thread).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace t14 {

struct Call {
  char op;  // 'N' noteOn, 'F' noteOff, 'A' allNotesOff, 'K' kill, 'B' setBend, 'L' legatoTo, 'D' fadeNote, 'P' param
  int channel;        // UnitSpec::channel the probe was built for (its origin slot)
  int note, note2;    // note (legato: from, to)
  std::int64_t frame;
  double a;           // velGain / semis / fade seconds / param value
  int vel;
};

/** Calls recorded since the last clear(), in apply order. */
std::vector<Call> calls();
void clear();
/** Calls of one op (and channel, -1 = any). */
std::vector<Call> callsOf(char op, int channel = -1);

}  // namespace t14
