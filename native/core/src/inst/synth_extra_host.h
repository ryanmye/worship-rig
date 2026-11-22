// T15: the voice.js InstrumentBase shared by synth-extra.js (inst/synth_extra.h) and organ.js (inst/organ.h), over
// T11's SynthVoice / VoicePool / makeEnv / TrackedParam (inst/synth_voice.h, inst/voice_alloc.h): note-on with the
// voice.js steal (makeRoom before the voice is built, as InstrumentBase.noteOn), releaseAt through the voice's
// `onRelease` hook (slots.<i>.release override, voice.js releaseOverride), fadeOut, allOff, the bend ConstantSource,
// legatoTo / glidePitched, the param table (resolveParams / coerceParam), morph, kill, D1 cap, D4 oldest-voice
// queries, O-W3-1 fadeNote, VoiceEnded events. The same bookkeeping as T11's SynthInstrument (inst/synth.cpp), which
// T15 does not own, so this is a parallel implementation for the T15 kinds. Audio thread after construction: no
// allocation, no locks.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string_view>

#include "dsp/constant_source.h"
#include "graph/unit.h"
#include "inst/instrument.h"
#include "inst/synth_dsp.h"
#include "inst/synth_patches.h"
#include "inst/synth_voice.h"
#include "inst/voice_alloc.h"
#include "num/prng.h"
#include "runtime/command.h"
#include "time/automation.h"

namespace rig::inst {

/** Per-quantum signals of the instrument-level nodes a T15 voice reads (extends T11's VoiceIn). */
struct XIn : VoiceIn {
  const float *zeros = nullptr;  // an input that was not pulled this quantum
  const float *vib = nullptr;    // vibD output (analog-brass, square-lead)
  const float *duty = nullptr;   // dutyCS (+ pwmG) into every PWM periodG (juno-pad, square-lead)
  const float *oct = nullptr;    // octCS (shimmer-pad)
  const float *bright = nullptr, *tine = nullptr;  // brightCS / tineCS (dx-epiano)
};

/** SynthVoice + the hooks a T15 voice needs (onRelease, more tracked params, PWM period params). */
class XVoice : public SynthVoice {
 public:
  using SynthVoice::SynthVoice;
  /** voice.js v.onRelease(rt): `envR` = the release env.release uses (the slot override when set, voice.js
   *  releaseOverride), `paramR` = inst.params.release (what a hook reads besides the envelope). Returns the stop. */
  virtual double onRelease(double rt, double envR, double paramR) {
    (void)paramR;
    return envRelease(rt, envR);
  }

  static constexpr unsigned kMaxTracked = 10, kMaxPeriods = 2;
  TrackedParam tracked[kMaxTracked];  // v.data.pitched as TrackedParams (frequency params)
  unsigned nTracked = 0;
  TrackedParam periods[kMaxPeriods];  // v.data.periods (PWM delay scalers = mult / f)
  unsigned nPeriods = 0;
  void track(wa::Param &p, double value, double mult) { tracked[nTracked++].init(&p, value, mult); }
  void trackPeriod(wa::Param &p, double f, double mult) { periods[nPeriods++].init(&p, mult / f, mult); }
  /** synth-extra glidePitched: every tracked param to f * mult, every period to mult / f, over `dur`. */
  void glidePitched(int note, double t, double dur) {
    const double f = noteToFreq(note);
    for (unsigned i = 0; i < nTracked; ++i) tracked[i].glide(f * tracked[i].mult, t, dur);
    for (unsigned i = 0; i < nPeriods; ++i) periods[i].glide(periods[i].mult / f, t, dur);
    freq = f;
  }
  /** voice.js `_stopSource` by source index, public for the instrument (percussion, tine). */
  void stopSrc(unsigned i, double t) { stopSource(i, t); }
  unsigned sourceCount() const { return nSrc_; }
};

/** voice.js coerceParam for a numeric row (Number(value); invalid -> default; clamp). */
inline double coerceParamValue(const ParamDef &d, double v) {
  if (!std::isfinite(v)) return d.def;
  return v < d.min ? d.min : (v > d.max ? d.max : v);
}
/** resolveParams(meta.params, slots.<i>.params JSON) into out[] (patch order). Control thread. `enumOf(i, str)`
 *  maps a string value of an enum row to its index (-1 = invalid -> default); null = no enum rows. */
void resolveParamsJson(const ParamDef *defs, std::size_t n, std::string_view json, double *out,
                       int (*enumOf)(std::size_t, std::string_view) = nullptr);

/**
 * InstrumentBase over a VoicePool of XVoice-derived voices of at most SlotBytes bytes. A subclass builds its shared
 * nodes in its constructor, implements buildVoice (emplace + the IMPL voice recipe), the shared-signal pass and
 * the post chain, and maps params / morph.
 */
template <std::size_t SlotBytes>
class XHost : public Instrument {
 public:
  XHost(double sampleRate, std::uint32_t engineSeed, std::string_view rngName, double releaseOverride, bool stereo,
        const ParamDef *defs, std::size_t nDefs)
      : sr_(sampleRate),
        stereo_(stereo),
        rng_(rngFor(engineSeed, rngName).fork()),  // InstrumentBase: asRng(prng) forks the registry's stream
        releaseOverride_(releaseOverride > 0 ? releaseOverride : 0),
        defs_(defs),
        nDefs_(nDefs) {
    pool_.setCap(kDefaultVoiceCap);
    bendCS_.start(0);  // this.bendCS = sharedSource(ConstantSourceNode{offset: 0})
  }

  // ---- Instrument ----
  void noteOn(int note, int vel, float velGain, std::int64_t frame) override {
    const double t = atTime(timeOf(frame));
    const int n = std::clamp(note, 0, 127);
    const double v127 = std::clamp(vel, 0, 127) / 127.0;  // velGain is a float; the JS linear curve is vel / 127
    double v01 = std::fabs(static_cast<double>(velGain) - v127) < 1e-6 ? v127 : static_cast<double>(velGain);
    v01 = clampd(std::isfinite(v01) ? v01 : 0.8, 0, 1);
    pool_.makeRoom(t, [&](int s) { fadeSlot(s, t, kStealFade); });
    beforeBuild(t);
    buildVoice(n, v01, t);
  }
  void noteOff(int note, std::int64_t frame, bool) override {
    const double t = atTime(timeOf(frame));
    pool_.forEach([&](int s, XVoice &v) {
      if (pool_.meta(s).state == VoiceState::Held && v.note() == note) releaseSlot(s, t);
    });
  }
  void allNotesOff(std::int64_t frame) override {
    const double t = atTime(timeOf(frame));
    int order[kPoolCap];
    const unsigned n = pool_.ordered(order);
    for (unsigned i = 0; i < n; ++i) fadeSlot(order[i], t, 0.03);
  }
  void kill() override {
    pool_.forEach([&](int s, XVoice &) { killSeq_ = std::max(killSeq_, pool_.meta(s).seq); });
    killAll_ = true;
  }
  void releaseVoice(VoiceId id, std::int64_t frame, double fadeSec) override {
    const int s = pool_.slotOf(id);
    if (s >= 0) fadeSlot(s, atTime(timeOf(frame)), fadeSec > 0 ? fadeSec : 0.03);
  }
  void fadeNote(int note, std::int64_t frame, double seconds) override {  // O-W3-1 (INTERFACE-CHANGE(T14) header)
    const double t = atTime(timeOf(frame));
    pool_.fadeNote(note, t, [&](int s) { fadeSlot(s, t, seconds > 0 ? seconds : 0.03); });
  }
  void setBend(double semis, std::int64_t frame) override {
    const double s = std::isfinite(semis) ? semis : 0;
    wa::rampTo(bendCS_.offset(), s * 100, atTime(timeOf(frame)), 0.008);
  }
  void legatoTo(int from, int to, std::int64_t frame, double) override {
    const double t = atTime(timeOf(frame));
    int best = -1;
    pool_.forEach([&](int s, XVoice &v) {
      const VoiceState st = pool_.meta(s).state;
      if (v.note() != from || (st != VoiceState::Held && st != VoiceState::Released)) return;
      if (best < 0 || pool_.meta(s).seq > pool_.meta(best).seq) best = s;
    });
    if (best < 0) return;
    const int n = std::clamp(to, 0, 127);
    XVoice &v = pool_.voice(best);
    v.setNote(n);
    pool_.setNote(best, n);
    glide(v, n, t);
  }
  void setParam(std::uint32_t index, double value, double time, double) override {
    if (index >= nDefs_) return;
    const double v = coerceParamValue(defs_[index], value);
    params_[index] = v;
    applyParam(index, v, atTime(time));
  }
  unsigned outputChannels() const override { return stereo_ ? 2u : 1u; }
  void setVoiceCap(unsigned cap) override { pool_.setCap(clampVoiceCap(cap)); }
  unsigned playingVoices() const override { return pool_.playing(); }
  bool oldestVoice(bool released, std::int64_t frame, double &at, VoiceId &id) override {
    const double t = atTime(timeOf(frame));
    const int s = released ? pool_.oldestReleased(t) : pool_.oldestPlaying();
    if (s < 0) return false;
    at = released ? pool_.meta(s).releasedAt : pool_.meta(s).startedAt;
    id = pool_.idOf(s);
    return true;
  }
  void setSampleRate(double sr) override {
    // as T11 F1: rescale "currentTime" the way Graph::adoptRate rescales its grid
    if (sr_ > 0 && sr > 0 && sr != sr_)
      nextFrame_ = static_cast<std::int64_t>(std::ceil(static_cast<double>(nextFrame_) * sr / sr_ - 1e-9));
    sr_ = sr;
  }
  std::uint32_t liveVoices() const override { return pool_.live(); }

  void process(const RenderContext &ctx, UnitIO &io) override {
    const std::size_t n = kQ;
    const std::int64_t f0 = ctx.frame0;
    const double sr = ctx.sampleRate;
    sr_ = sr;
    for (unsigned i = 0; i < garbageN_; ++i) giveBack(ctx, garbage_[i]);
    garbageN_ = 0;
    for (unsigned i = 0; i < pendingEndedN_; ++i) emitEndedId(ctx, pendingEnded_[i]);
    pendingEndedN_ = 0;
    if (killAll_) {
      pool_.forEach([&](int s, XVoice &) {
        if (pool_.meta(s).seq > killSeq_) return;  // a note-on after the Panic in the same quantum keeps sounding
        emitEndedId(ctx, pool_.idOf(s));
        pool_.destroy(s);
      });
      killAll_ = false;
    }
    XIn in;
    in.frame0 = f0;
    in.sr = sr;
    in.n = n;
    bendCS_.process(f0, sr, bend_, n);
    in.bend = bend_;
    in.zeros = zeros_;
    sharedPass(in);
    alignas(16) float busL[kQuantum] = {}, busR[kQuantum] = {};
    pool_.forEach([&](int, XVoice &v) { v.render(in, busL, busR); });
    pool_.forEach([&](int slot, XVoice &v) {
      if (v.tick()) {
        emitEndedId(ctx, pool_.idOf(slot));
        voiceDestroyed(slot);
        pool_.destroy(slot);
      }
    });
    postChain(in, busL, busR, *io.out);
    nextFrame_ = f0 + static_cast<std::int64_t>(n);
  }

  // ---- introspection (tests) ----
  double paramValue(std::size_t i) const { return params_[i]; }
  unsigned voiceCap() const { return pool_.cap(); }
  std::uint64_t steals() const { return pool_.steals(); }
  std::uint32_t pendingEndedDrops() const { return endedDrops_; }

 protected:
  static constexpr unsigned kPoolCap = kVoicePoolSize + kVoiceSpare;
  using Pool = VoicePool<XVoice, kPoolCap, SlotBytes>;

  // ---- subclass hooks ----
  virtual void buildVoice(int note, double vel, double t) = 0;
  virtual void beforeBuild(double t) { (void)t; }
  virtual double releaseParam() const = 0;  // inst.params.release
  virtual void glide(XVoice &v, int note, double t) { v.glidePitched(note, t, 0.03); }
  virtual void applyParam(std::uint32_t key, double v, double t) {
    (void)key;
    (void)v;
    (void)t;
  }
  virtual void sharedPass(XIn &in) { (void)in; }
  virtual void postChain(const XIn &in, float *l, float *r, Bus &out) = 0;
  virtual void voiceDestroyed(int slot) { (void)slot; }

  /** Construct voice T in the pool (InstrumentBase noteOn: alloc.add). Returns the slot (-1 = no room). */
  template <class T, class... A>
  int emplaceVoice(int note, double t, A &&...args) {
    auto evicted = [&](int slot) {  // its VoiceEnded goes out with the next quantum (T11 O5: counted, not silent)
      if (pendingEndedN_ < kMaxPendingEnded) pendingEnded_[pendingEndedN_++] = pool_.idOf(slot);
      else ++endedDrops_;
      voiceDestroyed(slot);
    };
    return pool_.template emplaceEvicting<T>(evicted, note, t, std::forward<A>(args)...);
  }
  /** forVoices: voices that still sound (held / released). */
  template <class F>
  void forVoices(F &&fn) {
    pool_.forEach([&](int slot, XVoice &v) {
      const VoiceState st = pool_.meta(slot).state;
      if (st == VoiceState::Held || st == VoiceState::Released) fn(slot, v);
    });
  }
  bool held(int slot) const { return pool_.meta(slot).state == VoiceState::Held; }

  double timeOf(std::int64_t frame) const { return static_cast<double>(frame) / sr_; }
  double atTime(double when) const {  // voice.js atTime: max(when, currentTime)
    const double now = static_cast<double>(nextFrame_) / sr_;
    return std::isfinite(when) && when > now ? when : now;
  }
  void releaseSlot(int s, double t) {
    if (pool_.meta(s).state != VoiceState::Held) return;
    pool_.markReleased(s, t);
    XVoice &v = pool_.voice(s);
    const double pr = releaseParam();
    const double r = releaseOverride_ > 0 ? releaseOverride_ : pr;
    double stop = v.onRelease(t, r, pr);
    if (!std::isfinite(stop)) stop = t + 0.05;
    v.scheduleStop(stop);
  }
  void fadeSlot(int s, double t, double fadeSec) {
    if (pool_.meta(s).state == VoiceState::Free) return;
    pool_.voice(s).fadeOut(t, fadeSec);
    pool_.markKilled(s, t);
  }
  /** Module opcodes shared by the T15 kinds: morph, release override, owned payloads (handed back). */
  bool applyCommon(std::uint16_t op, std::uint16_t morphOp, std::uint16_t releaseOp, const Command &c) {
    if (op == morphOp) {
      morph(c.f.a, atTime(c.f.b));
      return true;
    }
    if (op == releaseOp) {
      releaseOverride_ = std::isfinite(c.f.a) && c.f.a > 0 ? c.f.a : 0;
      return true;
    }
    if (c.sub == kSubOwnedPayload && c.p.ptr && garbageN_ < kMaxGarbage)
      garbage_[garbageN_++] = static_cast<Owned *>(c.p.ptr);
    return false;
  }

 public:
  /** InstrumentBase.morph(x, when) at engine time t. */
  void morph(double x01, double t) {
    morphX_ = clampd(std::isfinite(x01) ? x01 : 0, 0, 1);
    onMorph(t);
  }

 protected:
  virtual void onMorph(double t) { (void)t; }

  void emitEndedId(const RenderContext &ctx, VoiceId id) {
    if (!ctx.events) return;
    AudioEvent e{};
    e.frame = ctx.frame0;
    e.kind = EventKind::VoiceEnded;
    e.f.a = static_cast<double>(ctx.self);
    e.f.b = static_cast<double>(id);
    ctx.events->push(e);
  }

  double sr_;
  bool stereo_;
  Rng rng_;
  double params_[16] = {};
  double morphX_ = 0, releaseOverride_ = 0;
  const ParamDef *defs_;
  std::size_t nDefs_;
  std::int64_t nextFrame_ = 0;
  bool killAll_ = false;
  std::uint64_t killSeq_ = 0;
  static constexpr unsigned kMaxGarbage = 8;
  Owned *garbage_[kMaxGarbage] = {};
  unsigned garbageN_ = 0;
  static constexpr unsigned kMaxPendingEnded = kVoiceSpare;  // T11 O5: one per spare slot (an eviction per note-on)
  VoiceId pendingEnded_[kMaxPendingEnded] = {};
  unsigned pendingEndedN_ = 0;
  std::uint32_t endedDrops_ = 0;
  wa::ConstantSource bendCS_{0.0};
  alignas(16) float bend_[kQuantum] = {};
  alignas(16) float zeros_[kQuantum] = {};
  Pool pool_;
};

}  // namespace rig::inst
