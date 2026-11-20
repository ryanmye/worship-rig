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

}  // namespace rig::inst
