// PARAMS table (generated from native/contract/engine-api.json, 102 rows) and the clamp/normalise rules.
#pragma once
#include <cmath>
#include <cstddef>
#include <string>
#include <string_view>

namespace rig {

struct ParamRow {
  const char *path;     // "slots.<i>.gain", "fx.reverb.size", "master.volume", ...
  int kind;             // 0 number, 1 bool, 2 enum
  double def, min, max, step;  // NAN where absent (bool/enum have no range)
  bool log;
  const char *enums;    // "a|b|c" for enum rows, else ""
  const char *coalesce; // coalescing key or nullptr
  int smoothing;        // index into smoothingText()
};

const ParamRow *paramRows();
std::size_t paramCount();
const char *smoothingText(int idx);

/**
 * Look a concrete path up ("slots.2.eq.b4.hz" -> row "slots.<i>.eq.b4.hz", *slot = 2). Dynamic
 * "slots.<i>.params.<key>" paths return nullptr and set *dynamic. Unknown paths return nullptr.
 */
const ParamRow *findParam(std::string_view path, int *slot = nullptr, bool *dynamic = nullptr);

/** contract 2.1 clamp for numbers: NaN -> default, clamp to [min, max], round when step is 1. */
double clampNumber(const ParamRow &row, double v);
/** Enum member index of `name`, -1 when it is not a member. */
int enumIndex(const ParamRow &row, std::string_view name);
std::string enumName(const ParamRow &row, int index);

}  // namespace rig
