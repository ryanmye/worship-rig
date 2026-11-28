// Sampler instrument (M11, T12): port of `SamplerInstrument` (app/js/engine/sampler.js) as the unit kind
// "inst.sampler". Per voice, the Web Audio graph of sampler.js noteOn, node for node:
//   AudioBufferSourceNode (wa::BufferSource: playbackRate 2^((n - sample)/12), detune = bend x 100)
//   -> [single-layer sets only: lowpass 2000·6^v01 Hz, Butterworth (Q in dB)]
//   -> env GainNode (channelCount 2 explicit: a dual-mono 1-channel buffer is up-mixed to two identical channels)
// all voices -> tone lowpass (500·40^clamp(tone + 0.3·morph) Hz, Nyquist = exact bypass) -> output GainNode
// (manifest gainTrim) -> the strip. Output is always stereo (contract 3.1: the stereo pan law).
// Envelope (instruments.js BasicVoice): setNow(gain) at the note, release = rampTo(0, τ = release·6.9/6.9) and
// stop at +1.3·release·6.9; `undampedFrom` voices ignore note-off; steal / allNotesOff / releaseVoice = fadeOut
// (rampTo τ = fade/6.9, stop at +1.3·fade).
//
// Samples come from the "cache" service (T06) through the "sampler" service (sampler_service.h): the factory takes
// what is decoded (offline: everything, inline), requests the rest, and later sends a complete zone table with
// SamplerOp::Zones. Nothing on the audio thread allocates, locks or frees: zone tables come and go as Owned payloads.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/buffer_source.h"
#include "dsp/gain.h"
#include "inst/instrument.h"
#include "inst/voice_alloc.h"
#include "model/buffer_cache_api.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindSampler = "inst.sampler";

/** Module opcodes (T12 range). Sent to the instrument's unit slot. */
enum class SamplerOp : std::uint16_t {
  /** p.ptr = SamplerZones* (sub = kSubOwnedPayload), aux = the instrument's instSeq: replaces the zone table (the
   *  old one goes back as Garbage). A table for another instSeq goes straight back. */
  Zones = kOpBaseT12,
  /** f.a = slots.<i>.release in seconds to −60 dB (contract 2.3 "read at release"); <= 0 / NaN = the instrument's
   *  own release. Read by every later note-off (audio.js _release sets voice.releaseOverride). Frame = when. */
  ReleaseOverride,
  /** f.a = morph 0..1 (audio.js _applyMorph: bend in morph mode, intensity on pad-like slots), f.b = time:
   *  tone frequency rampTo over τ 30 ms (sampler.js morph). */
  Morph,
  /** f.a = settings.dynamicRange 1..kDynRangeMax (velocityDb): read per note-on. */
  DynamicRange,
};

// INTERFACE-CHANGE(TOUCH): DECISIONS D43, shared/touch-curve.js DYN_RANGE.max (was 3) and DYN_SPAN_MAX_DB: multi-layer
// samplers reach 60 dB at 6; no span passes 72 dB (single layer stops at range 3, its pre-D43 maximum)
inline constexpr double kDynRangeMax = 6.0;
inline constexpr double kDynSpanMaxDb = 72.0;

/** Instrument params (Instrument::setParam index = the def's params order: release, tone). */
enum SamplerParam : std::uint32_t { kSamplerRelease = 0, kSamplerTone = 1, kSamplerParamCount = 2 };
/** `slots.<i>.params.<key>` → index, -1 when the sampler has no such param. */
int samplerParamIndex(std::string_view key);

/** The JS SAMPLER_MAX_VOICES (sampler.js:756) was 32; DECISIONS D1: per-slot cap 32 | 64 | 128, default 64. Voices
 *  live in T11's inst::VoicePool (128 + 32 spare slots for steal fades; BasicAllocator policy: any released voice
 *  first, else the oldest held). */
inline constexpr unsigned kSamplerPoolVoices = inst::kVoicePoolSize, kSamplerDefaultCap = inst::kDefaultVoiceCap;

class SamplerLeases;

/** Immutable zone table: the decoded layers of one instrument instance (sampler.js `this.layers` after _load: empty
 *  layers dropped, samples sorted by midi). Holds one cache reference per buffer, released on destruction
 *  (control thread only). */
struct SamplerZones : Owned {
  struct Sample {
    int midi = 60;
    const SampleBuffer *buf = nullptr;
  };
  struct Layer {
    int lo = 0, hi = 127;
    std::vector<Sample> samples;
  };
  std::vector<Layer> layers;
  std::uint32_t instSeq = 0;
  std::shared_ptr<SamplerLeases> leases;  // null: the buffers carry no references (tests)
  ~SamplerZones() override;
};

/** Static facts of a sampler def (resolved manifest entry) the unit needs. */
struct SamplerSetup {
  bool multiLayer = false;  // def.layers.length > 1 (from the manifest, not from what loaded)
  double gainTrimDb = 0;
  int undampedFrom = -1;  // -1 = off
  double release = 0.12;  // τ (s): param default
  double tone = 1;        // param default
  double releaseOverride = 0;  // slots.<i>.release at build time (s to −60 dB, 0 = the instrument's own)
  std::uint32_t instSeq = 0;
};

class SamplerInstrument final : public Instrument {
 public:
  /** `zones` may be null or partial (filled later by SamplerOp::Zones). */
  SamplerInstrument(const SamplerSetup &s, SamplerZones *zones, double sampleRate);
  ~SamplerInstrument() override;

  // Unit
  void process(const RenderContext &ctx, UnitIO &io) override;
  void setSampleRate(double sr) override;
  std::uint32_t liveVoices() const override { return pool_.live(); }

  // Instrument
  void noteOn(int note, int vel, float velGain, std::int64_t frame) override;
  void noteOff(int note, std::int64_t frame, bool forced) override;
  void allNotesOff(std::int64_t frame) override;
  void kill() override;
  void setBend(double semis, std::int64_t frame) override;
  void setParam(std::uint32_t index, double value, double time, double glide) override;
  void releaseVoice(VoiceId id, std::int64_t frame, double fadeSec) override;
  void fadeNote(int note, std::int64_t frame, double seconds) override;  // INTERFACE-CHANGE(T14) O-W3-1
  unsigned outputChannels() const override { return 2; }
  void setVoiceCap(unsigned cap) override;
  /** D4: voices counted against the caps (held + released). */
  unsigned playingVoices() const override { return pool_.playing(); }
  /** D4: the pool's steal candidate (BasicAllocator policy: any released voice first). */
  bool oldestVoice(bool released, std::int64_t frame, double &at, VoiceId &id) override;

  // Control-side reads (tests; before attach or after the graph gave the unit back)
  double paramValue(std::uint32_t index) const { return index == kSamplerRelease ? release_ : tone_; }
  double toneHz() const;
  unsigned voiceCap() const { return pool_.cap(); }
  /** Voices in each state (tests: polyphony / steal checks). */
  struct Counts {
    unsigned held = 0, released = 0, killed = 0;
  };
  Counts counts() const;
  /** Voice id of the most recent note-on (0 = none yet). */
  VoiceId lastVoice() const { return lastId_; }
  const SamplerZones *zones() const { return zones_; }

 protected:
  void applyModule(const Command &c) override;

 private:
  /** The voice's own nodes; state, note, start / release times and the id live in the pool (inst::VoicePool). */
  struct Voice {
    explicit Voice(const SampleBuffer *b) : src(b) {}
    wa::BufferSource src;
    wa::Gain env{0.0};
    wa::Biquad lp[2];
    bool useLp = false;
    double stopAt = 0;
    double release = 0.2;        // s to −60 dB (BasicVoice.release)
    double releaseOverride = 0;  // s to −60 dB, 0 = unset (sustain: slots.<i>.release)
    bool ignoreRelease = false;
  };
  using Pool = inst::VoicePool<Voice>;

  double timeOf(std::int64_t frame);
  void prepParams(Voice &v);
  void releaseAt(int slot, double t);
  void fadeOut(int slot, double t, double fadeSec);
  void stopVoice(int slot, double t);
  double nowSec() const { return static_cast<double>(frame0_) / sr_; }
  void rampTone(double t, double tau);
  void deferGarbage(Owned *p);

  SamplerSetup setup_;
  SamplerZones *zones_ = nullptr;
  Pool pool_{inst::StealPolicy::AnyReleased};
  double sr_;
  std::int64_t frame0_ = 0;  // first frame of the quantum being rendered / last rendered (param context time)
  double release_, tone_, morph_ = 0, bend_ = 0, dynRange_ = 1, relOverride_ = 0;
  float trim_;
  VoiceId lastId_ = 0;
  wa::BiquadFilter toneLp_;
  Owned *garbage_[8] = {};  // payloads to give back at the next process() (apply has no RenderContext)
  unsigned garbageN_ = 0;
  bool rendered_ = false;
};

}  // namespace rig
