// Click (UnitSlot::Click). Interface FROZEN by T00b; T07 implements (click/) and registers kind "click" + the
// "click" ClickService (model/services.h: grid, 50 ms pump, 0.3 s lookahead, MIDI clock) + set handlers none.
//
// Contract 3.10: mono click bus (level, tau 10 ms) rendered from preallocated click sample tables (accent 1980 Hz,
// beat 1320 Hz, sub) played with dsp/buffer_source.h (T11a). The graph adds io.out to `out` channels 1-2 (output
// 'main', after the master chain) or writes it to device channels 3-4 ('aux'); the record flag makes the Recorder see
// it (the service sends the core Op::ClickRoute for that, which the graph handles). The service schedules clicks
// with ClickOp::Schedule at time-grid frames.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindClick = "click";

enum ClickParam : std::uint32_t { kClickLevel = 0 };

enum class ClickOp : std::uint16_t {
  Schedule = kOpBaseT07,  // aux = 0 accent / 1 beat / 2 sub, frame = start frame
  ClearAfter,             // drop scheduled clicks at frames > Command::frame (stop)
  // T07 appends below.
  // T07 usage (no new opcodes): both ops are sent with frame = kFrameNow so that they are applied in FIFO order
  // (a ClearAfter must see every click scheduled before it, as metronome.js stop() disconnects its live sources at
  // call time). Schedule: f.a = start time in engine seconds (sub-sample, AudioBufferSourceNode.start(t)).
  // ClearAfter: f.a = t; drops every click whose start >= t - 1e-6 (metronome.js stop()).
};

struct UnitEnv;
struct UnitSpec;
Unit *makeClick(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
