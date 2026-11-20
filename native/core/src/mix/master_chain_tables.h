// Master chain constants and the two start-up measurements of the JS engine (app/js/engine/fx.js), computed once per
// process on the control side (never on the audio thread):
//   compMakeup()   measureCompMakeup: the catcher's automatic makeup on a -30 dBFS 1 kHz sine (linear, ~ +1.10 dB)
//   glueRefDb()    measureGlueRef: total glue gain (dB) on a 1 kHz sine at amplitude .1, amounts 0, .1, ..., 1
//   clipCurve()    fx.js clipCurve(16384): soft ceiling at -0.3 dBFS over x in [-2, 2] (rig::js math, bit-exact)
// Both measurements replay the JS OfflineAudioContext renders through the native OscillatorNode (wa::Oscillator, sine)
// and compressor (wa::DynamicsCompressor), so the cancelled makeup is the native kernel's own; tests/test_master_dsp.cpp checks them against the values the
// golden Chromium measured (tools/golden/vectors/data/compressor.txt).
#pragma once
#include <array>
#include <cstddef>

#include "dsp/compressor.h"

namespace rig::master {

inline constexpr std::size_t kClipCurveSize = 16384;
inline constexpr std::size_t kGlueGrid = 10;
inline constexpr double kGlueEngageDelay = 0.3;  // GLUE_ENGAGE_DELAY
inline constexpr double kGlueXfade = 0.03;
inline constexpr double kGlueDetachAfter = 0.04;
inline constexpr double kMonoXfade = 0.05;
inline constexpr double kSqrt2 = 1.4142135623730951;  // Math.SQRT2

/** glueSettings(a) as DynamicsCompressorNode parameters (float, as the AudioParams store them). */
wa::DynamicsCompressor::Params glueSettings(double amount);
/** The catcher: threshold -3, knee 3, ratio 12, attack 3 ms, release 250 ms. */
wa::DynamicsCompressor::Params catcherSettings();

double compMakeup();
const std::array<double, kGlueGrid + 1> &glueRefTable();
/** glueRefDb(table, a): linear interpolation in dB between the grid points. */
double glueRefDb(const std::array<double, kGlueGrid + 1> &table, double amount);
/** glueMakeup(a) = 10^(-glueRefDb(a) / 20). */
double glueMakeup(double amount);
const float *clipCurve();

/** The measurement renders, exposed for tests: makeup factor m and the dB table with an explicit rate. */
double measureCompMakeup(double sampleRate);
std::array<double, kGlueGrid + 1> measureGlueRef(double sampleRate);

}  // namespace rig::master
