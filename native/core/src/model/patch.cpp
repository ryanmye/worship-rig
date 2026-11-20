#include "model/patch.h"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>

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

// ---- table of the PARAMS rows that live in the resolved patch (storeRow + parsePatch) -------------------------------
using Setter = void (*)(PatchSpec &, int slot, double v);
struct Field {
  const char *row;
  Setter set;
};
#define SLOTF(row, expr) {row, [](PatchSpec &p, int s, double v) { SlotPatch &sp = p.slots[s]; expr; }}
#define GLOBF(row, expr) {row, [](PatchSpec &p, int, double v) { expr; }}
const Field kFields[] = {
    SLOTF("slots.<i>.gain", sp.gain = v),
    SLOTF("slots.<i>.pan", sp.pan = v),
    SLOTF("slots.<i>.octave", sp.octave = static_cast<int>(v)),
    SLOTF("slots.<i>.transpose", sp.transpose = static_cast<int>(v)),
    SLOTF("slots.<i>.lowNote", sp.spec.lowNote = static_cast<int>(v)),
    SLOTF("slots.<i>.highNote", sp.spec.highNote = static_cast<int>(v)),
    SLOTF("slots.<i>.sustain", sp.sustain = v != 0),
    SLOTF("slots.<i>.bendEnabled", sp.bendEnabled = v != 0),
    SLOTF("slots.<i>.mono", sp.mono = static_cast<int>(v)),
    SLOTF("slots.<i>.velocityCurve", sp.velocityCurve = static_cast<int>(v)),
    SLOTF("slots.<i>.sends.reverb", sp.sends[0] = v),
    SLOTF("slots.<i>.sends.delay", sp.sends[1] = v),
    SLOTF("slots.<i>.sends.chorus", sp.sends[2] = v),
    SLOTF("slots.<i>.width", sp.width = v),
    SLOTF("slots.<i>.release", sp.release = v),
    SLOTF("slots.<i>.touch.shape", sp.touch.shape = v),
    SLOTF("slots.<i>.touch.min", sp.touch.min = v),
    SLOTF("slots.<i>.touch.max", sp.touch.max = v),
    SLOTF("slots.<i>.touch.top", sp.touch.top = v),
    GLOBF("fx.reverb.size", p.reverb.size = v),
    GLOBF("fx.reverb.damp", p.reverb.damp = v),
    GLOBF("fx.reverb.predelay", p.reverb.predelay = v),
    GLOBF("fx.reverb.returnGain", p.reverb.returnGain = v),
    GLOBF("fx.delay.time", p.delay.time = v),
    GLOBF("fx.delay.sync", p.delay.sync = static_cast<int>(v)),
    GLOBF("fx.delay.feedback", p.delay.feedback = v),
    GLOBF("fx.delay.pingpong", p.delay.pingpong = v != 0),
    GLOBF("fx.delay.tone", p.delay.tone = v),
    GLOBF("fx.delay.returnGain", p.delay.returnGain = v),
    GLOBF("fx.chorus.rate", p.chorus.rate = v),
    GLOBF("fx.chorus.depth", p.chorus.depth = v),
    GLOBF("fx.chorus.returnGain", p.chorus.returnGain = v),
    GLOBF("fx.lofi.amount", p.lofi.amount = v),
    GLOBF("fx.lofi.wow", p.lofi.wow = v),
    GLOBF("fx.lofi.flutter", p.lofi.flutter = v),
    GLOBF("fx.lofi.crackle", p.lofi.crackle = v),
    GLOBF("fx.lofi.bits", p.lofi.bits = v),
    GLOBF("fx.lofi.tone", p.lofi.tone = v),
    GLOBF("fx.lofi.saturation", p.lofi.saturation = v),
    GLOBF("fx.eq.low", p.master.eqLow = v),
    GLOBF("fx.eq.mid", p.master.eqMid = v),
    GLOBF("fx.eq.high", p.master.eqHigh = v),
    GLOBF("fx.comp.amount", p.master.compAmount = v),
    GLOBF("master.volume", p.master.volume = v),
    GLOBF("drone.gain", p.drone.gain = v),
    GLOBF("drone.width", p.drone.width = v),
    GLOBF("drone.brightness", p.drone.brightness = v),
    GLOBF("drone.movement", p.drone.movement = v),
    GLOBF("drone.fade", p.drone.fade = v),
};
#undef SLOTF
#undef GLOBF

/** JSON value at a dotted path below `obj` (no array indices). */
yyjson_val *at(const yyjson_val *obj, std::string_view path) {
  yyjson_val *v = const_cast<yyjson_val *>(obj);
  while (v && !path.empty()) {
    if (!yyjson_is_obj(v)) return nullptr;
    const std::size_t dot = path.find('.');
    const std::string key(path.substr(0, dot));
    v = yyjson_obj_get(v, key.c_str());
    path = dot == std::string_view::npos ? std::string_view() : path.substr(dot + 1);
  }
  return v;
}

/** Defaults of every table row, then the values present in the patch JSON (contract 2.2 shape). */
void applyTable(const yyjson_val *patch, PatchSpec &out) {
  yyjson_val *slots = at(patch, "slots");
  for (const Field &f : kFields) {
    const ParamRow *row = findParam(f.row);
    const std::string_view rp(f.row);
    if (rp.substr(0, 10) == "slots.<i>.") {
      for (int i = 0; i < kMaxSlots; ++i) {  // INTERFACE-CHANGE(T00c) D3: was 4
        SlotPatch &sp = out.slots[i];
        if (!sp.present) continue;
        if (row && !std::isnan(row->def)) f.set(out, i, row->def);
        yyjson_val *so = slots && yyjson_is_arr(slots) ? yyjson_arr_get(slots, static_cast<std::size_t>(i)) : nullptr;
        double d;
        if (row && so && yyjson_is_obj(so)) {
          yyjson_val *v = at(so, rp.substr(10));
          if (v && !yyjson_is_null(v) && jsonToParamValue(*row, v, d)) f.set(out, i, d);
          if (rp == "slots.<i>.touch.shape" && at(so, "touch")) sp.hasTouch = true;
        }
      }
      continue;
    }
    if (row && !std::isnan(row->def)) f.set(out, -1, row->def);
    if (rp.substr(0, 6) == "drone.") continue;  // song.drone, not in the patch
    const std::string jp = rp == "master.volume" ? std::string("fx.master.volume") : std::string(rp);
    double d;
    yyjson_val *v = at(patch, jp);
    if (row && v && jsonToParamValue(*row, v, d)) f.set(out, -1, d);
  }
}

std::string toJsonText(const yyjson_val *v) {
  if (!v) return "{}";
  size_t len = 0;
  char *s = yyjson_val_write(const_cast<yyjson_val *>(v), 0, &len);
  std::string out = s ? std::string(s, len) : "{}";
  std::free(s);
  return out;
}

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

// INTERFACE-CHANGE(T02): the slot EQ is resolved by mix/slot_eq.cpp (fx.js resolveSlotEq incl. the legacy
// low/mid/high rows and the stored-row bookkeeping later `set`s need); was: b-rows only.
void parseEq(const yyjson_val *eq, SlotEqSpec &spec) {
  parseSlotEqJson(eq, spec);
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
  std::string routing;
  for (const char *k : {"modWheel", "expression", "volume", "bend", "swell"})
    if (yyjson_val *rv = yyjson_obj_get(p, k))
      routing += (routing.empty() ? "\"" : ",\"") + std::string(k) + "\":" + toJsonText(rv);
  out.routingJson = "{" + routing + "}";
  if (!slots || !yyjson_is_arr(slots)) {  // an empty patch is valid (no slots)
    applyTable(p, out);
    return true;
  }
  // INTERFACE-CHANGE(T00c) D3: 1..16 slots (was: entries past 4 ignored). More than 16 is a bad request.
  if (yyjson_arr_size(slots) > static_cast<std::size_t>(kMaxSlots)) {
    if (err) *err = "patch.slots has more than 16 entries";
    return false;
  }
  out.slotCount = static_cast<int>(yyjson_arr_size(slots));
  std::size_t idx, max;
  yyjson_val *s;
  yyjson_arr_foreach(slots, idx, max, s) {
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
    sp.paramsJson = toJsonText(yyjson_obj_get(s, "params"));
    yyjson_val *ph = yyjson_obj_get(s, "pedalHold");
    if (ph && yyjson_is_num(ph)) sp.pedalHold = std::fmin(30.0, std::fmax(2.0, yyjson_get_num(ph)));
  }
  applyTable(p, out);
  return true;
}

bool storeRow(PatchSpec &p, std::string_view rowPath, int slot, double value) {
  for (const Field &f : kFields) {
    if (rowPath != f.row) continue;
    const bool perSlot = rowPath.substr(0, 10) == "slots.<i>.";
    if (perSlot && (slot < 0 || slot >= kMaxSlots)) return false;  // INTERFACE-CHANGE(T00c) D3: was > 3
    f.set(p, perSlot ? slot : -1, value);
    return true;
  }
  return false;
}

}  // namespace rig
