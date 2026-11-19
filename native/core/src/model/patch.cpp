#include "model/patch.h"

#include <cmath>
#include <cstring>

#include "params/params.h"
#include "yyjson.h"

namespace rig {

bool jsonToParamValue(const ParamRow &row, const yyjson_val *v, double &out) {
  if (!v) return false;
  if (row.kind == 1) {  // bool: booleans, numbers >= .5, true/on/1
    if (yyjson_is_bool(const_cast<yyjson_val *>(v)))
      out = yyjson_get_bool(const_cast<yyjson_val *>(v)) ? 1 : 0;
    else if (yyjson_is_num(const_cast<yyjson_val *>(v)))
      out = yyjson_get_num(const_cast<yyjson_val *>(v)) >= 0.5;
    else if (yyjson_is_str(const_cast<yyjson_val *>(v))) {
      const char *s = yyjson_get_str(const_cast<yyjson_val *>(v));
      out = (!std::strcmp(s, "true") || !std::strcmp(s, "on") || !std::strcmp(s, "1")) ? 1 : 0;
    } else
      return false;
    return true;
  }
  if (row.kind == 2) {  // enum: member name or rounded index
    yyjson_val *mv = const_cast<yyjson_val *>(v);
    if (yyjson_is_str(mv)) {
      const int i = enumIndex(row, yyjson_get_str(mv));
      out = i < 0 ? row.def : i;
      return i >= 0;
    }
    if (yyjson_is_num(mv)) {
      out = std::floor(yyjson_get_num(mv) + 0.5);
      return true;
    }
    return false;
  }
  yyjson_val *mv = const_cast<yyjson_val *>(v);
  if (yyjson_is_num(mv))
    out = clampNumber(row, yyjson_get_num(mv));
  else if (yyjson_is_bool(mv))
    out = clampNumber(row, yyjson_get_bool(mv) ? 1 : 0);
  else if (yyjson_is_str(mv)) {
    char *end = nullptr;
    const double d = std::strtod(yyjson_get_str(mv), &end);
    out = clampNumber(row, (end && *end == 0 && end != yyjson_get_str(mv)) ? d : NAN);
  } else if (yyjson_is_null(mv))
    out = row.def;
  else
    return false;
  return true;
}

namespace {

double rowDefault(const char *path) {
  const ParamRow *r = findParam(path);
  return r ? r->def : 0.0;
}

double numField(const yyjson_val *obj, const char *key, const char *rowPath, double fallback) {
  yyjson_val *v = yyjson_obj_get(const_cast<yyjson_val *>(obj), key);
  const ParamRow *r = rowPath ? findParam(rowPath) : nullptr;
  double out = fallback;
  if (v && r && jsonToParamValue(*r, v, out)) return out;
  if (v && !r && yyjson_is_num(v)) return yyjson_get_num(v);
  return r && !v ? r->def : fallback;
}

void parseEq(const yyjson_val *eq, SlotEqSpec &spec) {
  spec = SlotEqSpec{};
  for (int k = 1; k <= kEqBands; ++k) {
    char p[48];
    EqBand &b = spec.bands[k - 1];
    std::snprintf(p, sizeof p, "slots.0.eq.b%d.on", k);
    b.on = rowDefault(p) != 0.0;
    std::snprintf(p, sizeof p, "slots.0.eq.b%d.type", k);
    b.type = static_cast<int>(rowDefault(p));
    std::snprintf(p, sizeof p, "slots.0.eq.b%d.hz", k);
    b.hz = rowDefault(p);
    std::snprintf(p, sizeof p, "slots.0.eq.b%d.db", k);
    b.db = rowDefault(p);
    std::snprintf(p, sizeof p, "slots.0.eq.b%d.q", k);
    b.q = rowDefault(p);
    if (!eq) continue;
    char key[8];
    std::snprintf(key, sizeof key, "b%d", k);
    yyjson_val *bo = yyjson_obj_get(const_cast<yyjson_val *>(eq), key);
    if (!bo || !yyjson_is_obj(bo)) continue;  // legacy low/mid/high rows: not read in T00
    const char *fields[] = {"on", "type", "hz", "db", "q"};
    for (const char *f : fields) {
      yyjson_val *fv = yyjson_obj_get(bo, f);
      if (!fv) continue;
      std::snprintf(p, sizeof p, "slots.0.eq.b%d.%s", k, f);
      const ParamRow *row = findParam(p);
      double d;
      if (!row || !jsonToParamValue(*row, fv, d)) continue;
      if (!std::strcmp(f, "on"))
        b.on = d != 0.0;
      else if (!std::strcmp(f, "type"))
        b.type = static_cast<int>(d);
      else if (!std::strcmp(f, "hz"))
        b.hz = d;
      else if (!std::strcmp(f, "db"))
        b.db = d;
      else
        b.q = d;
    }
  }
  spec.cutHz = numField(eq, "cutHz", "slots.0.eq.cutHz", rowDefault("slots.0.eq.cutHz"));
  spec.hiCutHz = numField(eq, "hiCutHz", "slots.0.eq.hiCutHz", rowDefault("slots.0.eq.hiCutHz"));
}

}  // namespace

bool parsePatch(const yyjson_val *patch, PatchSpec &out, std::string *err) {
  out = PatchSpec{};
  yyjson_val *p = const_cast<yyjson_val *>(patch);
  if (!p || !yyjson_is_obj(p)) {
    if (err) *err = "patch must be an object";
    return false;
  }
  yyjson_val *slots = yyjson_obj_get(p, "slots");
  if (!slots || !yyjson_is_arr(slots)) return true;  // an empty patch is valid (no slots)
  std::size_t idx, max;
  yyjson_val *s;
  yyjson_arr_foreach(slots, idx, max, s) {
    if (idx >= 4) break;
    if (!yyjson_is_obj(s)) continue;
    SlotPatch &sp = out.slots[idx];
    sp.present = true;
    yyjson_val *inst = yyjson_obj_get(s, "instrument");
    if (inst && yyjson_is_obj(inst)) {
      yyjson_val *t = yyjson_obj_get(inst, "type"), *id = yyjson_obj_get(inst, "id");
      if (t && yyjson_is_str(t)) sp.instType = yyjson_get_str(t);
      if (id && yyjson_is_str(id)) sp.instId = yyjson_get_str(id);
    }
    sp.gain = numField(s, "gain", "slots.0.gain", rowDefault("slots.0.gain"));
    sp.pan = numField(s, "pan", "slots.0.pan", rowDefault("slots.0.pan"));
    SlotSpec &sc = sp.spec;
    sc.lowNote = static_cast<int>(numField(s, "lowNote", "slots.0.lowNote", rowDefault("slots.0.lowNote")));
    sc.highNote = static_cast<int>(numField(s, "highNote", "slots.0.highNote", rowDefault("slots.0.highNote")));
    parseEq(yyjson_obj_get(s, "eq"), sc.eq);
    if (sp.instType == "test") {
      sc.inst = sp.instId == "saw" ? InstKind::TestSaw : InstKind::TestSine;
      yyjson_val *pr = yyjson_obj_get(s, "params");
      if (pr && yyjson_is_obj(pr)) {
        sc.attack = numField(pr, "attack", nullptr, sc.attack);
        sc.decay = std::fmax(1e-3, numField(pr, "decay", nullptr, sc.decay));
        sc.sustain = numField(pr, "sustain", nullptr, sc.sustain);
        sc.release = std::fmax(1e-3, numField(pr, "release", nullptr, sc.release));
      }
    }
    // Other instrument types are accepted and stay silent until the instrument tasks (T11+) land.
  }
  return true;
}

}  // namespace rig
