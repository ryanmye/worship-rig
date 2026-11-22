// CORE2B: param read-back (model/param_read.h). audio.js getParam (app/js/engine/audio.js:1221) over the native
// Model's resolved patch.
#include "model/param_read.h"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>

#include "drone/drone_core.h"
#include "drone/drone_service.h"
#include "inst/instrument_service.h"
#include "mix/slot_eq.h"
#include "model/model.h"
#include "model/patch.h"
#include "num/js_number.h"
#include "params/params.h"
#include "yyjson.h"

namespace rig {
namespace {

ParamRead num(double v) {
  ParamRead r;
  r.known = true;
  if (!std::isfinite(v)) return r;  // NaN (release = the instrument's own) -> undefined, as an absent optional row
  r.defined = true;
  r.json = js::numberToString(v);
  return r;
}

ParamRead boolean(bool v) {
  ParamRead r;
  r.known = r.defined = true;
  r.json = v ? "true" : "false";
  return r;
}

ParamRead str(const std::string &s) {
  ParamRead r;
  r.known = r.defined = true;
  r.json = "\"" + s + "\"";  // enum members and 'natural': no characters that need escaping
  return r;
}

ParamRead undefinedValue() {
  ParamRead r;
  r.known = true;
  return r;
}

ParamRead enumValue(const ParamRow &row, int index) {
  const std::string name = enumName(row, index);
  return name.empty() ? undefinedValue() : str(name);
}

/** web KEY_RE (shared/params.js): /^[A-Za-z_][A-Za-z0-9_]*$/ */
bool validKey(std::string_view k) {
  if (k.empty()) return false;
  for (std::size_t i = 0; i < k.size(); ++i) {
    const char c = k[i];
    const bool alpha = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    if (!alpha && !(i > 0 && c >= '0' && c <= '9')) return false;
  }
  return true;
}

const char *rotaryName(int i) {
  return i == 0 ? "slow" : i == 1 ? "fast" : i == 2 ? "off" : nullptr;
}

/** The catalogue's `default` of `key` for the slot's instrument as a JSON literal ("" = none). The literal keeps
 *  the catalogue's own type (organ `percussion` true, `rotary` "fast"), which CatalogueParam::def (a double) loses. */
std::string catalogueDefault(const SlotPatch &sp, std::string_view key, bool *isBool) {
  const std::string_view cat = inst::catalogueJson();
  std::string out;
  yyjson_doc *doc = yyjson_read(cat.data(), cat.size(), 0);
  yyjson_val *root = doc ? yyjson_doc_get_root(doc) : nullptr;
  std::size_t i, n;
  yyjson_val *e;
  if (root && yyjson_is_arr(root)) yyjson_arr_foreach(root, i, n, e) {
      yyjson_val *ref = yyjson_obj_get(e, "ref");
      yyjson_val *t = ref ? yyjson_obj_get(ref, "type") : nullptr, *id = ref ? yyjson_obj_get(ref, "id") : nullptr;
      if (!t || !id || !yyjson_is_str(t) || !yyjson_is_str(id) || sp.instType != yyjson_get_str(t) ||
          sp.instId != yyjson_get_str(id))
        continue;
      yyjson_val *ps = yyjson_obj_get(e, "params");
      std::size_t k, m;
      yyjson_val *p;
      if (ps && yyjson_is_arr(ps)) yyjson_arr_foreach(ps, k, m, p) {
          yyjson_val *pk = yyjson_obj_get(p, "key");
          yyjson_val *d = yyjson_obj_get(p, "default");
          if (!pk || !yyjson_is_str(pk) || key != yyjson_get_str(pk) || !d || yyjson_is_null(d)) continue;
          if (isBool) *isBool = yyjson_is_bool(d);
          std::size_t len = 0;
          if (char *w = yyjson_val_write(d, 0, &len)) {
            out.assign(w, len);
            std::free(w);
          }
          break;
        }
      break;
    }
  if (doc) yyjson_doc_free(doc);
  return out;
}

/** slots.<i>.params.<key>: cfg.params[key] ?? the catalogue default of the slot's instrument. */
ParamRead instParam(const SlotPatch &sp, std::string_view key) {
  const bool rotary = sp.instType == "organ" && key == "rotary";
  bool isBool = false;
  const std::string def = catalogueDefault(sp, key, &isBool);
  ParamRead out = undefinedValue();
  if (yyjson_doc *doc = yyjson_read(sp.paramsJson.data(), sp.paramsJson.size(), 0)) {
    yyjson_val *root = yyjson_doc_get_root(doc);
    yyjson_val *v = root && yyjson_is_obj(root) ? yyjson_obj_getn(root, key.data(), key.size()) : nullptr;
    if (v && !yyjson_is_null(v)) {
      if (rotary && yyjson_is_num(v)) {  // the Model stores the enum index (W3B-4); PARAMS space = the name
        const char *nm = rotaryName(static_cast<int>(std::floor(yyjson_get_num(v) + 0.5)));
        if (nm) out = str(nm);
      } else if (isBool && yyjson_is_num(v)) {  // a boolean row the Model stored as 0 / 1 (Op::InstParam value)
        out = boolean(yyjson_get_num(v) >= 0.5);
      } else if (yyjson_is_num(v)) {  // withParam stores a real ("900.0"): JS number text, as everywhere else
        out = num(yyjson_get_num(v));
      } else {
        std::size_t len = 0;
        if (char *w = yyjson_val_write(v, 0, &len)) {
          out.defined = true;
          out.json.assign(w, len);
          std::free(w);
        }
      }
    }
    yyjson_doc_free(doc);
  }
  if (out.defined) return out;
  if (!def.empty()) {  // audio.js: registry.paramsFor(instrument).find(key)?.default
    out.defined = true;
    out.json = def;
  }
  return out;
}

/** Legacy slot EQ rows in EqLegacyRow order (mix/slot_eq.h). */
constexpr const char *kLegacy[kEqLegacyRows] = {"low",  "lowHz",  "mid1",   "mid1Hz", "mid1Q",
                                                "mid2", "mid2Hz", "mid2Q",  "high",   "highHz"};

ParamRead slotEq(const ParamRow &row, const SlotEqSpec &eq, std::string_view rest) {
  if (rest.size() > 3 && rest[0] == 'b' && rest[1] >= '1' && rest[1] <= '8' && rest[2] == '.') {
    const EqBand &b = eq.bands[rest[1] - '1'];  // resolved (fx.js resolveSlotEq(cfg.eq).bands[k][field])
    const std::string_view f = rest.substr(3);
    if (f == "on") return boolean(b.on);
    if (f == "type") return enumValue(row, b.type);
    if (f == "hz") return num(b.hz);
    if (f == "db") return num(b.db);
    if (f == "q") return num(b.q);
    return undefinedValue();
  }
  if (rest == "cutHz") return num(eq.cutHz);
  if (rest == "hiCutHz") return num(eq.hiCutHz);
  for (int l = 0; l < kEqLegacyRows; ++l)  // cfg.eq?.[row] ?? the PARAMS default
    if (rest == kLegacy[l]) return num((eq.legacyHas >> l & 1u) ? eq.legacy[l] : row.def);
  return undefinedValue();
}

ParamRead slotRow(const ParamRow &row, const SlotPatch &sp) {
  const std::string_view k = std::string_view(row.path).substr(10);  // after "slots.<i>."
  if (k.substr(0, 3) == "eq.") return slotEq(row, sp.spec.eq, k.substr(3));
  if (k == "gain") return num(sp.gain);
  if (k == "pan") return num(sp.pan);
  if (k == "octave") return num(sp.octave);
  if (k == "transpose") return num(sp.transpose);
  if (k == "lowNote") return num(sp.spec.lowNote);
  if (k == "highNote") return num(sp.spec.highNote);
  if (k == "sustain") return boolean(sp.sustain);
  if (k == "bendEnabled") return boolean(sp.bendEnabled);
  if (k == "mono") return enumValue(row, sp.mono);
  if (k == "velocityCurve") return enumValue(row, sp.velocityCurve);
  if (k == "sends.reverb") return num(sp.sends[0]);
  if (k == "sends.delay") return num(sp.sends[1]);
  if (k == "sends.chorus") return num(sp.sends[2]);
  if (k == "width") return num(sp.width);
  if (k == "release") return num(sp.release);  // NaN = absent = undefined
  if (k == "pedalHold") return sp.pedalHold > 0 ? num(sp.pedalHold) : str("natural");
  if (k == "touch.shape") return num(sp.touch.shape);
  if (k == "touch.min") return num(sp.touch.min);
  if (k == "touch.max") return num(sp.touch.max);
  if (k == "touch.top") return num(sp.touch.top);
  return undefinedValue();
}

ParamRead globalRow(Model &m, const ParamRow &row) {
  const PatchSpec &p = m.patch();
  const std::string_view k(row.path);
  if (k.substr(0, 6) == "drone.") {
    // drone.js getParam(key) = this.p[key] of the live drone; before the drone exists, the patch's copy
    if (auto *ds = dynamic_cast<drone::DroneServiceImpl *>(m.service<DroneService>()))
      if (const drone::DroneCore *d = ds->core()) {
        const double v = d->getParam(k.substr(6));
        if (std::isfinite(v)) return num(v);
      }
    const DronePatch &d = p.drone;
    if (k == "drone.gain") return num(d.gain);
    if (k == "drone.width") return num(d.width);
    if (k == "drone.brightness") return num(d.brightness);
    if (k == "drone.movement") return num(d.movement);
    if (k == "drone.fade") return num(d.fade);
    return undefinedValue();
  }
  if (k == "master.volume") return num(p.master.volume);
  if (k == "fx.reverb.size") return num(p.reverb.size);
  if (k == "fx.reverb.damp") return num(p.reverb.damp);
  if (k == "fx.reverb.predelay") return num(p.reverb.predelay);
  if (k == "fx.reverb.returnGain") return num(p.reverb.returnGain);
  if (k == "fx.delay.time") return num(p.delay.time);
  if (k == "fx.delay.sync") return enumValue(row, p.delay.sync);
  if (k == "fx.delay.feedback") return num(p.delay.feedback);
  if (k == "fx.delay.pingpong") return boolean(p.delay.pingpong);
  if (k == "fx.delay.tone") return num(p.delay.tone);
  if (k == "fx.delay.returnGain") return num(p.delay.returnGain);
  if (k == "fx.chorus.rate") return num(p.chorus.rate);
  if (k == "fx.chorus.depth") return num(p.chorus.depth);
  if (k == "fx.chorus.returnGain") return num(p.chorus.returnGain);
  if (k == "fx.lofi.amount") return num(p.lofi.amount);
  if (k == "fx.lofi.wow") return num(p.lofi.wow);
  if (k == "fx.lofi.flutter") return num(p.lofi.flutter);
  if (k == "fx.lofi.crackle") return num(p.lofi.crackle);
  if (k == "fx.lofi.bits") return num(p.lofi.bits);
  if (k == "fx.lofi.tone") return num(p.lofi.tone);
  if (k == "fx.lofi.saturation") return num(p.lofi.saturation);
  if (k == "fx.eq.low") return num(p.master.eqLow);
  if (k == "fx.eq.mid") return num(p.master.eqMid);
  if (k == "fx.eq.high") return num(p.master.eqHigh);
  if (k == "fx.comp.amount") return num(p.master.compAmount);
  return undefinedValue();
}

}  // namespace

ParamRead readParam(Model &m, std::string_view path) {
  int slot = -1;
  bool dynamic = false;
  const ParamRow *row = findParam(path, &slot, &dynamic);
  if (dynamic) {
    const std::size_t dot = path.find(".params.");
    const std::string_view key = dot == std::string_view::npos ? std::string_view() : path.substr(dot + 8);
    if (!validKey(key) || slot < 0 || slot >= kMaxSlots) return ParamRead{};
    const SlotPatch &sp = m.patch().slots[slot];
    return sp.present ? instParam(sp, key) : undefinedValue();  // audio.js: no cfg -> undefined
  }
  if (!row) return ParamRead{};
  if (std::strncmp(row->path, "slots.<i>.", 10) == 0) {
    if (slot < 0 || slot >= kMaxSlots) return ParamRead{};
    const SlotPatch &sp = m.patch().slots[slot];
    return sp.present ? slotRow(*row, sp) : undefinedValue();
  }
  return globalRow(m, *row);
}

}  // namespace rig
