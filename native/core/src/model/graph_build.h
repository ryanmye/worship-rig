// T13 graph building: the units of a slot channel are built at PREPARE (control thread), held by the plan and
// attached at commit (audio.js prepare builds instrument + strip, commit only connects). Every slot instrument is
// wrapped in an InstShell, the Model's lock-free view of its live voice count (audio.js liveVoiceCount, polled by
// the retire timer every 0.25 s: contract 1.2). The shell forwards everything else, including asInstrument() for the
// engine-wide voice limit (D4), so the graph cannot tell it from the instrument.
#pragma once
#include <atomic>
#include <cstdint>
#include <string>
#include <string_view>

#include "graph/unit.h"

namespace rig {

class Model;
struct PatchSpec;
struct SongState;

/** A slot instrument as the graph sees it. Owns the instrument (deleted with the shell, on the control thread). */
class InstShell final : public Unit {
 public:
  explicit InstShell(Unit *inner) : inner_(inner) {}
  ~InstShell() override { delete inner_; }
  InstShell(const InstShell &) = delete;
  InstShell &operator=(const InstShell &) = delete;

  void process(const RenderContext &ctx, UnitIO &io) override {
    inner_->process(ctx, io);
    live_.store(inner_->liveVoices(), std::memory_order_release);
  }
  void apply(const Command &c) override { inner_->apply(c); }
  wa::Param *param(std::uint32_t index) override { return inner_->param(index); }
  void setSampleRate(double sr) override { inner_->setSampleRate(sr); }
  std::uint32_t liveVoices() const override { return inner_->liveVoices(); }
  Instrument *asInstrument() override { return inner_->asInstrument(); }

  /** Live voices after the last rendered quantum (any thread; the retire poll reads it on the control thread). */
  std::uint32_t publishedVoices() const { return live_.load(std::memory_order_acquire); }
  Unit *inner() const { return inner_; }

 private:
  Unit *inner_;
  std::atomic<std::uint32_t> live_{0};
};

/** The units of one fresh slot channel, built for `patch.slots[slot]` (not attached yet). */
struct BuiltChannel {
  InstShell *inst = nullptr;  // null: the instrument could not be built (the slot stays empty, JS plan null)
  Unit *strip = nullptr;
  std::string kind;           // "inst.<type>"
  std::uint32_t instSeq = 0;  // contract 7.15 (rng stream `inst|<slot>|<type>|<id>|<instSeq>`)
};

}  // namespace rig
