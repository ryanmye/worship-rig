// The "instruments" service (inst/instrument_service.h).
#include "inst/instrument_service.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>

#include "api/registry.h"
#include "inst/synth.h"
#include "inst/synth_dispatch.h"
#include "model/model.h"
#include "model/patch.h"
#include "yyjson.h"

namespace rig::inst {
namespace {

constexpr const char kCatalogue[] =
#include "inst_catalogue.inc"
    ;

std::vector<CatalogueEntry> parseCatalogue() {
  std::vector<CatalogueEntry> out;
  yyjson_doc *doc = yyjson_read(kCatalogue, sizeof(kCatalogue) - 1, 0);
  if (!doc) return out;
  yyjson_val *arr = yyjson_doc_get_root(doc);
  std::size_t i, n;
  yyjson_val *e;
  yyjson_arr_foreach(arr, i, n, e) {
    CatalogueEntry ce;
    yyjson_val *ref = yyjson_obj_get(e, "ref");
    if (const char *t = yyjson_get_str(yyjson_obj_get(ref, "type"))) ce.type = t;
    if (const char *id = yyjson_get_str(yyjson_obj_get(ref, "id"))) ce.id = id;
    ce.hidden = yyjson_get_bool(yyjson_obj_get(e, "hidden"));
    std::size_t j, m;
    yyjson_val *p;
    yyjson_val *params = yyjson_obj_get(e, "params");
    yyjson_arr_foreach(params, j, m, p) {
      CatalogueParam cp;
      if (const char *k = yyjson_get_str(yyjson_obj_get(p, "key"))) cp.key = k;
      cp.min = yyjson_get_num(yyjson_obj_get(p, "min"));
      cp.max = yyjson_get_num(yyjson_obj_get(p, "max"));
      cp.def = yyjson_get_num(yyjson_obj_get(p, "default"));
      ce.params.push_back(std::move(cp));
    }
    out.push_back(std::move(ce));
  }
  yyjson_doc_free(doc);
  return out;
}

/** slots.<i>.params JSON with `key` set to `v` (JS cfg.params[key] = v). */
std::string withParam(const std::string &json, std::string_view key, double v) {
  yyjson_mut_doc *d = yyjson_mut_doc_new(nullptr);
  yyjson_doc *in = yyjson_read(json.data(), json.size(), 0);
  yyjson_mut_val *root = in ? yyjson_val_mut_copy(d, yyjson_doc_get_root(in)) : nullptr;
  if (in) yyjson_doc_free(in);
  if (!root || !yyjson_mut_is_obj(root)) root = yyjson_mut_obj(d);
  yyjson_mut_doc_set_root(d, root);
  yyjson_mut_val *k = yyjson_mut_strncpy(d, key.data(), key.size());
  yyjson_mut_obj_put(root, k, yyjson_mut_real(d, v));
  std::size_t len = 0;
  char *s = yyjson_mut_write(d, 0, &len);
  std::string out = s ? std::string(s, len) : json;
  std::free(s);
  yyjson_mut_doc_free(d);
  return out;
}

}  // namespace

std::string_view catalogueJson() {
  static const std::string minified = [] {  // cmake re-serialises the list pretty-printed: re-write it compact
    yyjson_doc *doc = yyjson_read(kCatalogue, sizeof(kCatalogue) - 1, 0);
    std::size_t len = 0;
    char *s = doc ? yyjson_write(doc, 0, &len) : nullptr;
    std::string out = s ? std::string(s, len) : std::string("[]");
    std::free(s);
    yyjson_doc_free(doc);
    return out;
  }();
  return minified;
}

const std::vector<CatalogueEntry> &catalogue() {
  static const std::vector<CatalogueEntry> c = parseCatalogue();
  return c;
}

const CatalogueEntry *findCatalogue(std::string_view type, std::string_view id) {
  for (const CatalogueEntry &e : catalogue())
    if (e.type == type && e.id == id) return &e;
  return nullptr;
}

void InstrumentServiceImpl::onCommit(const PatchSpec &patch, double) {
  const std::size_t slots = sizeof(patch.slots) / sizeof(patch.slots[0]);
  for (std::size_t i = 0; i < slots; ++i) {
    const SlotPatch &sp = patch.slots[i];
    if (!sp.present || sp.instType != "synth" || findPatch(sp.instId)) continue;
    if (isSynthExtraId(sp.instId) && synthExtraFactory()) continue;
    m_.warn("instrument 'synth:" + sp.instId + "' is not available in this build (slot " + std::to_string(i) +
                " stays silent)",
            "unsupported");
  }
}

void InstrumentServiceImpl::onRateChanged(double sampleRate) {
  // T11a O4: PeriodicWave tables are per rate. Every synth.js instrument of a live slot gets the new rate's bank;
  // its voices keep playing (oscillator phase is kept, as Chromium's SetPeriodicWave does).
  const PatchSpec &p = m_.patch();
  const std::size_t slots = std::min<std::size_t>(kChannels, sizeof(p.slots) / sizeof(p.slots[0]));
  for (std::size_t i = 0; i < slots; ++i) {
    const UnitSlot u = instSlot(i);
    if (m_.attachedKind(u) != kKindSynth || !findPatch(p.slots[i].instId)) continue;
    auto *w = new WavesPayload();
    w->bank = WaveBank::get(sampleRate, synthWaveFamilies(p.slots[i].instId));
    m_.sendOwned(u, opOf(SynthOp::SetWaves), w, -1.0);
  }
}

bool setInstrumentParam(Model &m, const SetRequest &req) {
  const std::size_t slots = sizeof(m.patch().slots) / sizeof(m.patch().slots[0]);
  if (req.slot < 0 || static_cast<std::size_t>(req.slot) >= slots) return false;
  SlotPatch &sp = m.patchMut().slots[req.slot];
  if (!sp.present) return false;  // JS _setSlotParam: no cfg -> false
  const std::size_t dot = req.path.find(".params.");
  if (dot == std::string_view::npos) return false;
  const std::string_view key = req.path.substr(dot + 8);
  const CatalogueEntry *e = findCatalogue(sp.instType, sp.instId);
  int index = -1;
  double v = req.value;
  if (e) {
    for (std::size_t k = 0; k < e->params.size(); ++k) {
      if (e->params[k].key != key) continue;
      index = static_cast<int>(k);
      if (std::isfinite(v)) v = std::min(e->params[k].max, std::max(e->params[k].min, v));
      break;
    }
  }
  sp.paramsJson = withParam(sp.paramsJson, key, v);  // cfg.params[key] = v (kept for a rebuild of the unit)
  if (index < 0) return true;  // JS: stored; the instrument warns "unknown param" and ignores it
  const UnitSlot u = instSlot(static_cast<std::size_t>(req.slot));
  if (m.attachedKind(u).empty()) return true;
  Command c{};
  c.op = Op::InstParam;
  c.aux = static_cast<std::uint32_t>(index);
  c.f.a = v;
  c.f.b = m.timeFor(req.when);
  c.f.c = req.glide;
  return m.sendUnitOp(u, c, req.when);
}

}  // namespace rig::inst
