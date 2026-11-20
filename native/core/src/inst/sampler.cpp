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
      voices_(new Voice[kSamplerPoolVoices]),
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

void SamplerInstrument::prepParams(Voice &v, std::int64_t frame) {
  (void)frame;
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
  // never on a real path (one payload per command, drained every quantum); keep it rather than free here
  garbage_[garbageN_ - 1] = p;
}

void SamplerInstrument::rampTone(double t, double tau) {
  toneLp_.frequency().setContextTime(frame0_, sr_);
  wa::rampTo(toneLp_.frequency(), toneHz(), t, tau);
}

SamplerInstrument::Counts SamplerInstrument::counts() const {
  Counts c;
  for (unsigned i = 0; i < kSamplerPoolVoices; ++i) {
    const State s = voices_[i].state;
    if (s == State::Held) ++c.held;
    else if (s == State::Released) ++c.released;
    else if (s == State::Killed) ++c.killed;
  }
  return c;
}

void SamplerInstrument::setVoiceCap(unsigned cap) {
  cap_ = std::clamp(cap, 1u, kSamplerPoolVoices);
}

void SamplerInstrument::setSampleRate(double sr) {
  // buffers keep their own rate (BufferSource repitches by bufferRate / contextRate, as an AudioBuffer of another
  // rate does in Chromium); only the tone corner depends on the context rate (Nyquist bypass at tone 1)
  sr_ = sr;
  toneLp_.frequency().setValue(toneHz());
}

// ---- voice life (instruments.js BasicVoice / BasicAllocator) --------------------------------------------------------

void SamplerInstrument::stopVoice(Voice &v, double t) {
  // BasicVoice._stop: only ever earlier; source.stop(max(t, startedAt))
  if (!(t < v.stopAt)) return;
  v.stopAt = t;
  v.src.stop(std::max(t, v.startedAt));
}

void SamplerInstrument::releaseAt(Voice &v, double t, std::int64_t frame) {
  if (v.state != State::Held) return;
  v.state = State::Released;
  v.releasedAt = t;
  if (v.ignoreRelease) return;  // undamped strings ring to the buffer end
  const double r = v.releaseOverride > 0 ? v.releaseOverride : v.release;
  prepParams(v, frame);
  wa::rampTo(v.env.gain(), 0, t, wa::releaseTau(r));
  stopVoice(v, wa::stopAfterRelease(t, r));
}

void SamplerInstrument::fadeOut(Voice &v, double t, double fadeSec, std::int64_t frame) {
  if (v.state == State::Free) return;
  const double f = std::max(0.003, fadeSec);
  prepParams(v, frame);
  wa::rampTo(v.env.gain(), 0, t, wa::releaseTau(f));  // setTarget: starts from the real current value
  if (v.state != State::Killed) v.releasedAt = std::min(v.releasedAt, t);
  v.state = State::Killed;
  stopVoice(v, wa::stopAfterRelease(t, f));
}

void SamplerInstrument::free(Voice &v) {
  if (v.state == State::Free) return;
  v.state = State::Free;
  --live_;
}

void SamplerInstrument::makeRoom(double t, std::int64_t frame) {
  // BasicAllocator.makeRoom: while playing (held | released) >= max, steal the oldest released (by releasedAt),
  // else the oldest held (by startedAt); ties go to the earlier allocation (Set insertion order), 20 ms fade
  for (;;) {
    unsigned playing = 0;
    Voice *victim = nullptr;
    for (unsigned i = 0; i < kSamplerPoolVoices; ++i) {
      Voice &v = voices_[i];
      if (v.state != State::Held && v.state != State::Released) continue;
      ++playing;
      if (v.state == State::Released &&
          (!victim || victim->state != State::Released || v.releasedAt < victim->releasedAt ||
           (v.releasedAt == victim->releasedAt && v.seq < victim->seq)))
        victim = &v;
    }
    if (playing < cap_) return;
    if (!victim || victim->state != State::Released) {
      victim = nullptr;
      for (unsigned i = 0; i < kSamplerPoolVoices; ++i) {
        Voice &v = voices_[i];
        if (v.state != State::Held) continue;
        if (!victim || v.startedAt < victim->startedAt || (v.startedAt == victim->startedAt && v.seq < victim->seq))
          victim = &v;
      }
    }
    if (!victim) return;
    fadeOut(*victim, t, kStealFade, frame);
  }
}

SamplerInstrument::Voice *SamplerInstrument::allocate(double t, std::int64_t frame) {
  makeRoom(t, frame);
  // a free pool entry; with every entry busy (killed voices still fading), the oldest killed one is cut
  Voice *pick = nullptr;
  for (unsigned i = 0; i < kSamplerPoolVoices && !pick; ++i)
    if (voices_[i].state == State::Free) pick = &voices_[i];
  if (!pick) {
    for (unsigned i = 0; i < kSamplerPoolVoices; ++i)
      if (voices_[i].state == State::Killed && (!pick || voices_[i].seq < pick->seq)) pick = &voices_[i];
    if (!pick) pick = &voices_[0];
    free(*pick);
  }
  return pick;
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

  Voice &v = *allocate(t, frame);
  std::destroy_at(&v.src);
  std::construct_at(&v.src, s->buf);
  std::destroy_at(&v.env);
  std::construct_at(&v.env, 0.0);
  v.lp[0].reset();
  v.lp[1].reset();
  v.state = State::Held;
  v.note = n;
  v.id = ++nextId_;
  v.seq = ++seq_;
  v.startedAt = t;
  v.releasedAt = kInf;
  v.stopAt = kInf;
  v.releaseOverride = relOverride_;
  ++live_;

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
  prepParams(v, frame);
  wa::setNow(v.env.gain(), js::pow(10, gDb / 20), t);  // the 2 ms fade-in is baked into the buffer
  v.release = clampD(release_, 0.005, 5) * 6.9;      // params.release is τ; BasicVoice wants time to −60 dB
  v.ignoreRelease = setup_.undampedFrom >= 0 && n >= setup_.undampedFrom;
  v.src.start(t);
}

void SamplerInstrument::noteOff(int note, std::int64_t frame, bool forced) {
  (void)forced;  // the pedal lives in the Model: every note-off that reaches the sampler releases
  const double t = timeOf(frame);
  for (unsigned i = 0; i < kSamplerPoolVoices; ++i) {
    Voice &v = voices_[i];
    if (v.state == State::Held && v.note == note) releaseAt(v, t, frame);
  }
}

void SamplerInstrument::allNotesOff(std::int64_t frame) {
  const double t = timeOf(frame);
  for (unsigned i = 0; i < kSamplerPoolVoices; ++i) fadeOut(voices_[i], t, kAllOffFade, frame);
}

void SamplerInstrument::kill() {
  for (unsigned i = 0; i < kSamplerPoolVoices; ++i) free(voices_[i]);
}

void SamplerInstrument::releaseVoice(VoiceId id, std::int64_t frame, double fadeSec) {
  const double t = timeOf(frame);
  for (unsigned i = 0; i < kSamplerPoolVoices; ++i)
    if (voices_[i].state != State::Free && voices_[i].id == id) fadeOut(voices_[i], t, fadeSec, frame);
}

void SamplerInstrument::setBend(double semis, std::int64_t frame) {
  bend_ = std::isfinite(semis) ? semis : 0;
  const double t = timeOf(frame);
  for (unsigned i = 0; i < kSamplerPoolVoices; ++i) {
    Voice &v = voices_[i];
    if (v.state == State::Free) continue;
    prepParams(v, frame);
    wa::rampTo(v.src.detune(), bend_ * 100, t, 0.008);
  }
}

void SamplerInstrument::setParam(std::uint32_t index, double value, double time, double glide) {
  (void)glide;  // sampler.js setParam has no glide: tone is a 15 ms rampTo, release is read at the next note
  if (!std::isfinite(value)) return;
  const double t = std::isfinite(time) && time * sr_ > static_cast<double>(frame0_) ? time : frame0_ / sr_;
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
      const double t = c.f.b * sr_ > static_cast<double>(frame0_) ? c.f.b : frame0_ / sr_;
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
  for (unsigned vi = 0; vi < kSamplerPoolVoices; ++vi) {
    Voice &v = voices_[vi];
    if (v.state == State::Free) continue;
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
    if (v.src.ended()) {
      AudioEvent e{};
      e.frame = ctx.frame0;
      e.kind = EventKind::VoiceEnded;
      e.f.a = static_cast<double>(static_cast<std::uint16_t>(ctx.self));
      e.f.b = static_cast<double>(v.id);
      if (ctx.events) ctx.events->push(e);
      free(v);
    }
  }
  toneLp_.process(mix, 2, n, ctx.frame0, sr_);
  if (trim_ != 1.0f)
    for (unsigned c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < n; ++i) mix[c][i] *= trim_;
  frame0_ = ctx.frame0 + static_cast<std::int64_t>(n);  // "now" for the commands of the next quantum
}

}  // namespace rig
