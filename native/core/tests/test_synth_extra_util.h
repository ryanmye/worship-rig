// T15 test helpers: golden fixtures through the fixture runner (= rig_render) compared sample by sample at the exact
// tier, with the golden read from the manifest entry's own file (smoke/ or out/), and the catalogue entry of a ref.
#pragma once
#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "doctest.h"
#include "fixture_runner.h"
#include "helpers.h"
#include "io/wav.h"
#include "yyjson.h"

namespace t15 {

inline const std::string kGolden = std::string(RIG_REPO_DIR) + "/native/golden";

inline std::string readFile(const std::string &p) {
  std::ifstream f(p, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

struct Doc {
  yyjson_doc *d = nullptr;
  explicit Doc(const std::string &s) : d(yyjson_read(s.data(), s.size(), 0)) {}
  ~Doc() { yyjson_doc_free(d); }
  Doc(const Doc &) = delete;
  Doc &operator=(const Doc &) = delete;
  yyjson_val *root() const { return yyjson_doc_get_root(d); }
};

struct GoldenResult {
  bool present = false;
  double maxDiff = 0, peak = 0;
  long rtAllocs = 0;
};

/** The golden file of `id` (manifest `file`, relative to native/golden). */
inline std::string goldenFile(const std::string &id) {
  static const Doc m{readFile(kGolden + "/manifest.json")};
  std::size_t i, n;
  yyjson_val *f;
  yyjson_arr_foreach(yyjson_obj_get(m.root(), "fixtures"), i, n, f) {
    if (std::string(yyjson_get_str(yyjson_obj_get(f, "id"))) == id)
      return kGolden + "/" + yyjson_get_str(yyjson_obj_get(f, "file"));
  }
  return {};
}

inline GoldenResult goldenRun(const std::string &id) {
  static std::vector<rig::tools::Fixture> all;
  if (all.empty()) {
    std::string err;
    REQUIRE(rig::tools::loadFixtures(kGolden + "/manifest.json", all, &err));
  }
  GoldenResult g;
  const auto it = std::find_if(all.begin(), all.end(), [&](const auto &f) { return f.id == id; });
  REQUIRE(it != all.end());
  rig::io::WavData gold;
  if (!rig::io::readWav(goldenFile(id), gold)) {
    MESSAGE("golden WAV missing for " << id << " (node tools/golden/render.mjs --only " << id << "): skipped");
    return g;
  }
  g.present = true;
  const long before = rigtest::g_rtAllocs;
  const rig::tools::RunResult r = rig::tools::runFixture(*it, kGolden, 44100);
  g.rtAllocs = rigtest::g_rtAllocs - before;
  REQUIRE(r.ok);
  REQUIRE(r.channels.size() == 2);
  for (int c = 0; c < 2; ++c) {
    REQUIRE(r.channels[c].size() == gold.ch[c].size());
    g.maxDiff = std::max(g.maxDiff, rigtest::maxAbsDiff(r.channels[c], gold.ch[c]));
    for (float v : gold.ch[c]) g.peak = std::max(g.peak, double(std::fabs(v)));
  }
  MESSAGE(id << ": max |native - golden| = " << g.maxDiff << ", golden peak " << g.peak);
  return g;
}

/** engine-api.json catalogue entry {type, id}, or null. */
inline yyjson_val *catalogueEntry(const Doc &api, const char *type, const char *id) {
  std::size_t i, n;
  yyjson_val *e;
  yyjson_arr_foreach(yyjson_obj_get(yyjson_obj_get(api.root(), "instruments"), "list"), i, n, e) {
    yyjson_val *ref = yyjson_obj_get(e, "ref");
    if (std::string(yyjson_get_str(yyjson_obj_get(ref, "type"))) == type &&
        std::string(yyjson_get_str(yyjson_obj_get(ref, "id"))) == id)
      return e;
  }
  return nullptr;
}

}  // namespace t15
