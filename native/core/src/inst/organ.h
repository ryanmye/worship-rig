// OrganInstrument (T15): organ.js OrganInstrument, kind "inst.organ" (the Model attaches "inst." + instrument.type).
// Graph (app/js/engine/organ.js): voices (one drawbar PeriodicWave oscillator at f/2, shared Hammond percussion,
// key click) -> bus (+ click band-pass) -> drive pre -> tanh WaveShaper -> post -> {dry | two-rotor rotary: 800 Hz
// Butterworth crossover, horn = modulated DelayNode + AM, drum = AM, L/R mics = sin / cos LFOs on one speed
// ConstantSource each} -> output (PRESET_TRIM) -> addOutputCeiling -> registry trim (gain-trims.json organ[id]).
// Chromium 157.0.8103.78 node semantics as the synth-extra port (inst/synth_extra_dsp.h). PRNG: rngFor(seed,
// "inst|<slot>|organ|<id>|<instSeq>").fork(); the 4 key-click bursts draw at construction (clickBuffers), then per
// note rng.int(0, 7) (wave rotation) and rng.pick(clicks).
// Module opcodes (T15 range, Command::target = the instrument slot): OrganOp::Morph (the Leslie half-moon switch,
// InstrumentBase.morph), OrganOp::ReleaseOverride (slots.<i>.release). The Model sends SynthOp / SamplerOp versions
// to those kinds only; the matching Model change for "inst.organ" is listed in the T15 report.
#pragma once
#include <cstdint>
#include <memory>
#include <string_view>
#include <vector>

#include "api/registry.h"
#include "dsp/buffer_source.h"
#include "dsp/gain.h"
#include "dsp/oscillator.h"
#include "inst/synth_extra_dsp.h"
#include "inst/synth_extra_host.h"
#include "runtime/command.h"

namespace rig {
class Model;
struct SlotPatch;
}  // namespace rig

namespace rig::inst {

inline constexpr const char *kKindOrgan = "inst.organ";

enum class OrganOp : std::uint16_t {
  Morph = kOpBaseT15,  // f.a = morph 0..1, f.b = when (s)
  ReleaseOverride,     // f.a = seconds to -60 dB for later note-offs (<= 0 = the preset's own)
};

enum class OrganPreset : unsigned { Gospel, SoftPad, Full, Church, Count };
inline constexpr std::size_t kOrganPresetCount = static_cast<std::size_t>(OrganPreset::Count);

struct OrganPresetDef {
  OrganPreset id;
  const char *name, *idStr;
  const ParamDef *params;  // drawbar1..9, percussion, click, drive, rotary (enum index slow|fast|off), release
  std::size_t nParams;
  double presetTrim;  // PRESET_TRIM[id] (output gain)
  double trimDb;      // gain-trims.json organ[id]
};
const OrganPresetDef &organPresetDef(OrganPreset id);
const OrganPresetDef *findOrganPreset(std::string_view id);
/** resolveParams of a preset from slots.<i>.params JSON (drawbars rounded: step 1). Control thread. */
void organParams(const OrganPresetDef &p, std::string_view json, double *out);
/** drawbarWaves(ctx, bars): the registration as 8 phase-rotated PeriodicWaves (disableNormalization). */
void drawbarWaves(const double *bars, double sr, WaveArray &out);
/** T15 review item 1: the index of enum value `s` of param `key` of the slot's instrument (Model::set: the Edit view
 *  sends enum params as their names). organ `rotary`: slow / fast / off, an unlisted name = the preset's default
 *  (voice.js coerceParam). -1 = not an enum param of this instrument (the request is dropped). */
int instEnumIndex(const SlotPatch &sp, std::string_view key, std::string_view s);
/** T15 review item 3: a `slots.<i>.params.drawbar*` change of an organ slot (instrument_service.cpp
 *  setInstrumentParam). organ.js _scheduleWave: one rebuild per 30 ms burst (the first change at engine time `when`
 *  arms it), then drawbarWaves() of the slot's current params on the control thread and T15Op::SetTables with only
 *  `drawbars` set (the unit re-points its live voices). Control thread; the state is the "t15-tables" service's. */
void organDrawbarsChanged(Model &m, int slot, double when);

/** organ.js param indices. */
namespace ok {
enum : unsigned { kDrawbar1 = 0, kPercussion = 9, kClick, kDrive, kRotary, kRelease, kCount };
enum Rotary : unsigned { kSlow = 0, kFast = 1, kOff = 2 };
}  // namespace ok

/** What the organ voice reads at note-on. */
struct OrganBuild {
  const std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> &waves;
  const WaveBank &bank;  // sines (sineWaves: 8 rotations)
  double t, percLevel;
  int note;
  unsigned rot;
  const SampleBuffer *click;  // null = no key click (click param 0)
};

class OrganVoice final : public XVoice {
 public:
  explicit OrganVoice(const OrganBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator o{nullptr}, perc{nullptr};
  wa::Gain pg{0.0};
  wa::BufferSource click;
  bool hasPerc = false, hasClick = false;
  unsigned rot = 0;
};

inline constexpr std::size_t kOrganVoiceBytes = sizeof(OrganVoice);

struct OrganShared;

class OrganInstrument final : public XHost<kOrganVoiceBytes> {
 public:
  OrganInstrument(const OrganPresetDef &preset, double sampleRate, std::uint32_t engineSeed, std::string_view rngName,
                  std::string_view paramsJson, double releaseOverride);
  ~OrganInstrument() override;
  const OrganPresetDef &preset() const { return preset_; }
  /** Tests: the rate the horn DelayNodes run at (T15 review item 4) and the drawbar table of rotation 0. */
  double hornDelayRate() const;
  const wa::PeriodicWave *drawbarWave0() const;

 protected:
  void applyModule(const Command &c) override;
  void buildVoice(int note, double vel, double t) override;
  double releaseParam() const override { return params_[ok::kRelease]; }
  void glide(XVoice &v, int note, double t) override;
  void applyParam(std::uint32_t key, double v, double t) override;
  void onMorph(double t) override;
  void postChain(const XIn &in, float *l, float *r, Bus &out) override;
  void sharedPass(XIn &in) override;

 private:
  bool keyDownAt(double t);
  double percLevel(double t);
  int rotaryTarget() const;  // ok::kSlow / kFast, -1 = off
  void setRotarySpeed(int speed, double t);
  void setDrive(double t);
  void syncOversample();

  const OrganPresetDef &preset_;
  std::shared_ptr<const WaveBank> bank_;
  std::shared_ptr<const XWaveBank> xbank_;
  std::unique_ptr<OrganShared> sh_;
  double percT_ = -1e300;  // shared percussion envelope: last trigger time (-Infinity)
  int rotarySpeed_ = ok::kSlow;
};

/** Registry factory for "inst.organ". */
Unit *makeOrgan(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig::inst
