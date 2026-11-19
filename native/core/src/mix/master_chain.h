// Master chain (UnitSlot::MasterChain): eqIn -> out. Interface FROZEN by T00b; T03 implements
// (mix/master_chain.cpp, dsp/compressor*, dsp/waveshaper*) and registers kind "master" + set handlers "fx.comp.",
// "master." ; the master EQ inside it is T02's mix/master_eq.h (set handler "fx.eq."). Replaces the builtin
// skeleton master (volume only).
//
// Contract 3.8: master EQ (LS100, PK1k Q.8, HS8k) -> glueDry | glue comp -> glueWet -> master(volume) -> masterWheel
// -> fadeGain -> stereo/mono xfade -> preComp -> catcher comp -> clipPre -> clip curve -> out (sleep ramp is T08's
// Meter/runtime concern, not here). Unit-local test points (graph/test_points.h): tap kTapEqOut (master EQ output),
// tap kTapMaster (after glue + master volume), inject kInjectPreComp; register UnitInfo{tapPoints = 0b11,
// injectPoints = 0b1}.
// Construction: from UnitSpec::patch->master (MasterPatch: eq dB, compAmount, volume), SongState::mono, and the
// RIG_FLAG_NO_GLUE / RIG_FLAG_CLIP_OVERSAMPLE_* flags in UnitEnv::config.
#pragma once
#include <cstdint>

#include "graph/unit.h"
#include "runtime/command.h"

namespace rig {

inline constexpr const char *kKindMaster = "master";

enum MasterParam : std::uint32_t {
  kMasterVolume = 0,  // the builtin skeleton master implements only this one
  kMasterWheel = 1,
  kMasterFadeGain = 2,
  kMasterEqLow = 3,
  kMasterEqMid = 4,
  kMasterEqHigh = 5,
  kMasterMonoMix = 6,  // 0 stereo .. 1 mono (50 ms linear crossfade)
  kMasterGlueDry = 7,
  kMasterGlueWet = 8,
};

enum class MasterOp : std::uint16_t {
  SetGlue = kOpBaseT03,  // a = amount (engage after 0.3 s, 30 ms crossfade; 0 = disengage)
  // T03 appends below.
};

struct UnitEnv;
struct UnitSpec;
Unit *makeMasterChain(const UnitEnv &env, const UnitSpec &spec);

}  // namespace rig
