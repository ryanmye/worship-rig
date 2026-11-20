// SamplerInstrument: the audio-thread half of the sampler (see sampler.h for the node graph it mirrors).
// Sources: app/js/engine/sampler.js (SamplerInstrument), app/js/engine/instruments.js (BasicVoice, BasicAllocator),
// app/js/shared/touch-curve.js (velocityDb), app/js/shared/automation.js (setNow, rampTo, releaseTau,
// stopAfterRelease). Every number JS computes goes through rig::js (bit-identical to V8); the Web Audio nodes are
// the wave-1 Chromium 157.0.8103.78 ports (wa::BufferSource, wa::Biquad / wa::BiquadFilter, wa::Gain, wa::Param).
#include "inst/sampler.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>

#include "inst/sampler_service.h"
#include "num/js_math.h"
#include "time/automation.h"

namespace rig {
namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kStealFade = 0.02;    // instruments.js STEAL_FADE
constexpr double kAllOffFade = 0.03;   // sampler.js allOff default
constexpr double kDynPivot = 0.75;     // touch-curve.js DYN_PIVOT
constexpr double kReleaseMin = 0.02, kReleaseMax = 1.5;  // sampler.js RELEASE_RANGE (the param's min / max)

double clampD(double x, double lo, double hi) { return std::min(hi, std::max(lo, x)); }

/** sampler.js BUTTER2_Q = 20·log10(SQRT1_2): a 2-pole Butterworth for a Web Audio lowpass (Q in dB). */
double butter2Q() {
  static const double q = 20 * js::log10(js::kSqrt1_2);
  return q;
}

/** touch-curve.js velocityDb(v01, spanDb, range). */
double velocityDb(double v01, double spanDb, double range) {
  const double base = -spanDb * (1 - v01);
  return range == 1 ? base : base + spanDb * (range - 1) * (v01 - kDynPivot);
}

}  // namespace

int samplerParamIndex(std::string_view key) {
  if (key == "release") return kSamplerRelease;
  if (key == "tone") return kSamplerTone;
  return -1;
}

SamplerZones::~SamplerZones() {
  if (!leases) return;
  for (const Layer &L : layers)
    for (const Sample &s : L.samples) leases->release(s.buf);
}

SamplerInstrument::SamplerInstrument(const SamplerSetup &s, SamplerZones *zones, double sampleRate)
    : setup_(s),
      zones_(zones),
      sr_(sampleRate),
      release_(clampD(s.release, kReleaseMin, kReleaseMax)),
      tone_(clampD(s.tone, 0, 1)),
      relOverride_(s.releaseOverride > 0 ? s.releaseOverride : 0),
      trim_(static_cast<float>(js::pow(10, s.gainTrimDb / 20))),
      toneLp_(wa::BiquadType::Lowpass, 0, 0, 0) {
  toneLp_.reinit(wa::BiquadType::Lowpass, toneHz(), butter2Q(), 0);
}

SamplerInstrument::~SamplerInstrument() {
  for (unsigned i = 0; i < garbageN_; ++i) delete garbage_[i];
  delete zones_;
}

// ---- helpers ------------------------------------------------------------------------------------------------------

double SamplerInstrument::toneHz() const {
  // sampler.js _toneHz: tone 1 (no morph) puts the corner at Nyquist, where Chromium's lowpass is an exact bypass
  const double t = clampD(tone_, 0, 1);
  const double f = 500 * js::pow(40, clampD(t + 0.3 * morph_, 0, 1));
  return f >= 19999 ? sr_ / 2 : f;
}

double SamplerInstrument::timeOf(std::int64_t frame) {
  // before the first render the quantum start is not known yet: the graph applies a command at the start of the
  // quantum that contains its frame (128-frame grid from 0 until a rate change; the first render corrects it)
  if (!rendered_ && frame != kFrameNow && frame >= 0) frame0_ = frame - frame % static_cast<std::int64_t>(kQ);
  // atT(ctx, when): a time in the past (or "now") plays at the current render time
  if (frame == kFrameNow || frame < frame0_) return static_cast<double>(frame0_) / sr_;
  return static_cast<double>(frame) / sr_;
}

void SamplerInstrument::prepParams(Voice &v) {
  v.src.playbackRate().setContextTime(frame0_, sr_);
  v.src.detune().setContextTime(frame0_, sr_);
  v.env.gain().setContextTime(frame0_, sr_);
}

void SamplerInstrument::deferGarbage(Owned *p) {
  if (!p) return;
  if (garbageN_ < std::size(garbage_)) {
    garbage_[garbageN_++] = p;
    return;
  }
  // never on a real path (one payload per command, drained every quantum): more than 8 payloads in one quantum
  // LEAK the previous last entry rather than free on the audio thread
  garbage_[garbageN_ - 1] = p;
}

void SamplerInstrument::rampTone(double t, double tau) {
  toneLp_.frequency().setContextTime(frame0_, sr_);
  wa::rampTo(toneLp_.frequency(), toneHz(), t, tau);
}

SamplerInstrument::Counts SamplerInstrument::counts() const {
  Counts c;
  for (unsigned i = 0; i < Pool::capacity(); ++i) {
    const inst::VoiceState st = pool_.meta(static_cast<int>(i)).state;
    if (st == inst::VoiceState::Held) ++c.held;
    else if (st == inst::VoiceState::Released) ++c.released;
    else if (st == inst::VoiceState::Killed) ++c.killed;
  }
  return c;
}

void SamplerInstrument::setVoiceCap(unsigned cap) {
  pool_.setCap(cap);
}

void SamplerInstrument::setSampleRate(double sr) {
  // buffers keep their own rate (BufferSource repitches by bufferRate / contextRate, as an AudioBuffer of another
  // rate does in Chromium); only the tone corner depends on the context rate (Nyquist bypass at tone 1)
  sr_ = sr;
  toneLp_.frequency().setValue(toneHz());
}

// ---- voice life (instruments.js BasicVoice; BasicAllocator = inst::VoicePool, StealPolicy::AnyReleased) ------------

void SamplerInstrument::stopVoice(int slot, double t) {
  // BasicVoice._stop: only ever earlier; source.stop(max(t, startedAt))
  Voice &v = pool_.voice(slot);
  if (!(t < v.stopAt)) return;
  v.stopAt = t;
  v.src.stop(std::max(t, pool_.meta(slot).startedAt));
}

void SamplerInstrument::releaseAt(int slot, double t) {
  if (pool_.meta(slot).state != inst::VoiceState::Held) return;
  pool_.markReleased(slot, t);
  Voice &v = pool_.voice(slot);
  if (v.ignoreRelease) return;  // undamped strings ring to the buffer end
  // contract 2.3: slots.<i>.release is read AT RELEASE (audio.js _release sets voice.releaseOverride just before
  // noteOff), so a change while the note is held applies to it; a retiring unit keeps the value it last got
  if (relOverride_ > 0) v.releaseOverride = relOverride_;
  const double r = v.releaseOverride > 0 ? v.releaseOverride : v.release;
  prepParams(v);
  wa::rampTo(v.env.gain(), 0, t, wa::releaseTau(r));
  stopVoice(slot, wa::stopAfterRelease(t, r));
}

void SamplerInstrument::fadeOut(int slot, double t, double fadeSec) {
  if (pool_.meta(slot).state == inst::VoiceState::Free) return;
  const double f = std::max(0.003, fadeSec);
  Voice &v = pool_.voice(slot);
  prepParams(v);
  wa::rampTo(v.env.gain(), 0, t, wa::releaseTau(f));  // setTarget: starts from the real current value
  pool_.markKilled(slot, t);                          // releasedAt = min(releasedAt, t) unless killed already
  stopVoice(slot, wa::stopAfterRelease(t, f));
}

// ---- Instrument ---------------------------------------------------------------------------------------------------

void SamplerInstrument::noteOn(int note, int vel, float velGain, std::int64_t frame) {
  if (!zones_ || zones_->layers.empty()) return;
  const double t = timeOf(frame);
  const int n = std::clamp(note, 0, 127);
  // the Model hands the touch-curved velocity as float; a plain vel/127 (the linear curve) is recovered in double
  // so the gain matches the JS bit for bit
  const double lin = std::clamp(vel, 0, 127) / 127.0;
  double v01 = static_cast<float>(lin) == velGain ? lin : static_cast<double>(velGain);
  v01 = std::isfinite(v01) ? clampD(v01, 0, 1) : 0.8;
  // layerFor(round(v01 · 127)): the layer containing it, else the nearest (ties: the lower layer)
  const double v127 = js::round(v01 * 127);
  const SamplerZones::Layer *L = nullptr;
  double bd = kInf;
  for (const auto &layer : zones_->layers) {
    const double d = v127 < layer.lo ? layer.lo - v127 : v127 > layer.hi ? v127 - layer.hi : 0;
    if (d < bd) {
      bd = d;
      L = &layer;
    }
  }
  if (!L || L->samples.empty()) return;
  // nearest sampled note (tie: the lower sample, i.e. repitch up)
  const SamplerZones::Sample *s = nullptr;
  for (const auto &x : L->samples)
    if (!s || std::abs(x.midi - n) < std::abs(s->midi - n)) s = &x;
  if (!s->buf) return;

  pool_.makeRoom(t, [&](int victim) { fadeOut(victim, t, kStealFade); });
  // every slot busy (spare slots full of fading voices): the oldest fading one is cut (it is within 20 ms of
  // silence); its VoiceEnded is not raised (no RenderContext here), the Model's retire poll sees the count drop
  const int slot = pool_.emplace(n, t, s->buf);
  if (slot < 0) return;
  Voice &v = pool_.voice(slot);
  v.stopAt = kInf;
  v.releaseOverride = 0;  // BasicVoice: unset until the release reads slots.<i>.release
  lastId_ = pool_.idOf(slot);
  v.src.playbackRate().setValue(js::pow(2, (n - s->midi) / 12.0));
  v.src.detune().setValue(bend_ * 100);
  double gDb;
  if (setup_.multiLayer) {
    gDb = velocityDb(v01, 10, dynRange_);  // layers carry the dynamics: only a −10 dB span
    v.useLp = false;
  } else {
    gDb = velocityDb(v01, 24, dynRange_);  // single layer: −24 dB span + LPF 2 k → 12 k with velocity
    v.useLp = true;
    const wa::BiquadCoeffs c =
        wa::biquadCoeffs(wa::BiquadType::Lowpass, 2000 * js::pow(6, v01), butter2Q(), 0, sr_);
    v.lp[0].set(c);
    v.lp[1].set(c);
  }
  prepParams(v);
  wa::setNow(v.env.gain(), js::pow(10, gDb / 20), t);  // the 2 ms fade-in is baked into the buffer
  v.release = clampD(release_, 0.005, 5) * 6.9;      // params.release is τ; BasicVoice wants time to −60 dB
  v.ignoreRelease = setup_.undampedFrom >= 0 && n >= setup_.undampedFrom;
  v.src.start(t);
}

void SamplerInstrument::noteOff(int note, std::int64_t frame, bool forced) {
  (void)forced;  // the pedal lives in the Model: every note-off that reaches the sampler releases
  const double t = timeOf(frame);
  pool_.forEach([&](int i, Voice &) {
    if (pool_.meta(i).state == inst::VoiceState::Held && pool_.meta(i).note == note) releaseAt(i, t);
  });
}

void SamplerInstrument::allNotesOff(std::int64_t frame) {
  const double t = timeOf(frame);
  pool_.forEach([&](int i, Voice &) { fadeOut(i, t, kAllOffFade); });
}

void SamplerInstrument::kill() {
  pool_.destroyAll();
}

void SamplerInstrument::releaseVoice(VoiceId id, std::int64_t frame, double fadeSec) {
  const double t = timeOf(frame);
  const int slot = pool_.slotOf(id);
  if (slot >= 0) fadeOut(slot, t, fadeSec);
}

bool SamplerInstrument::oldestVoice(bool released, std::int64_t frame, double &at, VoiceId &id) {
  const double t = timeOf(frame);  // the time noteOn's own makeRoom would use
  const int s = released ? pool_.oldestReleased(t) : pool_.oldestPlaying();
  if (s < 0) return false;
  at = released ? pool_.meta(s).releasedAt : pool_.meta(s).startedAt;
  id = pool_.idOf(s);
  return true;
}

void SamplerInstrument::setBend(double semis, std::int64_t frame) {
  bend_ = std::isfinite(semis) ? semis : 0;
  const double t = timeOf(frame);
  pool_.forEach([&](int, Voice &v) {
    prepParams(v);
    wa::rampTo(v.src.detune(), bend_ * 100, t, 0.008);
  });
}

void SamplerInstrument::setParam(std::uint32_t index, double value, double time, double glide) {
  (void)glide;  // sampler.js setParam has no glide: tone is a 15 ms rampTo, release is read at the next note
  if (!std::isfinite(value)) return;
  const double t = std::isfinite(time) && time > nowSec() ? time : nowSec();
  if (index == kSamplerRelease) {
    release_ = clampD(value, kReleaseMin, kReleaseMax);
  } else if (index == kSamplerTone) {
    tone_ = clampD(value, 0, 1);
    rampTone(t, 0.015);
  }
}

void SamplerInstrument::applyModule(const Command &c) {
  switch (static_cast<SamplerOp>(static_cast<std::uint16_t>(c.op))) {
    case SamplerOp::Zones: {
      auto *z = static_cast<SamplerZones *>(static_cast<Owned *>(c.p.ptr));
      if (!z) return;
      if (z->instSeq != setup_.instSeq || c.aux != setup_.instSeq) {
        deferGarbage(z);
        return;
      }
      deferGarbage(zones_);  // its buffers are all in the new table too (sampler_service.cpp): voices keep playing
      zones_ = z;
      return;
    }
    case SamplerOp::ReleaseOverride:
      relOverride_ = std::isfinite(c.f.a) && c.f.a > 0 ? c.f.a : 0;
      return;
    case SamplerOp::Morph: {
      morph_ = std::isfinite(c.f.a) ? clampD(c.f.a, 0, 1) : 0;
      const double t = c.f.b > nowSec() ? c.f.b : nowSec();
      rampTone(t, 0.03);
      return;
    }
    case SamplerOp::DynamicRange:
      dynRange_ = std::isfinite(c.f.a) ? clampD(c.f.a, 1, 3) : 1;
      return;
    default:
      if (c.sub == kSubOwnedPayload) deferGarbage(static_cast<Owned *>(c.p.ptr));
      return;
  }
}

// ---- render -------------------------------------------------------------------------------------------------------

void SamplerInstrument::process(const RenderContext &ctx, UnitIO &io) {
  const std::size_t n = kQ;
  frame0_ = ctx.frame0;
  sr_ = ctx.sampleRate;
  rendered_ = true;
  for (unsigned i = 0; i < garbageN_; ++i) giveBack(ctx, garbage_[i]);
  garbageN_ = 0;

  Bus &out = *io.out;
  out.channels = 2;
  float *mix[2] = {out.ch[0], out.ch[1]};
  std::memset(out.ch, 0, sizeof out.ch);

  alignas(16) float buf[2][kQ];
  alignas(16) float g[kQ];
  float *bp[2] = {buf[0], buf[1]};
  pool_.forEach([&](int slot, Voice &v) {
    v.src.process(ctx.frame0, sr_, bp, n);
    const unsigned nch = v.src.channels();
    if (v.useLp)
      for (unsigned c = 0; c < nch; ++c) v.lp[c].process(buf[c], buf[c], n);
    bool constant = true;
    v.env.values(g, &constant, n, ctx.frame0, sr_);
    // env GainNode, channelCount 2 explicit ('speakers'): a mono source is up-mixed to both channels first
    if (constant) {
      const float k = g[0];
      if (k != 0.0f)
        for (unsigned c = 0; c < 2; ++c) {
          const float *x = buf[nch == 1 ? 0 : c];
          for (std::size_t i = 0; i < n; ++i) mix[c][i] += x[i] * k;
        }
    } else {
      for (unsigned c = 0; c < 2; ++c) {
        const float *x = buf[nch == 1 ? 0 : c];
        for (std::size_t i = 0; i < n; ++i) mix[c][i] += x[i] * g[i];
      }
    }
    if (v.src.ended()) {  // BasicVoice: the source's onended tears the voice down
      AudioEvent e{};
      e.frame = ctx.frame0;
      e.kind = EventKind::VoiceEnded;
      e.f.a = static_cast<double>(static_cast<std::uint16_t>(ctx.self));
      e.f.b = static_cast<double>(pool_.idOf(slot));
      if (ctx.events) ctx.events->push(e);
      pool_.destroy(slot);
    }
  });
  toneLp_.process(mix, 2, n, ctx.frame0, sr_);
  if (trim_ != 1.0f)
    for (unsigned c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < n; ++i) mix[c][i] *= trim_;
  frame0_ = ctx.frame0 + static_cast<std::int64_t>(n);  // "now" for the commands of the next quantum
}

}  // namespace rig
