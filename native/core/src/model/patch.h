// Patch parsing (contract 2.2 patch -> RESOLVED structs). FROZEN layout (T00b): units are constructed from these
// structs (api/registry.h UnitSpec::patch), so a field is added only through the orchestrator. Every numeric field
// holds the PARAMS-clamped value (bool 0/1, enum = member index), defaults from the PARAMS table.
#pragma once
#include <cmath>
#include <string>
#include <string_view>

#include "mix/slot_spec.h"

struct yyjson_val;

namespace rig {

struct ParamRow;

struct TouchPatch {
  double shape = 1, min = 0, max = 1, top = 127;
};

struct SlotPatch {
  bool present = false;
  std::string instType, instId;
  double gain = 0.8, pan = 0.0;
  int octave = 0, transpose = 0;
  bool sustain = true, bendEnabled = true;
  int mono = 0;           // enum index of slots.<i>.mono (off|lowest|highest)
  int velocityCurve = 1;  // enum index of slots.<i>.velocityCurve
  double sends[3] = {0, 0, 0};  // reverb, delay, chorus (graph/unit.h SendBus order)
  double width = 1.0;
  double release = NAN;    // NaN = instrument's own release
  double pedalHold = 0.0;  // 0 = 'natural', else seconds
  TouchPatch touch;
  bool hasTouch = false;
  std::string paramsJson = "{}";  // slots.<i>.params as JSON text (instrument-specific; T11/T12/T15 parse it)
  SlotSpec spec;                  // lowNote/highNote, EQ spec, test-voice kind (T00 skeleton fields)
};

struct ReverbPatch {
  double size = 0.5, damp = 0.5, predelay = 0.02, returnGain = 1;
};
struct DelayPatch {
  double time = 0.375;
  int sync = 0;  // enum index of fx.delay.sync (off|1/4|1/8d|1/8)
  double feedback = 0.35;
  bool pingpong = false;
  double tone = 0.5, returnGain = 1;
};
struct ChorusPatch {
  double rate = 0.4, depth = 0.5, returnGain = 1;
};
struct LofiPatch {
  double amount = 0, wow = 0.5, flutter = 0.5, crackle = 0.3, bits = 0.5, tone = 0.5, saturation = 0.5;
};
struct MasterPatch {
  double eqLow = 0, eqMid = 0, eqHigh = 0;  // fx.eq.{low,mid,high} dB
  double compAmount = 0;                    // fx.comp.amount
  double volume = 0.5011872336272722;       // master.volume
};
struct DronePatch {  // drone.* rows (song.drone config; contract 3.9)
  double gain = 0.5011872336272722, width = 0.7, brightness = 0.5, movement = 0.3, fade = 4;
};

/** Sound slots per song (DECISIONS D3; = graph kChannels = RIG_MAX_SLOTS) and the web engine's fixed count. */
inline constexpr int kMaxSlots = 16, kWebSlots = 4;

struct PatchSpec {
  // INTERFACE-CHANGE(T00c) D3: 16 slots (was 4). `slotCount` = entries of the patch's `slots` array (0..16; null
  // entries count, they are empty slots). The skeleton commit keeps max(slotCount, 4) channels, like the web
  // engine's fixed 4, so 4-slot songs render exactly as before.
  SlotPatch slots[kMaxSlots];
  int slotCount = 0;
  ReverbPatch reverb;
  DelayPatch delay;
  ChorusPatch chorus;
  LofiPatch lofi;
  MasterPatch master;
  DronePatch drone;
  std::string routingJson = "{}";  // {modWheel, expression, volume, bend, swell} as normalised JSON (T13/T14)
};

/** Song-level state outside the patch (contract 1.3 `song` op). */
struct SongState {
  int transpose = 0;
  double tempo = 0;  // bpm; 0 = none
  int sigNum = 4, sigDen = 4;
  int keyPc = -1;  // -1 = no key context
  bool keyMinor = false;
  bool mono = false;
  // INTERFACE-CHANGE(T07): setTimeSig(sig, {newBar}) (controller.js song switch): true only while the Model runs
  // forEachService(onSongState) for that call, false at every other time (T07 review O2).
  bool newBar = false;
};

/** Resolve a JSON patch object against the PARAMS defaults and clamps. False + err on a non-object patch. */
bool parsePatch(const yyjson_val *patch, PatchSpec &out, std::string *err);

/** Convert a JSON value to the row's numeric domain (bool/enum rows included); false when it has no usable form. */
bool jsonToParamValue(const ParamRow &row, const yyjson_val *v, double &out);

/**
 * Store a clamped row value into the resolved patch (Model::set does this before any module handler runs).
 * `rowPath` is the PARAMS row ("slots.<i>.sends.reverb"), `slot` its slot index or -1. False when the row has no
 * field here (dynamic instrument params, legacy EQ rows: handled by their module).
 */
bool storeRow(PatchSpec &p, std::string_view rowPath, int slot, double value);

}  // namespace rig
