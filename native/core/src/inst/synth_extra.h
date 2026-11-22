// SynthExtraInstrument (T15): the ten synth-extra.js patches (app/js/engine/synth-extra.js PATCHES / IMPL) under
// instrument type "synth", built through T11's "inst.synth" dispatch hook (inst/synth_dispatch.h; no new kind).
// Every node of the JS graph is rendered with Chromium 157.0.8103.78 semantics (oscillators, sources: T11a; biquads:
// T02 kernels via inst/synth_extra_dsp.h XFilter; DelayNode: T05's kernel via XDelay; WaveShaper: T03), in the JS
// PRNG draw order (rngFor(seed, "inst|<slot>|synth|<id>|<instSeq>").fork(), then each recipe's draws per voice).
// Module opcodes: the T11 SynthOp range (the Model sends SynthOp::Morph / ReleaseOverride to every "inst.synth"
// unit; SetWaves is never sent to synth-extra units).
#pragma once
#include <cstdint>
#include <memory>
#include <string_view>

#include "api/registry.h"
#include "dsp/biquad.h"
#include "dsp/constant_source.h"
#include "dsp/gain.h"
#include "dsp/oscillator.h"
#include "dsp/waveshaper.h"
#include "inst/synth_extra_dsp.h"
#include "inst/synth_extra_host.h"
#include "inst/synth_extra_voices.h"

namespace rig::inst {

struct XShared;

class SynthExtraInstrument final : public XHost<kExtraVoiceBytes> {
 public:
  /** Control thread. `paramsJson` = slots.<i>.params; `rngName` the rngFor name. */
  SynthExtraInstrument(const XPatchDef &patch, double sampleRate, std::uint32_t engineSeed, std::string_view rngName,
                       std::string_view paramsJson, double releaseOverride);
  ~SynthExtraInstrument() override;

  const XPatchDef &patch() const { return patch_; }
  /** Tests: the rate the shared chorus DelayNodes run at (T15 review item 4); 0 = the patch has no chorus. */
  double chorusDelayRate() const;

 protected:
  void applyModule(const Command &c) override;
  void buildVoice(int note, double vel, double t) override;
  double releaseParam() const override;
  void glide(XVoice &v, int note, double t) override;
  void applyParam(std::uint32_t key, double v, double t) override;
  void onMorph(double t) override;
  void sharedPass(XIn &in) override;
  void postChain(const XIn &in, float *l, float *r, Bus &out) override;
  void voiceDestroyed(int slot) override;

 private:
  double filterOffsetCents() const;
  void updateFilterMod(double t);
  void setChorus(double amount, double t);
  void setWidth(double t);
  void setDrive808(double t);
  void redecayPluck(double t);
  void resustainBrass(double t);
  double q2Poly() const;
  float *delayBuffer(int slot);

  const XPatchDef &patch_;
  std::shared_ptr<const WaveBank> bank_;
  std::shared_ptr<const XWaveBank> xbank_;
  std::unique_ptr<XShared> sh_;
  // PWM DelayNode buffers (juno-pad, square-lead): one per pool slot, sized for the lowest note at this rate
  std::unique_ptr<float[]> delayArena_;
  std::size_t delayStride_ = 0;
};

/** Registry factory behind the inst.synth hook: nullptr for an id that is not a synth-extra patch. */
Unit *makeSynthExtraUnit(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig::inst
