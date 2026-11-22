// voice.js resolveParams for the T15 instruments (inst/synth_extra_host.h). Control thread.
#include "inst/synth_extra_host.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <string>

#include "yyjson.h"

namespace rig::inst {

void resolveParamsJson(const ParamDef *defs, std::size_t n, std::string_view json, double *out,
                       int (*enumOf)(std::size_t, std::string_view)) {
  for (std::size_t i = 0; i < n; ++i) out[i] = defs[i].def;
  if (json.empty()) return;
  yyjson_doc *doc = yyjson_read(json.data(), json.size(), 0);
  if (!doc) return;
  yyjson_val *root = yyjson_doc_get_root(doc);
  if (yyjson_is_obj(root)) {
    for (std::size_t i = 0; i < n; ++i) {
      yyjson_val *v = yyjson_obj_get(root, defs[i].key);
      if (!v) continue;
      const bool isEnum = std::string_view(defs[i].unit) == "enum";
      const bool isBool = std::string_view(defs[i].unit) == "bool";
      if (isEnum) {  // coerceParam: a listed string, a finite number -> round + clamp index, else the default
        int k = enumOf && yyjson_is_str(v) ? enumOf(i, yyjson_get_str(v)) : -1;
        if (yyjson_is_num(v) && std::isfinite(yyjson_get_num(v)))
          k = static_cast<int>(std::lround(std::max(defs[i].min, std::min(defs[i].max, yyjson_get_num(v)))));
        if (k >= 0) out[i] = k;
        continue;
      }
      if (isBool) {  // coerceParam: boolean, number >= .5, 'true' / 'on' / '1', else the default
        if (yyjson_is_bool(v)) out[i] = yyjson_get_bool(v) ? 1 : 0;
        else if (yyjson_is_num(v)) out[i] = yyjson_get_num(v) >= 0.5 ? 1 : 0;
        else if (yyjson_is_str(v)) {
          std::string s(yyjson_get_str(v));
          for (char &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
          out[i] = s == "true" || s == "on" || s == "1" ? 1 : 0;
        }
        continue;
      }
      double x = NAN;
      if (yyjson_is_num(v)) x = yyjson_get_num(v);
      else if (yyjson_is_bool(v)) x = yyjson_get_bool(v) ? 1 : 0;
      else if (yyjson_is_str(v)) x = std::strtod(yyjson_get_str(v), nullptr);
      else if (yyjson_is_null(v)) x = 0;  // Number(null) = 0
      out[i] = coerceParamValue(defs[i], x);
    }
  }
  yyjson_doc_free(doc);
}

}  // namespace rig::inst
