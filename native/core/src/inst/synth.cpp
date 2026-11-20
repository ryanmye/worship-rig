// SynthInstrument (inst/synth.h): synth.js SynthInstrument + voice.js InstrumentBase + the registry's gain trim
// (instruments.js `_trim`). Line references are app/js/engine/synth.js unless noted.
#include "inst/synth.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "inst/synth_dispatch.h"
#include "inst/synth_voices.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "time/automation.h"
#include "yyjson.h"

namespace rig::inst {

using namespace pk;

/** Instrument-level nodes (InstrumentBase.bus / bendCS + each patch's init()). Built on the control thread. */
struct SynthShared {
  // sources (sharedSource: started at construction, i.e. at context time 0 for a fresh render)
  wa::ConstantSource bendCS{0.0}, filterCS{0.0}, bloomCS{0.0}, h2CS{0.0};
  wa::Oscillator lfo{nullptr}, chorusLfo{nullptr}, tremLfo{nullptr}, uniLfo{nullptr};
  wa::Gain lfoGain{1.0}, chorusPos{1.0}, chorusNeg{1.0}, uniPos{1.0}, uniNeg{1.0}, tremPos{1.0}, tremNeg{1.0};
  bool hasFilterMod = false, hasLfo = false;
  double filterBase = 0;
  // bus chain
  wa::BiquadFilter hpf{wa::BiquadType::Highpass, 120, 0, 0};
  wa::BiquadFilter dc{wa::BiquadType::Highpass, 20, 0, 0};
  wa::BiquadFilter lpf{wa::BiquadType::Lowpass, 250, 0, 0};
  wa::BiquadFilter mbH1{wa::BiquadType::Highpass, 200, 0, 0}, mbH2{wa::BiquadType::Highpass, 200, 0, 0};
  bool useHpf = false, useMonoBelow = false;
  wa::Gain pre{1.0}, post{1.0}, tremL{1.0}, tremR{1.0}, tremNorm{1.0};
  std::unique_ptr<wa::WaveShaper> clip;     // softClipCurve(EP_CLIP_DB), oversample 'none' (sub-bass, soft-keys)
  wa::Gain output{1.0};                     // InstrumentBase.output = trimNode (IMPL.trim, setNow at 0)
  std::unique_ptr<wa::WaveShaper> ceiling;  // addOutputCeiling: pre 1/4 -> shaper -> out (gain 1)
  float regTrim = 1;                        // gain-trims.json GainNode
  // drone-osc random walk (randomWalkBuffer: 64 s at 3 kHz)
  std::vector<float> walkData;
  SampleBuffer walk;
  // per-quantum signals
  alignas(16) float bend[kQuantum], fcs[kQuantum], lfoOut[kQuantum], cPos[kQuantum], cNeg[kQuantum],
      bloom[kQuantum], h2[kQuantum], uPos[kQuantum], uNeg[kQuantum], trem[kQuantum];
  alignas(16) float zeros[kQuantum] = {};  // an LFO input that was not pulled this quantum (its consumers are silent)
};

namespace {

constexpr double kEpClipDb = 12;
double epClipG() {
  static const double g = js::pow(10, kEpClipDb / 20);
  return g;
}

/** randomWalkBuffer(ctx, rng) (synth.js 129-164): 64 gaussian control points, circular Catmull-Rom at 3 kHz. */
void randomWalk(Rng &rng, std::vector<float> &d) {
  constexpr int N = 64, SR = 3000;
  double pts[N + 1] = {};
  for (int i = 1; i <= N; ++i) pts[i] = pts[i - 1] + rng.gaussian();
  const double drift = pts[N];
  double mean = 0;
  for (int i = 0; i < N; ++i) {
    pts[i] -= (drift * i) / N;  // close the loop
    mean += pts[i] / N;
  }
  double m = 1e-9;
  for (int i = 0; i < N; ++i) {
    pts[i] -= mean;
    m = std::max(m, std::fabs(pts[i]));
  }
  for (int i = 0; i < N; ++i) pts[i] /= m;
  d.assign(static_cast<std::size_t>(N) * SR, 0.0f);
  auto at = [&](int i) { return pts[((i % N) + N) % N]; };
  for (int i = 0; i < N; ++i) {
    const double p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const double c1 = -p0 + p2;
    const double c2 = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const double c3 = -p0 + 3 * p1 - 3 * p2 + p3;
    for (int s = i * SR, e = s + SR; s < e; ++s) {
      const double u = static_cast<double>(s) / SR - i;
      const double y = 0.5 * (2 * p1 + c1 * u + c2 * u * u + c3 * u * u * u);
      d[static_cast<std::size_t>(s)] = static_cast<float>(y < -1 ? -1 : y > 1 ? 1 : y);
    }
  }
}

}  // namespace

unsigned familiesFor(PatchId id);

namespace {
/** softClipCurve(EP_CLIP_DB) WaveShaper, oversample 'none', mono (sub-bass, soft-keys). */
std::unique_ptr<wa::WaveShaper> makeClip() {
  return std::make_unique<wa::WaveShaper>(softClipCurve12(), kSoftClipPoints, wa::WaveShaper::Oversample::None, 1);
}
}  // namespace

unsigned synthWaveFamilies(std::string_view id) {
  const PatchDef *p = findPatch(id);
  return p ? familiesFor(p->id) : kWaveAll;
}

unsigned familiesFor(PatchId id) {
  switch (id) {
    case PatchId::WarmPad: return kWaveSaw | kWaveBasic;
    case PatchId::GlassPad: return kWaveGlass | kWaveBasic;
    case PatchId::Strings: return kWaveSaw | kWaveBasic;
    case PatchId::SubBass: return kWaveSine | kWaveTri | kWaveBasic;
    case PatchId::SoftKeys: return kWaveBasic;
    case PatchId::Bell: return kWaveSine | kWaveBasic;
    case PatchId::DroneOsc: return kWaveSaw | kWaveBasic;
    default: return kWaveAll;
  }
}

namespace {

/** coerceParam for a numeric row: Number(value), invalid -> default, clamp. */
double coerce(const ParamDef &d, double v) {
  if (!std::isfinite(v)) return d.def;
  return v < d.min ? d.min : (v > d.max ? d.max : v);
}

/** voice.js resolveParams(meta.params, overrides) from slots.<i>.params JSON. */
void resolveParams(const PatchDef &p, std::string_view json, double *out) {
  for (std::size_t i = 0; i < p.nParams; ++i) out[i] = p.params[i].def;
  if (json.empty()) return;
  yyjson_doc *doc = yyjson_read(json.data(), json.size(), 0);
  if (!doc) return;
  yyjson_val *root = yyjson_doc_get_root(doc);
  if (yyjson_is_obj(root)) {
    for (std::size_t i = 0; i < p.nParams; ++i) {
      yyjson_val *v = yyjson_obj_get(root, p.params[i].key);
      if (!v) continue;
      double x = NAN;
      if (yyjson_is_num(v)) x = yyjson_get_num(v);
      else if (yyjson_is_bool(v)) x = yyjson_get_bool(v) ? 1 : 0;
      else if (yyjson_is_str(v)) x = std::strtod(yyjson_get_str(v), nullptr);
      else if (yyjson_is_null(v)) x = 0;  // Number(null) = 0
      out[i] = coerce(p.params[i], x);
    }
  }
  yyjson_doc_free(doc);
}

}  // namespace

// ---- construction --------------------------------------------------------------------------------------------------

SynthInstrument::SynthInstrument(const PatchDef &patch, double sampleRate, std::uint32_t engineSeed,
                                 std::string_view rngName, std::string_view paramsJson, double releaseOverride)
    : patch_(patch),
      sr_(sampleRate),
      stereo_(patch.id != PatchId::SubBass && patch.id != PatchId::Bell),
      rng_(rngFor(engineSeed, rngName).fork()),  // InstrumentBase: asRng(prng) forks the registry's stream
      releaseOverride_(releaseOverride > 0 ? releaseOverride : 0),
      sh_(std::make_unique<SynthShared>()) {
  pool_.setCap(kDefaultVoiceCap);
  (void)oscFinalValueCalls();  // probe once here, on the control thread (it allocates a wavetable)
  resolveParams(patch_, paramsJson, params_);
  bank_ = WaveBank::get(sr_, familiesFor(patch_.id));
  SynthShared &s = *sh_;
  const double *p = params_;
  s.bendCS.start(0);  // InstrumentBase: this.bendCS = sharedSource(ConstantSourceNode{offset: 0})
  auto filterMod = [&](double base, bool withLfo, double morphCents, unsigned cutoff, unsigned rate,
                       unsigned depth) {
    s.filterBase = base;  // initFilterMod
    s.hasFilterMod = true;
    s.filterCS.offset().setValue(cents(p[cutoff] / base) + morphX_ * morphCents);
    s.filterCS.start(0);
    if (withLfo) {
      s.hasLfo = true;
      s.lfo.setWave(bank_->basicSine.get());
      s.lfo.frequency().setValue(p[rate]);
      s.lfo.start(0);
      s.lfoGain.gain().setValue(p[depth]);
    }
  };
  switch (patch_.id) {
    case PatchId::WarmPad:
      filterMod(1800, true, 2400, wCutoff, wLfoRate, wLfoDepth);
      s.hpf.reinit(wa::BiquadType::Highpass, 120, butter2Q(), 0);
      s.useHpf = s.useMonoBelow = true;
      break;
    case PatchId::GlassPad:
      s.filterBase = 6000;
      s.hasFilterMod = true;
      s.filterCS.offset().setValue(cents(p[gCutoff] / 6000) + morphX_ * 0);
      s.filterCS.start(0);
      s.bloomCS.offset().setValue(clampd(p[gBloom] + morphX_, 0, 1) * 0.6);
      s.bloomCS.start(0);
      s.chorusLfo.setWave(bank_->basicSine.get());
      s.chorusLfo.frequency().setValue(rng_.range(0.25, 0.4));
      s.chorusLfo.start(0);
      s.chorusPos.gain().setValue(p[gChorus] * 8);
      s.chorusNeg.gain().setValue(-p[gChorus] * 8);
      s.hpf.reinit(wa::BiquadType::Highpass, 120, butter2Q(), 0);
      s.useHpf = true;
      break;
    case PatchId::Strings:
      s.filterBase = 4000;
      s.hasFilterMod = true;
      s.filterCS.offset().setValue(cents(p[sCutoff] / 4000) + morphX_ * 1600);
      s.filterCS.start(0);
      s.hpf.reinit(wa::BiquadType::Highpass, 150, butter2Q(), 0);
      s.useHpf = true;
      break;
    case PatchId::SubBass:
      s.h2CS.start(0);
      s.clip = makeClip();
      s.lpf.reinit(wa::BiquadType::Lowpass, p[bCutoff], butter2Q(), 0);
      morph(0, 0);  // setDrive(inst, 0)
      break;
    case PatchId::SoftKeys: {
      s.dc.reinit(wa::BiquadType::Highpass, 20, butter2Q(), 0);
      s.clip = makeClip();
      const double d = clampd(p[kTremolo] + morphX_, 0, 1) * 0.9;
      const double base = 1 - d / 2;
      s.tremL.gain().setValue(base);
      s.tremR.gain().setValue(base);
      s.tremPos.gain().setValue(d / 2);
      s.tremNeg.gain().setValue(-(d / 2));
      s.tremNorm.gain().setValue(js::kSqrt1_2 / js::sqrt(base * base + (d * d) / 8));
      s.tremLfo.setWave(bank_->basicSine.get());
      s.tremLfo.frequency().setValue(p[kTremRate]);
      s.tremLfo.start(0);
      const double k = 0.5 + 2.5 * p[kDrive];  // setDrive(inst, 0)
      wa::rampTo(s.pre.gain(), k / epClipG(), 0, 0.02);
      wa::rampTo(s.post.gain(), js::tanh(epClipG()) / k, 0, 0.02);
      break;
    }
    case PatchId::Bell:
      break;
    case PatchId::DroneOsc: {
      filterMod(1400, true, 1200, dCutoff, dLfoRate, dLfoDepth);
      randomWalk(rng_, s.walkData);
      s.walk.channels = 1;
      s.walk.frames = s.walkData.size();
      s.walk.sampleRate = 3000;
      s.walk.f32[0] = s.walkData.data();
      s.walk.bytes = s.walkData.size() * sizeof(float);
      s.uniLfo.setWave(bank_->basicSine.get());
      s.uniLfo.frequency().setValue(rng_.range(0.015, 0.03));
      s.uniLfo.start(0);
      s.uniPos.gain().setValue(p[dUnisonDrift]);
      s.uniNeg.gain().setValue(-p[dUnisonDrift]);
      s.hpf.reinit(wa::BiquadType::Highpass, 80, butter2Q(), 0);
      s.useHpf = s.useMonoBelow = true;
      break;
    }
    default:
      break;
  }
  if (s.useMonoBelow) {
    s.mbH1.reinit(wa::BiquadType::Highpass, 200, butter4Q(0), 0);  // MONO_SIDE_HPF
    s.mbH2.reinit(wa::BiquadType::Highpass, 200, butter4Q(1), 0);
  }
  wa::setNow(s.output.gain(), patch_.implTrim, 0);  // setNow(this.output.gain, this.impl.trim, 0)
  s.ceiling = std::make_unique<wa::WaveShaper>(softCeilingCurve(), kCeilingPoints, wa::WaveShaper::Oversample::None,
                                               stereo_ ? 2u : 1u);
  s.regTrim = static_cast<float>(js::pow(10, patch_.trimDb / 20));
}

SynthInstrument::~SynthInstrument() = default;

// ---- time ------------------------------------------------------------------------------------------------------

double SynthInstrument::timeOf(std::int64_t frame) const {
  return static_cast<double>(frame) / sr_;
}

void SynthInstrument::setSampleRate(double sr) {
  // Graph::adoptRate rescales its frame grid, then applies this quantum's commands before process(): rescale the
  // "currentTime" frame the same way, or atTime() would read old-rate frames at the new rate (a 48 -> 44.1 kHz
  // change at t = 1000 s would push that quantum's note-ons 88 s into the future).
  if (sr_ > 0 && sr > 0 && sr != sr_)
    nextFrame_ = static_cast<std::int64_t>(std::ceil(static_cast<double>(nextFrame_) * sr / sr_ - 1e-9));
  sr_ = sr;
}

double SynthInstrument::atTime(double when) const {
  const double now = static_cast<double>(nextFrame_) / sr_;
  return std::isfinite(when) && when > now ? when : now;
}

// ---- notes -------------------------------------------------------------------------------------------------------

void SynthInstrument::noteOn(int note, int vel, float velGain, std::int64_t frame) {
  const double t = atTime(timeOf(frame));
  const int n = std::clamp(note, 0, 127);
  // velGain travels as a float; the JS curve result for a linear curve is vel / 127 in double
  const double v127 = std::clamp(vel, 0, 127) / 127.0;
  double v01 = std::fabs(static_cast<double>(velGain) - v127) < 1e-6 ? v127 : static_cast<double>(velGain);
  v01 = clampd(std::isfinite(v01) ? v01 : 0.8, 0, 1);
  pool_.makeRoom(t, [&](int s) { fadeSlot(s, t, kStealFade); });
  const BuildCtx b{*bank_, rng_, params_, sr_, t, v01, morphX_, n, &sh_->walk};
  auto evicted = [&](int slot) {  // its VoiceEnded goes out with the next quantum
    if (pendingEndedN_ < kMaxPendingEnded) pendingEnded_[pendingEndedN_++] = pool_.idOf(slot);
  };
  switch (patch_.id) {
    case PatchId::WarmPad: pool_.emplaceEvicting<WarmVoice>(evicted, n, t, b); break;
    case PatchId::GlassPad: pool_.emplaceEvicting<GlassVoice>(evicted, n, t, b); break;
    case PatchId::Strings: pool_.emplaceEvicting<StringsVoice>(evicted, n, t, b); break;
    case PatchId::SubBass: pool_.emplaceEvicting<SubVoice>(evicted, n, t, b); break;
    case PatchId::SoftKeys: pool_.emplaceEvicting<KeysVoice>(evicted, n, t, b); break;
    case PatchId::Bell: pool_.emplaceEvicting<BellVoice>(evicted, n, t, b); break;
    case PatchId::DroneOsc: pool_.emplaceEvicting<DroneVoice>(evicted, n, t, b); break;
    default: break;
  }
}

bool SynthInstrument::oldestVoice(bool released, std::int64_t frame, double &at, VoiceId &id) {
  const double t = atTime(timeOf(frame));  // the time noteOn's own makeRoom would use
  const int s = released ? pool_.oldestReleased(t) : pool_.oldestPlaying();
  if (s < 0) return false;
  at = released ? pool_.meta(s).releasedAt : pool_.meta(s).startedAt;
  id = pool_.idOf(s);
  return true;
}

void SynthInstrument::releaseSlot(int s, double t) {
  if (pool_.meta(s).state != VoiceState::Held) return;
  pool_.markReleased(s, t);
  SynthVoice &v = pool_.voice(s);
  const double r = releaseOverride_ > 0 ? releaseOverride_ : params_[releaseIndex(patch_.id)];
  double stop = v.envRelease(t, r);
  if (!std::isfinite(stop)) stop = t + 0.05;
  v.scheduleStop(stop);
}

void SynthInstrument::fadeSlot(int s, double t, double fadeSec) {
  if (pool_.meta(s).state == VoiceState::Free) return;
  pool_.voice(s).fadeOut(t, fadeSec);
  pool_.markKilled(s, t);
}

unsigned SynthInstrument::playingNote(int note) const {
  unsigned n = 0;
  for (unsigned i = 0; i < pool_.capacity(); ++i) {
    const auto &m = pool_.meta(static_cast<int>(i));
    if ((m.state == VoiceState::Held || m.state == VoiceState::Released) && m.note == note) ++n;
  }
  return n;
}

VoiceId SynthInstrument::voiceIdOf(int note) const {
  int best = -1;
  for (unsigned i = 0; i < pool_.capacity(); ++i) {
    const auto &m = pool_.meta(static_cast<int>(i));
    if ((m.state == VoiceState::Held || m.state == VoiceState::Released) && m.note == note &&
        (best < 0 || m.seq > pool_.meta(best).seq))
      best = static_cast<int>(i);
  }
  return best < 0 ? 0xffffffffu : pool_.idOf(best);
}

void SynthInstrument::noteOff(int note, std::int64_t frame, bool) {
  const double t = atTime(timeOf(frame));
  pool_.forEach([&](int s, SynthVoice &v) {
    if (pool_.meta(s).state == VoiceState::Held && v.note() == note) releaseSlot(s, t);
  });
}

void SynthInstrument::allNotesOff(std::int64_t frame) {
  const double t = atTime(timeOf(frame));
  int order[decltype(pool_)::capacity()];
  const unsigned n = pool_.ordered(order);
  for (unsigned i = 0; i < n; ++i) fadeSlot(order[i], t, 0.03);
}

void SynthInstrument::kill() {
  pool_.forEach([&](int s, SynthVoice &) { killSeq_ = std::max(killSeq_, pool_.meta(s).seq); });
  killAll_ = true;
}

void SynthInstrument::releaseVoice(VoiceId id, std::int64_t frame, double fadeSec) {
  const int s = pool_.slotOf(id);
  if (s >= 0) fadeSlot(s, atTime(timeOf(frame)), fadeSec > 0 ? fadeSec : 0.03);
}

void SynthInstrument::setBend(double semis, std::int64_t frame) {
  const double s = std::isfinite(semis) ? semis : 0;
  wa::rampTo(sh_->bendCS.offset(), s * 100, atTime(timeOf(frame)), 0.008);
}

void SynthInstrument::legatoTo(int from, int to, std::int64_t frame, double) {
  const double t = atTime(timeOf(frame));
  int best = -1;
  pool_.forEach([&](int s, SynthVoice &v) {
    const VoiceState st = pool_.meta(s).state;
    if (v.note() != from || (st != VoiceState::Held && st != VoiceState::Released)) return;
    if (best < 0 || pool_.meta(s).seq > pool_.meta(best).seq) best = s;
  });
  if (best < 0) return;
  SynthVoice &v = pool_.voice(best);
  const int n = std::clamp(to, 0, 127);
  v.setNote(n);
  pool_.setNote(best, n);
  const int gi = glideIndex(patch_.id);
  const double dur = gi >= 0 ? params_[gi] : 0.03;  // inst.params.glide ?? 0.03
  const double f = noteToFreq(n);
  for (unsigned i = 0; i < v.nPitched; ++i) v.pitched[i].glide(f * v.pitched[i].mult, t, dur);  // glidePitched
  v.freq = f;
  if (patch_.id == PatchId::SoftKeys) {
    auto &k = static_cast<KeysVoice &>(v);
    double c1 = 0, cT = 0;
    keysCaps(sr_, f, k.fm1.index(t + dur), c1, cT);
    k.fm1.retune(f, c1, t, dur);  // in-flight index kept, deviation follows f (m6)
    if (k.hasTine && t < k.startedAt() + 0.3) k.fmT.retune(14 * f, cT, t, dur);
  } else if (patch_.id == PatchId::Bell) {
    auto &b = static_cast<BellVoice &>(v);
    const double r = v.pitched[1].mult;
    b.fmd.retune(f * r, fmIndexCap(sr_, f, r * f), t, dur);
  }
}

// ---- params / morph ----------------------------------------------------------------------------------------------

void SynthInstrument::setParam(std::uint32_t index, double value, double time, double) {
  if (index >= patch_.nParams) return;
  const double v = coerce(patch_.params[index], value);
  params_[index] = v;
  applyPatchParam(index, v, atTime(time));
}

void SynthInstrument::applyPatchParam(std::size_t key, double val, double t) {
  SynthShared &s = *sh_;
  auto forVoices = [&](auto &&fn) {
    pool_.forEach([&](int slot, SynthVoice &v) {
      const VoiceState st = pool_.meta(slot).state;
      if (st == VoiceState::Held || st == VoiceState::Released) fn(v);
    });
  };
  switch (patch_.id) {
    case PatchId::WarmPad:
      if (key == wCutoff) wa::rampTo(s.filterCS.offset(), cents(params_[wCutoff] / 1800) + morphX_ * 2400, t);
      else if (key == wLfoRate) wa::rampTo(s.lfo.frequency(), val, t);
      else if (key == wLfoDepth) wa::rampTo(s.lfoGain.gain(), val, t);
      else if (key == wResonance) forVoices([&](SynthVoice &v) {
        wa::rampTo(static_cast<WarmVoice &>(v).q2, butter4Q(1) + val * 14.93, t);
      });
      else if (key == wSub) forVoices([&](SynthVoice &v) {
        wa::rampTo(static_cast<WarmVoice &>(v).subG.gain(), val * 1.12, t);
      });
      else if (key == wDetune) {
        const double d[5] = {0, (-val * 9) / 17, (val * 9) / 17, -val, val};
        forVoices([&](SynthVoice &v) {
          for (int i = 0; i < 5; ++i) wa::rampTo(static_cast<WarmVoice &>(v).saw[i].detune(), d[i], t);
        });
      }
      break;
    case PatchId::GlassPad:
      if (key == gCutoff) wa::rampTo(s.filterCS.offset(), cents(params_[gCutoff] / 6000) + morphX_ * 0, t);
      else if (key == gBloom) wa::rampTo(s.bloomCS.offset(), clampd(params_[gBloom] + morphX_, 0, 1) * 0.6, t);
      else if (key == gChorus) {
        wa::rampTo(s.chorusPos.gain(), val * 8, t);
        wa::rampTo(s.chorusNeg.gain(), -val * 8, t);
      } else if (key == gDetune) forVoices([&](SynthVoice &v) {
        wa::rampTo(static_cast<GlassVoice &>(v).a.detune(), -val, t);
        wa::rampTo(static_cast<GlassVoice &>(v).b.detune(), val, t);
      });
      break;
    case PatchId::Strings:
      if (key == sCutoff) wa::rampTo(s.filterCS.offset(), cents(params_[sCutoff] / 4000) + morphX_ * 1600, t);
      else if (key == sVibRate) forVoices([&](SynthVoice &v) {
        wa::rampTo(static_cast<StringsVoice &>(v).vib.frequency(), val, t);
      });
      else if (key == sVibDepth) forVoices([&](SynthVoice &v) {
        if (t >= v.startedAt() + params_[sVibDelay]) wa::rampTo(static_cast<StringsVoice &>(v).vibG.gain(), val, t);
      });
      else if (key == sDetune) {
        const double d[5] = {0, -val / 2, val / 2, val, -val};
        forVoices([&](SynthVoice &v) {
          for (int i = 0; i < 5; ++i) wa::rampTo(static_cast<StringsVoice &>(v).saw[i].detune(), d[i], t);
        });
      }
      break;
    case PatchId::SubBass:
      if (key == bDrive) morph(morphX_, t);
      else if (key == bCutoff) wa::rampTo(s.lpf.frequency(), val, t);
      else if (key == bTri) forVoices([&](SynthVoice &v) {
        wa::rampTo(static_cast<SubVoice &>(v).trG.gain(), val * 0.8, t);
      });
      break;
    case PatchId::SoftKeys:
      if (key == kTremolo) morph(morphX_, t);
      else if (key == kTremRate) wa::rampTo(s.tremLfo.frequency(), val, t);
      else if (key == kDrive) {
        const double k = 0.5 + 2.5 * params_[kDrive];
        wa::rampTo(s.pre.gain(), k / epClipG(), t, 0.02);
        wa::rampTo(s.post.gain(), js::tanh(epClipG()) / k, t, 0.02);
      }
      break;
    case PatchId::Bell:
      if (key == eRatio) morph(morphX_, t);
      break;
    case PatchId::DroneOsc:
      if (key == dCutoff) wa::rampTo(s.filterCS.offset(), cents(params_[dCutoff] / 1400) + morphX_ * 1200, t);
      else if (key == dLfoRate) wa::rampTo(s.lfo.frequency(), val, t);
      else if (key == dLfoDepth) wa::rampTo(s.lfoGain.gain(), val, t);
      else if (key == dUnisonDrift) {
        wa::rampTo(s.uniPos.gain(), val, t);
        wa::rampTo(s.uniNeg.gain(), -val, t);
      } else if (key == dDrift) forVoices([&](SynthVoice &v) {
        wa::rampTo(static_cast<DroneVoice &>(v).driftG.gain(), val, t);
      });
      else if (key == dSub) forVoices([&](SynthVoice &v) {
        wa::rampTo(static_cast<DroneVoice &>(v).subG.gain(), val * 1.12, t);
      });
      else if (key == dDetune) {
        const double d[4] = {-val, -val / 3, val / 3, val};
        forVoices([&](SynthVoice &v) {
          for (int i = 0; i < 4; ++i) wa::rampTo(static_cast<DroneVoice &>(v).saw[i].detune(), d[i], t);
        });
      }
      break;
    default:
      break;
  }
}

void SynthInstrument::morph(double x01, double t) {
  morphX_ = clampd(std::isfinite(x01) ? x01 : 0, 0, 1);
  SynthShared &s = *sh_;
  const double *p = params_;
  switch (patch_.id) {
    case PatchId::WarmPad: wa::rampTo(s.filterCS.offset(), cents(p[wCutoff] / 1800) + morphX_ * 2400, t); break;
    case PatchId::GlassPad: wa::rampTo(s.bloomCS.offset(), clampd(p[gBloom] + morphX_, 0, 1) * 0.6, t, 0.05); break;
    case PatchId::Strings: wa::rampTo(s.filterCS.offset(), cents(p[sCutoff] / 4000) + morphX_ * 1600, t); break;
    case PatchId::DroneOsc: wa::rampTo(s.filterCS.offset(), cents(p[dCutoff] / 1400) + morphX_ * 1200, t); break;
    case PatchId::SubBass: {  // setDrive
      const double d = clampd(p[bDrive] + morphX_, 0, 1);
      const double k = 0.4 + 2.2 * d;  // input scale into tanh(4x)/tanh(4)
      wa::rampTo(s.pre.gain(), k / epClipG(), t, 0.02);
      wa::rampTo(s.post.gain(), (js::tanh(epClipG()) / k) * (1 - 0.3 * d), t, 0.02);
      wa::rampTo(s.h2CS.offset(), 0.08 + 0.3 * d, t, 0.02);  // H2 ≈ -22 dB (drive 0) … -8 dB (drive 1)
      break;
    }
    case PatchId::SoftKeys: {  // setTrem
      const double d = clampd(p[kTremolo] + morphX_, 0, 1) * 0.9;
      const double base = 1 - d / 2, mod = d / 2;
      wa::rampTo(s.tremL.gain(), base, t);
      wa::rampTo(s.tremR.gain(), base, t);
      wa::rampTo(s.tremPos.gain(), mod, t);
      wa::rampTo(s.tremNeg.gain(), -mod, t);
      wa::rampTo(s.tremNorm.gain(), js::kSqrt1_2 / js::sqrt(base * base + (d * d) / 8), t);
      break;
    }
    case PatchId::Bell: {  // retune every sounding voice (ratio / morph)
      const double r = p[eRatio] + morphX_ * (5.1 - 3.5);
      pool_.forEach([&](int slot, SynthVoice &v) {
        const VoiceState st = pool_.meta(slot).state;
        if (st != VoiceState::Held && st != VoiceState::Released) return;
        TrackedParam &e = v.pitched[1];
        e.mult = r;
        e.glide(v.freq * e.mult, t, 0.02);
        static_cast<BellVoice &>(v).fmd.retune(v.freq * e.mult, fmIndexCap(sr_, v.freq, e.mult * v.freq), t, 0.02);
      });
      break;
    }
    default:
      break;
  }
}

void SynthInstrument::applyModule(const Command &c) {
  switch (static_cast<SynthOp>(static_cast<std::uint16_t>(c.op))) {
    case SynthOp::Morph:
      morph(c.f.a, atTime(c.f.b));
      break;
    case SynthOp::ReleaseOverride:
      releaseOverride_ = std::isfinite(c.f.a) && c.f.a > 0 ? c.f.a : 0;
      break;
    case SynthOp::SetWaves:
      if (c.sub == kSubOwnedPayload && c.p.ptr) {
        auto *w = static_cast<WavesPayload *>(static_cast<Owned *>(c.p.ptr));
        if (w->bank && w->bank->sampleRate > 0) setWaves(*w->bank);  // swap: the payload now holds the old bank
        std::swap(w->bank, bank_);
        if (garbageN_ < kMaxGarbage) garbage_[garbageN_++] = w;  // handed back at the next process()
      }
      break;
    default:
      if (c.sub == kSubOwnedPayload && c.p.ptr && garbageN_ < kMaxGarbage)
        garbage_[garbageN_++] = static_cast<Owned *>(c.p.ptr);
      break;
  }
}

// ---- rendering ---------------------------------------------------------------------------------------------------

void SynthInstrument::emitEnded(const RenderContext &ctx, int slot) {
  if (!ctx.events) return;
  AudioEvent e{};
  e.frame = ctx.frame0;
  e.kind = EventKind::VoiceEnded;
  e.f.a = static_cast<double>(ctx.self);
  e.f.b = static_cast<double>(pool_.idOf(slot));
  ctx.events->push(e);
}

void SynthInstrument::setWaves(const WaveBank &bank) {
  pool_.forEach([&](int, SynthVoice &v) { v.setWaves(bank); });
  SynthShared &s = *sh_;
  for (wa::Oscillator *o : {&s.lfo, &s.chorusLfo, &s.tremLfo, &s.uniLfo}) o->setWave(bank.wave(WaveKind::BasicSine));
}

namespace {

/** A GainNode whose gain AudioParam has an audio input: a-rate timeline + input, per frame (Vmul). */
void connGain(wa::Param &g, const float *conn, float *x, std::size_t n, std::int64_t f0, double sr) {
  float v[kQuantum];
  g.processARate(f0, sr, v, n);
  for (std::size_t i = 0; i < n; ++i) x[i] *= v[i] + conn[i];
}

void scale(float *x, std::size_t n, float g) {
  if (g == 1.0f) return;
  for (std::size_t i = 0; i < n; ++i) x[i] *= g;
}

}  // namespace

void SynthInstrument::process(const RenderContext &ctx, UnitIO &io) {
  const std::size_t n = kQ;
  const std::int64_t f0 = ctx.frame0;
  const double sr = ctx.sampleRate;
  sr_ = sr;
  for (unsigned i = 0; i < garbageN_; ++i) giveBack(ctx, garbage_[i]);
  garbageN_ = 0;
  for (unsigned i = 0; i < pendingEndedN_; ++i) {
    if (!ctx.events) break;
    AudioEvent e{};
    e.frame = f0;
    e.kind = EventKind::VoiceEnded;
    e.f.a = static_cast<double>(ctx.self);
    e.f.b = static_cast<double>(pendingEnded_[i]);
    ctx.events->push(e);
  }
  pendingEndedN_ = 0;
  if (killAll_) {
    pool_.forEach([&](int s, SynthVoice &) {
      if (pool_.meta(s).seq > killSeq_) return;  // a note-on after the Panic in the same quantum keeps sounding
      emitEnded(ctx, s);
      pool_.destroy(s);
    });
    killAll_ = false;
  }
  SynthShared &s = *sh_;
  VoiceIn in;
  in.frame0 = f0;
  in.sr = sr;
  in.n = n;
  s.bendCS.process(f0, sr, s.bend, n);
  in.bend = s.bend;
  in.chorusPos = in.chorusNeg = in.uniPos = in.uniNeg = s.zeros;
  if (s.hasFilterMod) {  // linkFilter: filterCS then the LFO gain into every voice filter's k-rate detune
    s.filterCS.process(f0, sr, s.fcs, n);
    float det = 0.0f;
    det += s.fcs[0];
    if (s.hasLfo) {
      oscProcess(s.lfo, true, false, f0, sr, s.lfoOut, n, nullptr, nullptr);
      float *c[1] = {s.lfoOut};
      s.lfoGain.process(c, c, 1, n, f0, sr);
      det += s.lfoOut[0];
    }
    in.filterDet = det;
  }
  float tmp[kQuantum];
  switch (patch_.id) {
    case PatchId::GlassPad: {
      // The chorus LFO feeds only the side oscillators' detune: pulled only while one of them plays.
      bool pulled = false;
      pool_.forEach([&](int, SynthVoice &v) {
        pulled = pulled || v.srcActive(1, f0, sr, n) || v.srcActive(2, f0, sr, n);  // a, b
      });
      if (!pulled) {
        s.bloomCS.process(f0, sr, s.bloom, n);
        in.bloom = s.bloom;
        break;
      }
      oscProcess(s.chorusLfo, true, false, f0, sr, tmp, n, nullptr, nullptr);
      const float *src[1] = {tmp};
      float *p1[1] = {s.cPos}, *n1[1] = {s.cNeg};
      s.chorusPos.process(src, p1, 1, n, f0, sr);
      s.chorusNeg.process(src, n1, 1, n, f0, sr);
      s.bloomCS.process(f0, sr, s.bloom, n);
      in.chorusPos = s.cPos;
      in.chorusNeg = s.cNeg;
      in.bloom = s.bloom;
      break;
    }
    case PatchId::SubBass:
      s.h2CS.process(f0, sr, s.h2, n);
      in.h2 = s.h2;
      break;
    case PatchId::DroneOsc: {
      bool pulled = false;  // the unison LFO feeds only saw detunes (see GlassPad)
      pool_.forEach([&](int, SynthVoice &v) {
        for (unsigned i = 0; i < 4; ++i) pulled = pulled || v.srcActive(i, f0, sr, n);
      });
      if (!pulled) break;
      oscProcess(s.uniLfo, true, false, f0, sr, tmp, n, nullptr, nullptr);
      const float *src[1] = {tmp};
      float *p1[1] = {s.uPos}, *n1[1] = {s.uNeg};
      s.uniPos.process(src, p1, 1, n, f0, sr);
      s.uniNeg.process(src, n1, 1, n, f0, sr);
      in.uniPos = s.uPos;
      in.uniNeg = s.uNeg;
      break;
    }
    case PatchId::SoftKeys: {
      oscProcess(s.tremLfo, true, false, f0, sr, s.trem, n, nullptr, nullptr);
      const float *src[1] = {s.trem};
      float *p1[1] = {s.cPos}, *n1[1] = {s.cNeg};
      s.tremPos.process(src, p1, 1, n, f0, sr);
      s.tremNeg.process(src, n1, 1, n, f0, sr);
      break;
    }
    default:
      break;
  }
  alignas(16) float busL[kQuantum] = {}, busR[kQuantum] = {};
  pool_.forEach([&](int, SynthVoice &v) { v.render(in, busL, stereo_ ? busR : nullptr); });
  pool_.forEach([&](int slot, SynthVoice &v) {
    if (v.tick()) {
      emitEnded(ctx, slot);
      pool_.destroy(slot);
    }
  });
  postChain(ctx, busL, busR, *io.out);
  nextFrame_ = f0 + static_cast<std::int64_t>(n);
}

void SynthInstrument::postChain(const RenderContext &ctx, float *l, float *r, Bus &out) {
  SynthShared &s = *sh_;
  const std::size_t n = kQ;
  const std::int64_t f0 = ctx.frame0;
  const double sr = ctx.sampleRate;
  const unsigned nch = stereo_ ? 2u : 1u;
  float *ch[2] = {l, r};
  if (s.useHpf) s.hpf.process(ch, nch, n, f0, sr);
  if (s.useMonoBelow) {  // voice.js monoBelow: out = M +- HPF4(S)
    float mid[kQuantum], side[kQuantum];
    for (std::size_t i = 0; i < n; ++i) {
      mid[i] = 0.5f * l[i] + 0.5f * r[i];       // 'speakers' down-mix into the mono `mid` gain (1)
      side[i] = l[i] * 0.5f + r[i] * -0.5f;     // sL (0.5) + sR (-0.5) summed into h1
    }
    float *sc[1] = {side};
    s.mbH1.process(sc, 1, n, f0, sr);
    s.mbH2.process(sc, 1, n, f0, sr);
    for (std::size_t i = 0; i < n; ++i) {
      l[i] = mid[i] + side[i];
      r[i] = mid[i] + side[i] * -1.0f;  // sNeg (gain -1)
    }
  }
  if (patch_.id == PatchId::SubBass || patch_.id == PatchId::SoftKeys) {
    if (patch_.id == PatchId::SoftKeys) s.dc.process(ch, 1, n, f0, sr);
    s.pre.process(ch, ch, 1, n, f0, sr);
    s.clip->process(ch, 1, n);
    s.post.process(ch, ch, 1, n, f0, sr);
    if (patch_.id == PatchId::SubBass) {
      s.lpf.process(ch, 1, n, f0, sr);
    } else {  // tremolo: post -> tremL / tremR (gain + LFO input) -> merger -> tremNorm
      std::memcpy(r, l, n * sizeof(float));
      connGain(s.tremL.gain(), s.cNeg, l, n, f0, sr);
      connGain(s.tremR.gain(), s.cPos, r, n, f0, sr);
      s.tremNorm.process(ch, ch, 2, n, f0, sr);
    }
  }
  s.output.process(ch, ch, nch, n, f0, sr);  // trim (IMPL.trim)
  for (unsigned c = 0; c < nch; ++c) scale(ch[c], n, 0.25f);  // addOutputCeiling: pre 1 / R
  s.ceiling->process(ch, nch, n);
  for (unsigned c = 0; c < nch; ++c) scale(ch[c], n, s.regTrim);  // gain-trims.json
  out.channels = nch;
  std::memcpy(out.ch[0], l, n * sizeof(float));
  if (nch == 2) std::memcpy(out.ch[1], r, n * sizeof(float));
  else std::memset(out.ch[1], 0, n * sizeof(float));
}

// ---- factory -----------------------------------------------------------------------------------------------------

Unit *makeSynth(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0) return nullptr;
  const auto ch = static_cast<std::size_t>(spec.channel);
  if (ch >= sizeof(spec.patch->slots) / sizeof(spec.patch->slots[0])) return nullptr;
  const SlotPatch &sp = spec.patch->slots[ch];
  const PatchDef *pd = findPatch(sp.instId);
  if (!pd) return makeSynthExtra(env, spec);  // T15 hook (null while no synth-extra module is registered)
  const std::string name =
      "inst|" + std::to_string(spec.channel) + "|synth|" + sp.instId + "|" + std::to_string(spec.instSeq);
  const double rel = std::isfinite(sp.release) && sp.release > 0 ? sp.release : 0;
  return new SynthInstrument(*pd, env.sampleRate, env.seed, name, sp.paramsJson, rel);
}

}  // namespace rig::inst
