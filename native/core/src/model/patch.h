// Patch parsing (SPEC section 2 patch -> resolved structs). T00 skeleton: slots (instrument, gain, pan, eq b-rows,
// cut rows, test-voice params); fx/master/routing rows are validated by the PARAMS table but not stored yet.
#pragma once
#include <string>

#include "mix/slot_spec.h"

struct yyjson_val;

namespace rig {

struct SlotPatch {
  bool present = false;
  std::string instType, instId;
  double gain = 0.8, pan = 0.0;
  SlotSpec spec;
};

struct PatchSpec {
  SlotPatch slots[4];
};

/** Resolve a JSON patch object against the PARAMS defaults and clamps. False + err on a non-object patch. */
bool parsePatch(const yyjson_val *patch, PatchSpec &out, std::string *err);

/** Convert a JSON value to the row's numeric domain (bool/enum rows included); false when it has no usable form. */
struct ParamRow;
bool jsonToParamValue(const ParamRow &row, const yyjson_val *v, double &out);

}  // namespace rig
