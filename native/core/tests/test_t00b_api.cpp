// T00b freeze: test-point tables equal tools/golden/page.js, C API additions (memory pressure, paths), registry.
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "api/engine.h"
#include "api/registry.h"
#include "doctest.h"
#include "graph/test_points.h"
#include "helpers.h"

using namespace rigtest;

namespace {

/** Keys of `const NAME = { ... };` in page.js, in order. */
std::vector<std::string> pageKeys(const std::string &src, const std::string &name) {
  std::vector<std::string> keys;
  const size_t a = src.find("const " + name + " = {");
  if (a == std::string::npos) return keys;
  const size_t b = src.find("\n};", a);
  std::istringstream body(src.substr(a, b - a));
  std::string line;
  std::getline(body, line);  // the `const NAME = {` line
  while (std::getline(body, line)) {  // `  'name': (e) => ...` or `  name: (e) => ...` (no std::regex: GCC 13 ASan
                                      // -Wmaybe-uninitialized false positive)
    size_t i = line.find_first_not_of(" \t");
    if (i == std::string::npos || line.compare(i, 2, "//") == 0) continue;
    if (line[i] == '\'') ++i;
    const size_t j = line.find_first_of("':", i);
    if (j == std::string::npos || j == i) continue;
    keys.push_back(line.substr(i, j - i));
  }
  return keys;
}

}  // namespace

TEST_SUITE("t00b") {
  TEST_CASE("TAP / INJECT tables equal tools/golden/page.js") {
    std::ifstream f(std::string(RIG_REPO_DIR) + "/tools/golden/page.js");
    REQUIRE(f.good());
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string src = ss.str();
    const auto taps = pageKeys(src, "TAP"), injects = pageKeys(src, "INJECT");
    REQUIRE(taps.size() == rig::kTapCount);
    REQUIRE(injects.size() == rig::kInjectCount);
    for (size_t i = 0; i < taps.size(); ++i) CHECK(taps[i] == rig::kTapPoints[i].name);
    for (size_t i = 0; i < injects.size(); ++i) CHECK(injects[i] == rig::kInjectPoints[i].name);
  }

  TEST_CASE("unserved test points answer UNSUPPORTED, builtin ones OK") {
    OfflineEngine e(44100);
    e.hello();
    CHECK(rig_test_tap(e.e, "out") == RIG_OK);
    CHECK(rig_test_tap(e.e, "slot1.pan") == RIG_OK);
    CHECK(rig_test_tap(e.e, "fx.sum") == RIG_OK);
    CHECK(rig_test_tap(e.e, "nope") == RIG_E_UNSUPPORTED);
    if (!rig::Registry::global().unit("master") || rig::Registry::global().unit("master")->priority == 0)
      CHECK(rig_test_tap(e.e, "fx.eqOut") == RIG_E_UNSUPPORTED);
    if (!rig::Registry::global().unit("reverb")) CHECK(rig_test_tap(e.e, "fx.reverb.output") == RIG_E_UNSUPPORTED);
  }

  TEST_CASE("builtin kinds are registered through the generated module list") {
    OfflineEngine e;  // rig_create runs ensureModulesRegistered
    const rig::Registry &r = rig::Registry::global();
    REQUIRE(r.unit("strip") != nullptr);
    REQUIRE(r.unit("inst.test") != nullptr);
    REQUIRE(r.unit("master") != nullptr);
  }

  TEST_CASE("rig_host_memory_pressure emits a warn; rig_set_paths updates the Model") {
    OfflineEngine e;
    e.hello();
    e.msgs.clear();
    rig_host_memory_pressure(e.e, 1);
    std::string all;
    for (auto &m : e.msgs) all += m;
    CHECK(contains(all, "\"ev\":\"warn\""));
    CHECK(contains(all, "\"code\":\"memory\""));
    CHECK(rig_set_paths(e.e, nullptr, nullptr) == RIG_E_INVALID);
    CHECK(rig_set_paths(e.e, "/tmp/user-manifest.json", nullptr) == RIG_OK);
    CHECK(rig_set_paths(e.e, nullptr, "/tmp/pads") == RIG_OK);
    const rig::Model &m = reinterpret_cast<rig::Engine *>(e.e)->model();
    CHECK(m.paths().userManifest == "/tmp/user-manifest.json");
    CHECK(m.paths().padsDir == "/tmp/pads");
  }
}
