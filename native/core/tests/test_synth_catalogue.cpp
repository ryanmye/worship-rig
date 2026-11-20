// `get instruments` = engine-api.json `instruments.list` (T11 InstrumentService, embedded by inst/catalogue.cmake),
// and the native synth.js tables (inst/synth_patches.cpp: names, groups, params, gain trims) equal the catalogue.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "doctest.h"
#include "helpers.h"
#include "inst/instrument_service.h"
#include "inst/synth_dispatch.h"
#include "inst/synth_patches.h"
#include "yyjson.h"

namespace {

std::string readFile(const std::string &p) {
  std::ifstream f(p, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

struct Doc {
  yyjson_doc *d = nullptr;
  explicit Doc(const std::string &s) : d(yyjson_read(s.data(), s.size(), 0)) {}
  ~Doc() { yyjson_doc_free(d); }
  yyjson_val *root() const { return yyjson_doc_get_root(d); }
};

}  // namespace

TEST_SUITE("synth-catalogue") {
  TEST_CASE("listJson() equals engine-api.json instruments.list (deep JSON equality)") {
    const Doc api(readFile(std::string(RIG_REPO_DIR) + "/native/contract/engine-api.json"));
    REQUIRE(api.d);
    yyjson_val *list = yyjson_obj_get(yyjson_obj_get(api.root(), "instruments"), "list");
    REQUIRE(yyjson_is_arr(list));
    const Doc mine(std::string(rig::inst::catalogueJson()));
    REQUIRE(mine.d);
    CHECK(yyjson_arr_size(mine.root()) == yyjson_arr_size(list));
    CHECK(yyjson_equals(mine.root(), list));
  }

  TEST_CASE("synth.js patch tables = catalogue entries (name, group, hidden, params, gainTrimDb)") {
    const Doc mine(std::string(rig::inst::catalogueJson()));
    REQUIRE(mine.d);
    for (std::size_t k = 0; k < rig::inst::kPatchCount; ++k) {
      const rig::inst::PatchDef &p = rig::inst::patchDef(static_cast<rig::inst::PatchId>(k));
      CAPTURE(p.idStr);
      yyjson_val *entry = nullptr;
      std::size_t i, n;
      yyjson_val *e;
      yyjson_arr_foreach(mine.root(), i, n, e) {
        yyjson_val *ref = yyjson_obj_get(e, "ref");
        if (std::string(yyjson_get_str(yyjson_obj_get(ref, "type"))) == "synth" &&
            std::string(yyjson_get_str(yyjson_obj_get(ref, "id"))) == p.idStr)
          entry = e;
      }
      REQUIRE(entry);
      CHECK(std::string(yyjson_get_str(yyjson_obj_get(entry, "name"))) == p.name);
      CHECK(std::string(yyjson_get_str(yyjson_obj_get(entry, "group"))) == p.group);
      CHECK(yyjson_get_bool(yyjson_obj_get(entry, "hidden")) == p.hidden);
      CHECK(yyjson_get_num(yyjson_obj_get(entry, "gainTrimDb")) == doctest::Approx(p.trimDb));
      yyjson_val *params = yyjson_obj_get(entry, "params");
      REQUIRE(yyjson_arr_size(params) == p.nParams);
      for (std::size_t j = 0; j < p.nParams; ++j) {
        yyjson_val *q = yyjson_arr_get(params, j);
        const rig::inst::ParamDef &d = p.params[j];
        CAPTURE(d.key);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "key"))) == d.key);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "label"))) == d.label);
        CHECK(yyjson_get_num(yyjson_obj_get(q, "min")) == d.min);
        CHECK(yyjson_get_num(yyjson_obj_get(q, "max")) == d.max);
        CHECK(yyjson_get_num(yyjson_obj_get(q, "default")) == d.def);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "unit"))) == d.unit);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "curve"))) == d.curve);
        CHECK(rig::inst::paramIndex(p, d.key) == static_cast<int>(j));
      }
    }
  }

  TEST_CASE("the ten synth-extra ids of the hook are the catalogue's other synth entries") {
    int synthJs = 0, extra = 0;
    for (const auto &e : rig::inst::catalogue()) {
      if (e.type != "synth") continue;
      if (rig::inst::findPatch(e.id)) ++synthJs;
      else if (rig::inst::isSynthExtraId(e.id)) ++extra;
      else FAIL("synth id neither synth.js nor synth-extra: " << e.id);
    }
    CHECK(synthJs == 7);
    CHECK(extra == 10);
  }

  TEST_CASE("bridge: get instruments answers the catalogue (hidden entries included, the shim filters them)") {
    rigtest::OfflineEngine e(48000);
    e.hello();
    const std::string r = e.call(R"({"v":1,"op":"get","id":2,"what":"instruments"})");
    CHECK(rigtest::contains(r, "\"ok\":true"));
    CHECK(rigtest::contains(r, "\"drone-osc\""));
    CHECK(rigtest::contains(r, "\"salamander-piano\""));
    std::size_t refs = 0;
    for (std::size_t p = r.find("\"ref\":"); p != std::string::npos; p = r.find("\"ref\":", p + 1)) ++refs;
    CHECK(refs == rig::inst::catalogue().size());
  }
}
