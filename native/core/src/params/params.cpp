#include "params/params.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace rig {
#include "params/params_gen.inc"

const ParamRow *paramRows() {
  return kParamRows;
}
std::size_t paramCount() {
  return RIG_PARAM_COUNT;
}
const char *smoothingText(int idx) {
  return idx >= 0 && idx < RIG_SMOOTHING_COUNT ? kSmoothingText[idx] : "";
}

const ParamRow *findParam(std::string_view path, int *slot, bool *dynamic) {
  if (dynamic) *dynamic = false;
  std::string norm(path);
  // INTERFACE-CHANGE(T00c) D3: slots.<i> with i = 0..15 (decimal, no leading zero; was 0..3).
  // engine-api.json params.grammar.path.
  std::size_t digits = 0;
  int si = -1;
  if (path.size() > 8 && path.compare(0, 6, "slots.") == 0) {
    if (path[6] >= '0' && path[6] <= '9' && path[7] == '.') {
      digits = 1;
      si = path[6] - '0';
    } else if (path.size() > 9 && path[6] == '1' && path[7] >= '0' && path[7] <= '5' && path[8] == '.') {
      digits = 2;
      si = 10 + (path[7] - '0');
    }
  }
  if (digits) {
    if (slot) *slot = si;
    norm = "slots.<i>." + std::string(path.substr(7 + digits));
    if (norm.compare(0, 17, "slots.<i>.params.") == 0 && norm.size() > 17) {
      if (dynamic) *dynamic = true;
      return nullptr;
    }
  }
  const ParamRow *lo = kParamRows;
  const ParamRow *hi = kParamRows + RIG_PARAM_COUNT;
  const ParamRow *it = std::lower_bound(
      lo, hi, norm, [](const ParamRow &r, const std::string &k) { return std::strcmp(r.path, k.c_str()) < 0; });
  return (it != hi && norm == it->path) ? it : nullptr;
}

double clampNumber(const ParamRow &row, double v) {
  if (!std::isfinite(v)) return row.def;
  if (!std::isnan(row.min)) v = std::max(v, row.min);
  if (!std::isnan(row.max)) v = std::min(v, row.max);
  if (row.step == 1.0) v = std::floor(v + 0.5);
  return v;
}

int enumIndex(const ParamRow &row, std::string_view name) {
  std::string_view all(row.enums);
  int idx = 0;
  while (true) {
    const std::size_t bar = all.find('|');
    if (all.substr(0, bar) == name) return idx;
    if (bar == std::string_view::npos) return -1;
    all.remove_prefix(bar + 1);
    ++idx;
  }
}

std::string enumName(const ParamRow &row, int index) {
  std::string_view all(row.enums);
  for (int i = 0;; ++i) {
    const std::size_t bar = all.find('|');
    if (i == index) return std::string(all.substr(0, bar));
    if (bar == std::string_view::npos) return {};
    all.remove_prefix(bar + 1);
  }
}

}  // namespace rig
