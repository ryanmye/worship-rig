// SynthInstrument: kind "inst.synth" for the seven synth.js patches (app/js/engine/synth.js IMPL, over voice.js
// InstrumentBase / Voice / makeEnv / TrackedParam / FmDepth / monoBelow / addOutputCeiling), T11. Every node of the
// JS graph is rendered with the Chromium 157.0.8103.78 semantics the goldens were made with (oscillators and
// sources: T11a; biquads: T02 kernels + inst/synth_dsp.h VoiceFilter; panner; WaveShaper: T03), in the same PRNG draw
// order (rngFor(seed, "inst|<slot>|synth|<id>|<instSeq>").fork(), then the patch's own draws per voice), with the
// same AudioParam calls in the same order (time/automation.h). Each voice is rendered every quantum from its note-on
// until its sources have stopped (T11a O3: process() is never skipped on a started source), then torn down.
// Module opcodes (T11 range, Command::target = the instrument slot):
#pragma once
#include <cstdint>
#include <memory>
#include <string_view>

#include "api/registry.h"
#include "dsp/biquad.h"
#include "dsp/buffer_source.h"
#include "dsp/constant_source.h"
#include "dsp/gain.h"
#include "dsp/oscillator.h"
#include "dsp/waveshaper.h"
#include "graph/unit.h"
#include "inst/instrument.h"
#include "inst/synth_dsp.h"
#include "inst/synth_patches.h"
#include "inst/synth_voices.h"
#include "inst/voice_alloc.h"
#include "num/prng.h"
#include "runtime/command.h"

namespace rig::inst {

inline constexpr const char *kKindSynth = "inst.synth";

enum class SynthOp : std::uint16_t {
  Morph = kOpBaseT11,  // f.a = morph 0..1, f.b = when (s): InstrumentBase.morph (macro.morph, T14)
  SetWaves,            // sub = kSubOwnedPayload, p.ptr = WavesPayload*: wavetables for a new sample rate (O4)
  ReleaseOverride,     // f.a = seconds to -60 dB for later note-offs (slots.<i>.release; <= 0 = the patch's own)
};

/** SynthOp::SetWaves payload: the bank travels in an Owned so the old one is freed on the control thread. */
struct WavesPayload final : Owned {
  std::shared_ptr<const WaveBank> bank;
};

struct SynthShared;

class SynthInstrument final : public Instrument {
 public:
  /** Control thread. `paramsJson` = slots.<i>.params (overrides, JS resolveParams); `rngSeedName` the rngFor name. */
  SynthInstrument(const PatchDef &patch, double sampleRate, std::uint32_t engineSeed, std::string_view rngName,
                  std::string_view paramsJson, double releaseOverride);
  ~SynthInstrument() override;

  void noteOn(int note, int vel, float velGain, std::int64_t frame) override;
  void noteOff(int note, std::int64_t frame, bool forced) override;
  void allNotesOff(std::int64_t frame) override;
  void kill() override;
  void setBend(double semis, std::int64_t frame) override;
  void legatoTo(int from, int to, std::int64_t frame, double glide) override;
  void setParam(std::uint32_t index, double value, double time, double glide) override;
  void releaseVoice(VoiceId id, std::int64_t frame, double fadeSec) override;
  unsigned outputChannels() const override { return stereo_ ? 2u : 1u; }
  void setVoiceCap(unsigned cap) override { pool_.setCap(clampVoiceCap(cap)); }

  void process(const RenderContext &ctx, UnitIO &io) override;
  void setSampleRate(double sr) override { sr_ = sr; }
  std::uint32_t liveVoices() const override { return pool_.live(); }

  // ---- introspection (tests) ----
  const PatchDef &patch() const { return patch_; }
  double paramValue(std::size_t index) const { return params_[index]; }
  unsigned voiceCap() const { return pool_.cap(); }
  std::uint64_t steals() const { return pool_.steals(); }
  /** Voices counted against the cap (held + released). */
  unsigned playingVoices() const { return pool_.playing(); }
  /** Held or released voices playing `note`. */
  unsigned playingNote(int note) const;
  /** Id of the newest held / released voice of `note` (0xffffffff if none). */
  VoiceId voiceIdOf(int note) const;

  /** Morph (InstrumentBase.morph) at engine time t. */
  void morph(double x, double t);

 protected:
  void applyModule(const Command &c) override;

 private:
  double timeOf(std::int64_t frame) const;
  double atTime(double when) const;  // voice.js atTime: max(when, currentTime)
  void releaseSlot(int slot, double t);
  void fadeSlot(int slot, double t, double fadeSec);
  void applyPatchParam(std::size_t index, double value, double t);
  void renderBus(const RenderContext &ctx, float *l, float *r);
  void postChain(const RenderContext &ctx, float *l, float *r, Bus &out);
  void setWaves(const WaveBank &bank);
  void emitEnded(const RenderContext &ctx, int slot);

  const PatchDef &patch_;
  double sr_;
  bool stereo_;
  Rng rng_;
  double params_[16] = {};
  double morphX_ = 0, releaseOverride_ = 0;
  std::int64_t nextFrame_ = 0;  // first frame of the quantum being / about to be rendered ("currentTime")
  bool killAll_ = false;
  std::uint64_t killSeq_ = 0;  // kill() hits the voices constructed up to here, not a note-on of the same quantum
  static constexpr unsigned kMaxGarbage = 8;
  Owned *garbage_[kMaxGarbage] = {};  // payloads handed back at the next process() (giveBack needs the context)
  unsigned garbageN_ = 0;
  static constexpr unsigned kMaxPendingEnded = 16;
  VoiceId pendingEnded_[kMaxPendingEnded] = {};  // voices evicted at note-on (pool full of fading voices)
  unsigned pendingEndedN_ = 0;
  std::shared_ptr<const WaveBank> bank_;
  std::unique_ptr<SynthShared> sh_;
  VoicePool<SynthVoice, kVoicePoolSize + kVoiceSpare, kSynthVoiceBytes> pool_;
};

/** Registry factory for "inst.synth": synth.js patches here, synth-extra ids through inst/synth_dispatch.h. */
Unit *makeSynth(const UnitEnv &env, const UnitSpec &spec);
/** Wave families a synth.js patch id needs (kWaveAll for an unknown id). */
unsigned synthWaveFamilies(std::string_view id);

}  // namespace rig::inst
