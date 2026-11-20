// Click unit (kind "click", UnitSlot::Click; T07): the metronome.js click bus on the audio thread.
//
// Web Audio graph replaced (metronome.js): per tick an AudioBufferSourceNode(buffer[kind]).start(t) -> bus
// GainNode(gain = level, channelCount 1 'explicit') -> destination (the graph sums io.out after the master chain or
// writes it to device channels 3-4). Here: a fixed pool of wa::BufferSource voices (T11a, Chromium 157.0.8103.78
// audio_buffer_source_node.cc) over three preallocated mono tables (click_math.h clickSamples at the unit's rate),
// summed in float into the mono bus, times the a-rate level param (GainHandler::Process: sample-accurate gain values
// while automated, else FinalValue()). Clicks never overlap at musical tempi, so the summing order of Chromium's
// AudioNodeInput (hash-set order) does not matter.
//
// RT: no allocation after construction; commands are POD (ClickOp::Schedule / ClearAfter, click.h).
#include <array>
#include <cstring>
#include <vector>

#include "api/registry.h"
#include "click/click.h"
#include "click/click_math.h"
#include "dsp/buffer_source.h"
#include "model/buffer_cache_api.h"
#include "time/param.h"

namespace rig {
namespace {

constexpr std::size_t kVoices = 32;  // 0.3 s lookahead + 40 ms sound: < 8 clicks even at 300 bpm 12/8

class ClickUnit final : public Unit {
 public:
  explicit ClickUnit(double sr) {
    for (std::size_t k = 0; k < 3; ++k) {
      const auto kind = static_cast<click::TickKind>(k);
      data_[k] = click::clickSamples(sr, click::clickHz(kind), click::clickPeak(kind));
      SampleBuffer &b = bufs_[k];
      b.channels = 1;
      b.frames = data_[k].size();
      b.sampleRate = sr;
      b.f32[0] = data_[k].data();
      b.bytes = data_[k].size() * sizeof(float);
    }
  }

  void process(const RenderContext &ctx, UnitIO &io) override {
    Bus &out = *io.out;
    out.channels = 1;
    std::memset(out.ch[0], 0, sizeof out.ch[0]);
    bool any = false;
    for (Voice &v : voices_) {
      if (!v.active) continue;
      float *p[1] = {scratch_};
      v.src.process(ctx.frame0, ctx.sampleRate, p, kQ);
      if (any) {
        for (std::size_t i = 0; i < kQ; ++i) out.ch[0][i] += scratch_[i];
      } else {
        std::memcpy(out.ch[0], scratch_, sizeof scratch_);
        any = true;
      }
      if (v.src.ended()) v.active = false;
    }
    // bus GainNode: always render the param so its timeline advances like Chromium's (it renders every quantum)
    level_.processARate(ctx.frame0, ctx.sampleRate, gain_, kQ);
    if (!any) return;
    for (std::size_t i = 0; i < kQ; ++i) out.ch[0][i] *= gain_[i];
  }

  void apply(const Command &c) override {
    if (c.op == opOf(ClickOp::Schedule)) {
      if (c.aux > 2) return;
      for (Voice &v : voices_) {
        if (v.active) continue;
        v.src = wa::BufferSource(&bufs_[c.aux]);
        v.src.start(c.f.a);
        v.t = c.f.a;
        v.active = true;
        return;
      }
      ++dropped_;  // pool full (never at musical tempi)
    } else if (c.op == opOf(ClickOp::ClearAfter)) {
      for (Voice &v : voices_)
        if (v.active && !(v.t < c.f.a - 1e-6)) v.active = false;
    }
  }

  wa::Param *param(std::uint32_t index) override { return index == kClickLevel ? &level_ : nullptr; }

  std::uint32_t liveVoices() const override {
    std::uint32_t n = 0;
    for (const Voice &v : voices_) n += v.active ? 1u : 0u;
    return n;
  }

 private:
  struct Voice {
    wa::BufferSource src;
    double t = 0;
    bool active = false;
  };
  std::array<std::vector<float>, 3> data_;
  SampleBuffer bufs_[3];
  std::array<Voice, kVoices> voices_{};
  wa::Param level_{click::kDefaultLevel};
  alignas(16) float scratch_[kQ] = {};
  alignas(16) float gain_[kQ] = {};
  std::uint32_t dropped_ = 0;
};

}  // namespace

Unit *makeClick(const UnitEnv &env, const UnitSpec &) {
  return new ClickUnit(env.sampleRate);
}

}  // namespace rig
