#include "graph/builtin_units.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "api/registry.h"
#include "mix/master_chain.h"
#include "mix/slot_channel.h"
#include "model/patch.h"

namespace rig {

// ---- strip ------------------------------------------------------------------------------------------------------

BuiltinStrip::BuiltinStrip(const SlotEqSpec &eq, double pan, double sr) : eqSpec_(eq), sr_(sr) {
  eq_.configure(eqSpec_, sr_);
  pan_.setValue(pan);
}

void BuiltinStrip::setSampleRate(double sr) {
  sr_ = sr;
  eq_.configure(eqSpec_, sr_);
}

wa::Param *BuiltinStrip::param(std::uint32_t index) {
  return index == kStripFader ? &fader_ : index == kStripPan ? &pan_ : nullptr;
}

void BuiltinStrip::apply(const Command &c) {
  if (c.op != opOf(StripOp::SetEq)) return;
  auto *p = static_cast<SlotEqPayload *>(static_cast<Owned *>(c.p.ptr));
  eqSpec_ = p->spec;
  eq_.configure(eqSpec_, sr_);  // T00 limit: hard switch (T02: glide / chain crossfade)
  pending_ = p;                 // handed back in the next process() (it has the event sink)
}

void BuiltinStrip::process(const RenderContext &ctx, UnitIO &io) {
  if (pending_) {
    giveBack(ctx, pending_);
    pending_ = nullptr;
  }
  Bus &out = *io.out;
  const int tailQuanta = static_cast<int>(6.0 * ctx.sampleRate / kQ);  // ring-out after the last input
  if (io.in)
    tail_ = eq_.filters() > 0 ? tailQuanta : 1;
  else if (tail_ > 0)
    --tail_;
  else {
    out.clear(2);
    return;
  }
  const unsigned nch = io.in ? io.in->channels : 1;
  float in[2][kQ] = {};
  if (io.in)
    for (unsigned c = 0; c < nch; ++c) std::memcpy(in[c], io.in->ch[c], sizeof in[c]);
  float gain[kQ], pan[kQ];
  fader_.processARate(ctx.frame0, ctx.sampleRate, gain, kQ);
  for (unsigned c = 0; c < nch; ++c)
    for (std::size_t i = 0; i < kQ; ++i) in[c][i] *= gain[i];
  float *chans[2] = {in[0], in[1]};
  eq_.process(chans, static_cast<int>(nch), kQ);
  pan_.processARate(ctx.frame0, ctx.sampleRate, pan, kQ);
  constexpr double kHalfPi = 1.57079632679489661923;
  float *l = out.ch[0], *r = out.ch[1];
  out.channels = 2;
  if (nch == 1) {
    for (std::size_t i = 0; i < kQ; ++i) {
      const double x = (std::clamp<double>(pan[i], -1.0, 1.0) + 1.0) * 0.5;
      l[i] = in[0][i] * static_cast<float>(std::cos(x * kHalfPi));
      r[i] = in[0][i] * static_cast<float>(std::sin(x * kHalfPi));
    }
  } else {
    for (std::size_t i = 0; i < kQ; ++i) {
      const double p = std::clamp<double>(pan[i], -1.0, 1.0);
      if (p <= 0.0) {
        const double x = (p + 1.0) * kHalfPi;
        l[i] = in[0][i] + in[1][i] * static_cast<float>(std::cos(x));
        r[i] = in[1][i] * static_cast<float>(std::sin(x));
      } else {
        const double x = p * kHalfPi;
        l[i] = in[0][i] * static_cast<float>(std::cos(x));
        r[i] = in[1][i] + in[0][i] * static_cast<float>(std::sin(x));
      }
    }
  }
}

// ---- test instrument ----------------------------------------------------------------------------------------------

TestInstrument::TestInstrument(const SlotSpec &spec, double sr) : spec_(spec), sr_(sr) {}

std::uint32_t TestInstrument::liveVoices() const {
  std::uint32_t n = 0;
  for (const auto &v : voices_) n += v.active() ? 1 : 0;
  return n;
}

void TestInstrument::noteOn(int note, int vel, float, std::int64_t frame) {
  if (spec_.inst == InstKind::None || note < spec_.lowNote || note > spec_.highNote) return;
  TestVoice *v = nullptr;
  for (auto &cand : voices_)
    if (!cand.active()) {
      v = &cand;
      break;
    }
  if (!v) v = &voices_[nextVoice_++ % kVoices];  // steal round-robin
  v->start(spec_, note, vel, frame, sr_);
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

// ---- master -------------------------------------------------------------------------------------------------------

wa::Param *BuiltinMaster::param(std::uint32_t index) {
  return index == kMasterVolume ? &volume_ : nullptr;
}

void BuiltinMaster::process(const RenderContext &ctx, UnitIO &io) {
  float mv[kQ];
  volume_.processARate(ctx.frame0, ctx.sampleRate, mv, kQ);
  Bus &out = *io.out;
  out.channels = 2;
  const Bus &in = *io.in;
  for (int c = 0; c < 2; ++c) {
    const float *src = in.ch[in.channels == 1 ? 0 : c];
    for (std::size_t i = 0; i < kQ; ++i) out.ch[c][i] = src[i] * mv[i];
  }
}

// ---- factories ----------------------------------------------------------------------------------------------------

Unit *makeBuiltinStrip(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0 || spec.channel > 3) return nullptr;
  const SlotPatch &sp = spec.patch->slots[spec.channel];
  return new BuiltinStrip(sp.spec.eq, sp.present ? sp.pan : 0.0, env.sampleRate);
}

Unit *makeTestInstrument(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0 || spec.channel > 3) return nullptr;
  return new TestInstrument(spec.patch->slots[spec.channel].spec, env.sampleRate);
}

Unit *makeBuiltinMaster(const UnitEnv &, const UnitSpec &spec) {
  return new BuiltinMaster(spec.patch ? spec.patch->master.volume : 0.5011872336272722);
}

}  // namespace rig
