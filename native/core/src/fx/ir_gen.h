// Reverb impulse-response generator: a bit-exact port of app/js/engine/fx.js `irGen` (fx.js:342-387) and its helpers
// (`reverbBucket`, `dampQ`, `biquadCoefs`, `irBandChunk`, Reverb.irKey / _seedFor). Contract 3.4 "IR algorithm".
//
// Bit-exactness: every JS double operation is reproduced in the same order with rig::js math (V8 15.7 Math.*, T01)
// and `-ffp-contract=off`; every store into the JS Float32Array rounds to float exactly where JS does (`out[i] +=`,
// the fade-in `*=`, the early taps, the low shelf output, the final normalisation). Verified against an IR dump from
// the golden Chromium (tools/golden/vectors/dump-reverb.mjs -> data/reverb-ir.txt, tests/test_reverb.cpp).
// Control thread / IR worker only (allocates the output).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace rig::fx {

inline constexpr double kIrBuckets[7] = {1.5, 2, 2.8, 3.8, 5, 6.5, 8};  // IR_BUCKETS (s)
inline constexpr double kIrEnergy = 0.35;                               // IR_ENERGY (per channel)

/** reverbBucket(size): size 0..1 -> RT seconds (size x 9 s) quantised to the nearest bucket in the log domain. */
double reverbBucket(double size);
/** dampQ(d) = Math.round(clamp(d, 0, 1) * 10) / 10. */
double dampQ(double damp);
/** Reverb.irKey(): `${reverbBucket(size)}|${dampQ(damp)}|${sampleRate}` (JS String(n) formatting). */
std::string irKey(double size, double damp, double sampleRate);
/** Reverb._seedFor(key) = hashSeed(`${engineSeed >>> 0}|ir|${key}`). */
std::uint32_t irSeed(std::uint32_t engineSeed, const std::string &key);
/** IR length in frames for (bucket seconds, damp): ceil(1.1 * max(rt) * sr). */
std::size_t irLength(double sampleRate, double sizeSec, double damp);

struct IrChannels {
  std::vector<float> ch[2];
  std::size_t length() const { return ch[0].size(); }
};

/** Draw source: any callable returning the next double in [0, 1) (createRng().next or a test LCG). */
struct IrRandom {
  virtual double next() = 0;

 protected:
  ~IrRandom() = default;
};

/** irGen(sr, next, sizeSec, damp): the two normalised channels (sizeSec is a bucket value; damp is the raw 0..1). */
IrChannels generateIr(double sampleRate, IrRandom &rng, double sizeSec, double damp);

/** The engine's IR for a patch: bucket/dampQ/seed from (size, damp, engine seed) exactly as Reverb.getIR(). */
IrChannels engineIr(double sampleRate, std::uint32_t engineSeed, double size, double damp);

}  // namespace rig::fx
