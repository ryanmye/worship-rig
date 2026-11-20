// SlotChannel (kind "strip"): fx.js Channel (fx.js:1992-2090) on the audio thread. fader -> wheel -> width (M/S) ->
// SlotEq (SlotEqChains) -> StereoPanner -> out; post-pan sends += out * send gain. Every stage evaluates its params
// once per quantum the way its Web Audio node does, also while the input is silent (Chromium keeps a silent node's
// params running), and the filters keep ringing for 6 s after the last input, then only the params advance.
#include <algorithm>
#include <cstring>

#include "api/registry.h"
#include "dsp/gain.h"
#include "dsp/panner.h"
#include "mix/slot_channel.h"
#include "mix/slot_channel_api.h"
#include "mix/slot_eq.h"
#include "mix/width.h"
#include "model/patch.h"
#include "time/automation.h"

namespace rig {
namespace {

constexpr double kTailSeconds = 6.0;
constexpr int kPending = 16;

class SlotChannel final : public Unit {
 public:
  SlotChannel(const SlotPatch &sp, double sr)
      : sr_(sr),
        fader_(0.0),
        wheel_(1.0),
        eq_(sp.spec.eq),
        stored_(sp.spec.eq),
        pan_(sp.present ? sp.pan : 0.0),
        slotWidth_(sp.present ? sp.width : 1.0) {
    for (unsigned k = 0; k < kSendBuses; ++k) send_[k].gain() = wa::Param(sp.present ? sp.sends[k] : 0.0);
    double n, w;
    Width::gainsFor(slotWidth_ * widthDefault_, n, w);
    width_.narrow() = wa::Param(n);
    width_.wide() = wa::Param(w);
  }

  void process(const RenderContext &ctx, UnitIO &io) override;
  void apply(const Command &c) override;
  wa::Param *param(std::uint32_t index) override;
  void setSampleRate(double sr) override { sr_ = sr; }
  std::uint32_t liveVoices() const override { return tail_ > 0 ? 1u : 0u; }

 private:
  std::int64_t nowFrame(const Command &c) const { return next_ >= 0 ? next_ : c.frame; }
  void setEq(const SlotEqSpec &spec, double when, bool step, std::int64_t now) {
    eq_.set(audition_ ? defaultSlotEqSpec() : spec, when, step, now, sr_);
  }

  double sr_;
  wa::Gain fader_, wheel_;
  Width width_;
  SlotEqChains eq_;
  SlotEqSpec stored_;  // the song's EQ (kept while auditioned flat)
  bool audition_ = false;
  wa::StereoPanner pan_;
  wa::Gain send_[kSendBuses];
  double slotWidth_, widthDefault_ = 1.0;
  unsigned channels_ = 1;
  int tail_ = 0;
  std::int64_t next_ = -1;  // first frame of the next quantum (the context time commands are applied at)
  Owned *pending_[kPending] = {};
  int npending_ = 0;
};

wa::Param *SlotChannel::param(std::uint32_t index) {
  switch (index) {
    case kStripFader:
      return &fader_.gain();
    case kStripPan:
      return &pan_.pan();
    case kStripWheel:
      return &wheel_.gain();
    case kStripWidthNarrow:
      return &width_.narrow();
    case kStripWidthWide:
      return &width_.wide();
    case kStripSendReverb:
    case kStripSendDelay:
    case kStripSendChorus:
      return &send_[index - kStripSendReverb].gain();
    default:
      return nullptr;
  }
}

void SlotChannel::apply(const Command &c) {
  const std::int64_t now = nowFrame(c);
  if (c.op == opOf(StripOp::SetEq)) {
    Owned *o = c.sub == kSubOwnedPayload ? static_cast<Owned *>(c.p.ptr) : nullptr;
    if ((c.aux == kEqChangeSet || c.aux == kEqChangeStore) && o) {
      const auto *p = static_cast<const SlotEqChange *>(o);
      stored_ = p->spec;
      if (c.aux == kEqChangeSet) setEq(stored_, p->when, p->step, now);
    }
    if (o) {
      if (npending_ < kPending) pending_[npending_++] = o;  // handed back in process() (it has the event sink)
    }
  } else if (c.op == opOf(StripOp::EqAudition)) {  // contract 1.3 eqAudition (audio.js:1272)
    const bool bypass = c.aux == 1;
    if (bypass == audition_) return;
    audition_ = bypass;
    setEq(stored_, c.f.b >= 0.0 ? c.f.b : static_cast<double>(now) / sr_, false, now);
  } else if (c.op == opOf(StripOp::SetWidthDefault)) {
    widthDefault_ = c.f.a;
    width_.setWidth(slotWidth_ * widthDefault_, static_cast<double>(c.frame) / sr_, true, now, sr_);
  } else if (c.op == opOf(StripOp::SetSlotWidth)) {
    slotWidth_ = c.f.a;
    width_.setWidth(slotWidth_ * widthDefault_, c.f.b, false, now, sr_);
  }
}

void SlotChannel::process(const RenderContext &ctx, UnitIO &io) {
  for (int i = 0; i < npending_; ++i) giveBack(ctx, pending_[i]);
  npending_ = 0;
  next_ = ctx.frame0 + static_cast<std::int64_t>(kQ);
  const std::int64_t f0 = ctx.frame0;
  const double sr = ctx.sampleRate;
  Bus &out = *io.out;
  out.channels = 2;
  float x[2][kQ];
  if (io.in) {
    channels_ = io.in->channels >= 2 ? 2u : 1u;
    for (unsigned c = 0; c < channels_; ++c) std::memcpy(x[c], io.in->ch[c], sizeof x[c]);
    tail_ = static_cast<int>(kTailSeconds * sr / static_cast<double>(kQ));
  } else {
    std::memset(x, 0, sizeof x);
    if (tail_ > 0) --tail_;
  }
  float *ch[2] = {x[0], x[1]};
  if (!io.in && tail_ <= 0) {  // silent and rung out: params only (Chromium ProcessOnlyAudioParams), timers run
    float g[kQ];
    bool constant;
    fader_.values(g, &constant, kQ, f0, sr);
    wheel_.values(g, &constant, kQ, f0, sr);
    width_.advance(kQ, f0, sr);
    eq_.advance(kQ, f0, sr);
    pan_.advance(kQ, f0, sr);
    for (auto &s : send_) s.values(g, &constant, kQ, f0, sr);
    out.clear(2);
    return;
  }
  fader_.process(ch, ch, channels_, kQ, f0, sr);
  wheel_.process(ch, ch, channels_, kQ, f0, sr);
  width_.process(ch, channels_, kQ, f0, sr);
  eq_.process(ch, channels_, kQ, f0, sr);
  pan_.process(ch, channels_, out.ch[0], out.ch[1], kQ, f0, sr);
  float *o2[2] = {out.ch[0], out.ch[1]};
  for (unsigned k = 0; k < kSendBuses; ++k) {
    float s[2][kQ];
    float *sp[2] = {s[0], s[1]};
    send_[k].process(o2, sp, 2, kQ, f0, sr);
    if (Bus *b = io.sends[k]) {
      if (b->channels == 1) {  // a mixing bus takes the max channel count (Bus::add)
        std::memcpy(b->ch[1], b->ch[0], sizeof b->ch[0]);
        b->channels = 2;
      }
      for (unsigned c = 0; c < 2; ++c)
        for (std::size_t i = 0; i < kQ; ++i) b->ch[c][i] += s[c][i];
    }
  }
}

}  // namespace

Unit *makeSlotChannel(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0 || spec.channel > 3) return nullptr;
  return new SlotChannel(spec.patch->slots[spec.channel], env.sampleRate);
}

}  // namespace rig
