// CORE2B: param read-back (contract `get param`, engine.getParam; PARITY "UI parity" row 1, UIC O4).
//
// The value the Model holds for one concrete PARAMS path, in the value space of app/js/shared/params.js PARAMS
// (numbers, booleans, enum member names, 'natural'), exactly what audio.js getParam(path) reads from its own patch:
//   - slot rows: the committed song's slot (`Model::patch()`, which Model::set updates at call time, W3A T13 O2),
//     undefined for an empty slot; slot EQ b-rows / cutHz / hiCutHz = the resolved value (fx.js resolveSlotEq: a band
//     without b-rows reads the legacy rows), legacy rows = the stored value or the PARAMS default;
//   - `slots.<i>.params.<key>`: the stored instrument param, else the catalogue default for the slot's instrument
//     (organ `rotary` as its name), else undefined;
//   - fx.*, master.volume: the patch; drone.*: the live drone's value (drone.js getParam), else the patch's.
// Control thread only (reads Model state).
#pragma once
#include <string>
#include <string_view>

namespace rig {

class Model;

struct ParamRead {
  bool known = false;    // false: not a PARAMS path (bridge error `unknown-param`)
  bool defined = false;  // false: audio.js answers undefined (empty slot, no stored / default value)
  std::string json;      // the value as a JSON literal when defined
};

/** Read `path` (e.g. "slots.1.gain", "fx.reverb.size", "slots.0.params.drawbar1"). */
ParamRead readParam(Model &m, std::string_view path);

}  // namespace rig
