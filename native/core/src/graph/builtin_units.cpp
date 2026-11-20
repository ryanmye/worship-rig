#include "graph/builtin_units.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "api/registry.h"
#include "mix/master_chain.h"
#include "mix/slot_channel.h"
#include "model/patch.h"

namespace rig {

// ---- test instrument ----------------------------------------------------------------------------------------------

TestInstrument::TestInstrument(const SlotSpec &spec, double sr) : spec_(spec), sr_(sr) {}

std::uint32_t TestInstrument::liveVoices() const {
  std::uint32_t n = 0;
  for (const auto &v : voices_) n += v.active() ? 1 : 0;
  return n;
}

void TestInstrument::noteOn(int note, int vel, float, std::int64_t frame) {
  if (spec_.inst == InstKind::None || note < spec_.lowNote || note > spec_.highNote) return;
  std::size_t live = 0, freeV = kVoices, oldRel = kVoices, oldHeld = kVoices;
  for (std::size_t i = 0; i < kVoices; ++i) {
    const TestVoice &c = voices_[i];
    if (!c.active()) {
      if (freeV == kVoices) freeV = i;
      continue;
    }
    ++live;
    std::size_t &best = c.released() ? oldRel : oldHeld;
    if (best == kVoices || order_[i] < order_[best]) best = i;
  }
  std::size_t pick = freeV;
  if (live >= cap_ || freeV == kVoices) {  // at the cap (D1): oldest released, then oldest held
    pick = oldRel != kVoices ? oldRel : oldHeld;
    ++stolen_;
  }
  if (pick == kVoices) return;
  order_[pick] = nextOrder_++;
  voices_[pick].start(spec_, note, vel, frame, sr_);
}

void TestInstrument::noteOff(int note, std::int64_t frame, bool) {
  for (auto &v : voices_)
    if (v.active() && !v.released() && v.note() == note) v.release(spec_, frame, sr_);
}

void TestInstrument::allNotesOff(std::int64_t frame) {
  for (auto &v : voices_)
    if (v.active() && !v.released()) v.release(spec_, frame, sr_);
}

void TestInstrument::kill() {
  for (auto &v : voices_) v.kill();
}

void TestInstrument::process(const RenderContext &ctx, UnitIO &io) {
  Bus &out = *io.out;
  out.clear(1);
  for (std::uint32_t vi = 0; vi < kVoices; ++vi) {
    TestVoice &v = voices_[vi];
    if (!v.active()) continue;
    if (!v.render(out.ch[0], ctx.frame0, kQ, ctx.sampleRate)) {
      AudioEvent e{};
      e.frame = ctx.frame0;
      e.kind = EventKind::VoiceEnded;
      e.f.a = static_cast<double>(ctx.self);
      e.f.b = static_cast<double>(vi);
      ctx.events->push(e);
    }
  }
}

// ---- factories ----------------------------------------------------------------------------------------------------

Unit *makeTestInstrument(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0 || spec.channel >= kMaxSlots) return nullptr;
  return new TestInstrument(spec.patch->slots[spec.channel].spec, env.sampleRate);
}

}  // namespace rig
