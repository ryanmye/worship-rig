// The seven synth.js voice recipes (app/js/engine/synth.js IMPL[*].voice) as SynthVoice subclasses (T11). Each
// constructor builds the nodes in the JS order, so the PRNG draws (rng.pick of a phase rotation, gaussian, int,
// range) happen in the JS order too; render() runs the voice's sub-graph for one quantum and adds it into the bus.
#pragma once
#include <cstddef>

#include "inst/synth_dsp.h"
#include "inst/synth_patches.h"
#include "inst/synth_voice.h"
#include "num/prng.h"

namespace rig::inst {

/** What a voice recipe reads at note-on (InstrumentBase noteOn → impl.voice(inst, v, note, vel, t)). */
struct BuildCtx {
  const WaveBank &bank;
  Rng &rng;
  const double *p;  // resolved params, patch order
  double sr, t, vel, morph;
  int note;
  const SampleBuffer *walk;  // drone-osc random walk (instrument-level buffer)
};

/** Param indices per patch (positions in synth_patches.cpp; checked against the catalogue by the tests). */
namespace pk {
enum Warm : unsigned { wAttack, wDecay, wSustain, wRelease, wCutoff, wResonance, wLfoRate, wLfoDepth, wDetune, wSub };
enum Glass : unsigned { gAttack, gDecay, gSustain, gRelease, gCutoff, gDetune, gChorus, gBloom };
enum Strings : unsigned { sAttack, sRelease, sCutoff, sDetune, sVibRate, sVibDepth, sVibDelay };
enum Sub : unsigned { bAttack, bRelease, bCutoff, bDrive, bTri, bGlide };
enum Keys : unsigned { kDecay, kRelease, kTone, kTine, kTremolo, kTremRate, kDrive, kGlide };
enum Bell : unsigned { eAttack, eDecay, eRelease, eRatio, eIndex, eIndexDecay, eGlide };
enum Drone : unsigned { dAttack, dRelease, dCutoff, dDetune, dDrift, dUnisonDrift, dSub, dLfoRate, dLfoDepth };
}  // namespace pk

/** Index of `release` in each patch (Voice.releaseAt → onRelease → env.release(rt, inst.params.release)). */
unsigned releaseIndex(PatchId id);
/** Index of `glide`, or -1 (glidePitched: `inst.params.glide ?? 0.03`). */
int glideIndex(PatchId id);

class WarmVoice final : public SynthVoice {
 public:
  explicit WarmVoice(const BuildCtx &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator saw[5] = {wa::Oscillator(nullptr), wa::Oscillator(nullptr), wa::Oscillator(nullptr),
                           wa::Oscillator(nullptr), wa::Oscillator(nullptr)};
  wa::Oscillator sub{nullptr};
  wa::Gain subG{0.0};
  wa::Param q2{0.0};  // l2.Q (resonance)
  ConstPan pan[5];
  VoiceFilter l1, l2;
};

class GlassVoice final : public SynthVoice {
 public:
  explicit GlassVoice(const BuildCtx &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator c{nullptr}, a{nullptr}, b{nullptr}, bloom{nullptr};
  ConstPan pa, pb;
  VoiceFilter lpf;
};

class StringsVoice final : public SynthVoice {
 public:
  explicit StringsVoice(const BuildCtx &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator saw[5] = {wa::Oscillator(nullptr), wa::Oscillator(nullptr), wa::Oscillator(nullptr),
                           wa::Oscillator(nullptr), wa::Oscillator(nullptr)};
  wa::Oscillator vib{nullptr};
  wa::Gain vibG{0.0};
  ConstPan pan[5];
  VoiceFilter l1, l2;
};

class SubVoice final : public SynthVoice {
 public:
  explicit SubVoice(const BuildCtx &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator s{nullptr}, tr{nullptr}, h2{nullptr};
  wa::Gain trG{0.0};
};

class KeysVoice final : public SynthVoice {
 public:
  explicit KeysVoice(const BuildCtx &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator car{nullptr}, m1{nullptr}, tine{nullptr};
  wa::Gain m1G{0.0}, tG{0.0};
  FmDepth fm1, fmT;
  bool hasTine = false;
};

class BellVoice final : public SynthVoice {
 public:
  explicit BellVoice(const BuildCtx &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator car{nullptr}, mod{nullptr};
  wa::Gain mG{0.0};
  FmDepth fmd;
};

class DroneVoice final : public SynthVoice {
 public:
  explicit DroneVoice(const BuildCtx &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator saw[4] = {wa::Oscillator(nullptr), wa::Oscillator(nullptr), wa::Oscillator(nullptr),
                           wa::Oscillator(nullptr)};
  wa::Oscillator sub{nullptr};
  wa::Gain subG{0.0}, driftG{0.0};
  wa::BufferSource walk;
  ConstPan pan[4];
  VoiceFilter l1, l2;
};

/** Largest voice object (pool slot size). */
inline constexpr std::size_t kSynthVoiceBytes = [] {
  std::size_t m = 0;
  for (std::size_t s : {sizeof(WarmVoice), sizeof(GlassVoice), sizeof(StringsVoice), sizeof(SubVoice),
                        sizeof(KeysVoice), sizeof(BellVoice), sizeof(DroneVoice)})
    m = s > m ? s : m;
  return m;
}();

/** soft-keys ampTau(note) and caps(sr, f, i1) (synth.js 542-550). */
double keysAmpTau(int note);
void keysCaps(double sr, double f, double i1, double &c1, double &cT);

}  // namespace rig::inst
