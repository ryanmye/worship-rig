// The "instruments" service (T11; model/services.h InstrumentService): `get instruments` = the engine-api.json
// catalogue (embedded at build time by inst/catalogue.cmake), the per-instrument param tables behind the
// `slots.<i>.params.<key>` set handler (key -> Op::InstParam index = position in the catalogue entry's `params`), the
// 'unsupported' warning for synth ids no module builds, and the wavetable re-point of synth.js instruments after a
// device rate change (SynthOp::SetWaves, T11a O4).
#pragma once
#include <string>
#include <string_view>
#include <vector>

#include "model/services.h"

namespace rig {
class Model;
struct SetRequest;
struct SlotPatch;  // W3A: resolveInstrumentParam
}  // namespace rig

namespace rig::inst {

/** The catalogue JSON (an array), exactly engine-api.json `instruments.list`. */
std::string_view catalogueJson();

struct CatalogueParam {
  std::string key;
  double min = 0, max = 0, def = 0;
};
struct CatalogueEntry {
  std::string type, id;
  bool hidden = false;
  std::vector<CatalogueParam> params;
};
/** The catalogue parsed once (thread-safe static). */
const std::vector<CatalogueEntry> &catalogue();
const CatalogueEntry *findCatalogue(std::string_view type, std::string_view id);

class InstrumentServiceImpl final : public InstrumentService {
 public:
  explicit InstrumentServiceImpl(Model &m) : m_(m) {}
  std::string listJson() override { return std::string(catalogueJson()); }
  void onCommit(const PatchSpec &patch, double when) override;
  void onRateChanged(double sampleRate) override;

 private:
  Model &m_;
};

/** Set handler of the dynamic rows `slots.<i>.params.<key>` (Model::set). */
bool setInstrumentParam(Model &m, const SetRequest &req);
/** INTERFACE-CHANGE(W3A) T13 review O2: store `slots.<i>.params.<key>` = value (clamped as setInstrumentParam) in
 *  the patch now; Model::set calls it before coalescing the send (JS stores at call time). False = not stored. */
bool storeInstrumentParam(Model &m, int slot, std::string_view path, double value);
/** INTERFACE-CHANGE(W3A): the InstParam index of `key` for this slot's instrument (catalogue row, or a `user:`
 *  sampler's samplerParamIndex; -1 = none) and `v` clamped as setInstrumentParam clamps it. */
int resolveInstrumentParam(const SlotPatch &sp, std::string_view key, double &v);

}  // namespace rig::inst
