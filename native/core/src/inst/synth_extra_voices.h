// synth-extra.js patch tables (PATCHES, catalogue order) and the IMPL[*].voice recipes as XVoice subclasses (T15).
// Each constructor builds the nodes in the JS order, so the PRNG draws happen in the JS order too; render() runs the
// voice's sub-graph for one quantum and adds it into the instrument bus. Line references: app/js/engine/synth-extra.js.
#pragma once
#include <cstddef>
#include <string_view>

#include "dsp/gain.h"
#include "dsp/oscillator.h"
#include "inst/synth_extra_dsp.h"
#include "inst/synth_extra_host.h"
#include "num/prng.h"

namespace rig::inst {

enum class XPatch : unsigned {
  SupersawPad, JunoPad, ShimmerPad, DxEpiano, Pluck, PolyStab, AnalogBrass, SquareLead, Sub808, SynthBass, Count
};
inline constexpr std::size_t kXPatchCount = static_cast<std::size_t>(XPatch::Count);

struct XPatchDef {
  XPatch id;
  const char *name, *idStr, *group;
  const ParamDef *params;
  std::size_t nParams;
  double gainTrim;  // PATCHES[].gainTrim (dB, applied inside the instrument)
  double trimDb;    // gain-trims.json synth[id] (registry `_trim`)
  double level;     // IMPL[id].level
};
const XPatchDef &xpatchDef(XPatch id);
const XPatchDef *findXPatch(std::string_view id);

/** Param indices per patch (positions in the PATCHES lists; checked against the catalogue by the tests). */
namespace xk {
enum Supersaw : unsigned { ssAttack, ssDecay, ssSustain, ssRelease, ssCutoff, ssResonance, ssDetune, ssWidth, ssSub };
enum Juno : unsigned { jAttack, jDecay, jSustain, jRelease, jCutoff, jResonance, jPwmRate, jPwmDepth, jChorus,
                       jChorusRate, jSub };
enum Shimmer : unsigned { shAttack, shDecay, shSustain, shRelease, shCutoff, shDetune, shOctave, shBloomTime,
                          shTremRate, shTremDepth };
enum Dx : unsigned { dxDecay, dxRelease, dxTone, dxTine, dxDetune, dxChorus, dxGlide };
enum Pluck : unsigned { plDecay, plRelease, plCutoff, plResonance, plSquare, plDetune, plGlide };
enum Poly : unsigned { poAttack, poDecay, poSustain, poRelease, poCutoff, poResonance, poEnvAmount, poDetune, poGlide };
enum Brass : unsigned { brAttack, brDecay, brSustain, brRelease, brCutoff, brEnvAmount, brFilterAttack, brDetune,
                        brVibDepth, brVibRate, brVibDelay, brGlide };
enum Lead : unsigned { leAttack, leRelease, leCutoff, leResonance, lePwm, leSub, leGlide, leVibDepth, leVibRate,
                       leVibDelay };
enum Sub : unsigned { suDecay, suRelease, suDrive, suPitchDrop, suDropTime, suGlide };
enum Bass : unsigned { baAttack, baDecay, baSustain, baRelease, baCutoff, baResonance, baEnvAmount, baSquare, baGlide };
}  // namespace xk

/** What a recipe reads at note-on. */
struct XBuild {
  const WaveBank &bank;
  const XWaveBank &xb;
  Rng &rng;
  const double *p;
  double sr, t, vel, morph, now;  // now = ctx.currentTime (start of the quantum being rendered next)
  int note;
  float *delayBuf;                // PWM delay buffer of this pool slot (juno-pad, square-lead)
  std::size_t delayCap;           // its capacity in floats
  double envCents = 0, q2 = 0, dxBright = 1, dxTine = 1;  // patch helpers computed by the instrument
};

/** One saw / square / shimmer oscillator source with its table kind for rate changes (XWaveBank tables are not
 *  re-pointed: synth-extra units keep their tables across a rate change, as T11 O3 notes). */
void xosc(SynthVoice &v, wa::Oscillator &o, const wa::PeriodicWave *w, double freq, double detune, double t);

/** lpfPair: two lowpass biquads (linear Q .5412 / q2 as dB), both linkFilter'ed (k-rate, filterCS on detune). */
struct LpfPair {
  XFilter a, b;
  void init(double freq, double q2, wa::Param *fa = nullptr, wa::Param *qb = nullptr, wa::Param *fb = nullptr,
            wa::Param *da = nullptr, wa::Param *db = nullptr);
  void process(float *const *ch, unsigned nch, const VoiceIn &in);
};

class Sub808Voice final : public XVoice {
 public:
  explicit Sub808Voice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator o{nullptr};
};

class PluckVoice final : public XVoice {
 public:
  explicit PluckVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator saw{nullptr}, sq{nullptr};
  wa::Gain sqG{0.0};
  wa::Param fa{0.0}, fb{0.0}, qb{0.0};  // l1 / l2 frequency (decay sweep), l2 Q (resonance)
  LpfPair lp;
};

class BassVoice final : public XVoice {
 public:
  explicit BassVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator saw{nullptr}, sq{nullptr};
  wa::Gain sqG{0.0};
  wa::Param da{0.0}, db{0.0}, qb{0.0};  // l1 / l2 detune (filter envelope), l2 Q
  LpfPair lp;
};

class PolyVoice final : public XVoice {
 public:
  explicit PolyVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator s1{nullptr}, s2{nullptr}, sq{nullptr};
  ConstPan p1, p2;
  wa::Param da{0.0}, db{0.0}, qb{0.0};
  LpfPair lp;
};

class BrassVoice final : public XVoice {
 public:
  explicit BrassVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  double onRelease(double rt, double envR, double paramR) override;
  wa::Oscillator saw[3] = {wa::Oscillator(nullptr), wa::Oscillator(nullptr), wa::Oscillator(nullptr)};
  ConstPan pan[3];
  wa::Gain vibG{0.0};
  XFilter hpf;
  wa::Param da{0.0}, db{0.0};
  LpfPair lp;
  double vel = 0, attackEnd = 0;
};

class LeadVoice final : public XVoice {
 public:
  explicit LeadVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator saw{nullptr}, sub{nullptr};
  wa::Gain periodG{1.0}, subG{0.0}, vibG{0.0};
  XDelay dl;
  wa::Param qb{0.0};
  LpfPair lp;
};

class JunoVoice final : public XVoice {
 public:
  explicit JunoVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  wa::Oscillator saw{nullptr}, sub{nullptr};
  wa::Gain periodG{1.0}, subG{0.0};
  XDelay dl;
  XFilter hpf;
  wa::Param qb{0.0};
  LpfPair lp;
};

class SupersawVoice final : public XVoice {
 public:
  explicit SupersawVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  static constexpr double kOffs[7] = {0, -1.0 / 3, 1.0 / 3, -2.0 / 3, 2.0 / 3, -1, 1};
  static constexpr int kSides[7] = {2, 0, 1, 1, 0, 0, 1};  // 0 = L, 1 = R, 2 = both
  wa::Oscillator saw[7] = {wa::Oscillator(nullptr), wa::Oscillator(nullptr), wa::Oscillator(nullptr),
                           wa::Oscillator(nullptr), wa::Oscillator(nullptr), wa::Oscillator(nullptr),
                           wa::Oscillator(nullptr)};
  double jit[7] = {};
  wa::Oscillator sub{nullptr};
  wa::Gain subG{0.0};
  XFilter hpf;
  wa::Param qb{0.0};
  LpfPair lp;
};

class ShimmerVoice final : public XVoice {
 public:
  explicit ShimmerVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  double onRelease(double rt, double envR, double paramR) override;
  wa::Oscillator c{nullptr}, a{nullptr}, b{nullptr}, oct{nullptr};
  ConstPan pa, pb;
  wa::Gain octEnv{0.0}, octLvl{0.0};
  XFilter hpf, lpf;
  double bloom = 3;
};

class DxVoice final : public XVoice {
 public:
  explicit DxVoice(const XBuild &b);
  void render(const VoiceIn &in, float *l, float *r) override;
  struct Stack {
    wa::Oscillator car{nullptr}, mod{nullptr};
    wa::Gain modG{0.0}, brightG{0.0};
  };
  Stack A, B, T;
  wa::Gain bG{0.6}, tEnv{0.0};
  bool hasTine = false;
  double i1 = 0;
};

/** Largest voice object (pool slot size). */
inline constexpr std::size_t kExtraVoiceBytes = [] {
  std::size_t m = 0;
  for (std::size_t s : {sizeof(Sub808Voice), sizeof(PluckVoice), sizeof(BassVoice), sizeof(PolyVoice),
                        sizeof(BrassVoice), sizeof(LeadVoice), sizeof(JunoVoice), sizeof(SupersawVoice),
                        sizeof(ShimmerVoice), sizeof(DxVoice)})
    m = s > m ? s : m;
  return m;
}();

/** pwmMaxDelay(f) = clamp(2.2 / f, .004, 1). */
double pwmMaxDelay(double f);

}  // namespace rig::inst
