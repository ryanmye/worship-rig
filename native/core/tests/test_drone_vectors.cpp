// T16: the drone's pure pieces against the JS (tools/golden/vectors/dump-drone.mjs -> data/drone.json):
// staticVoicing, followVoicing (1878 cases), Drone.loopRegion, keydetect.js detectKeyFromName (43 names).
#include <string>
#include <vector>

#include "drone/drone_voicing.h"
#include "helpers.h"
#include "yyjson.h"

namespace {

std::vector<int> ints(yyjson_val *a) {
  std::vector<int> v;
  std::size_t i, n;
  yyjson_val *x;
  yyjson_arr_foreach(a, i, n, x) v.push_back(static_cast<int>(yyjson_get_num(x)));
  return v;
}

}  // namespace

TEST_SUITE("drone_vectors") {
  TEST_CASE("drone.json: voicings, loop regions and key detection equal the JS") {
    yyjson_doc *doc =
        yyjson_read_file(RIG_REPO_DIR "/tools/golden/vectors/data/drone.json", 0, nullptr, nullptr);
    REQUIRE(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    std::size_t i, n, cases = 0;
    yyjson_val *row;
    yyjson_arr_foreach(yyjson_obj_get(root, "static"), i, n, row) {
      const int pc = static_cast<int>(yyjson_get_num(yyjson_arr_get(row, 0)));
      CHECK(rig::drone::staticVoicing(pc, yyjson_get_num(yyjson_arr_get(row, 1))) == ints(yyjson_arr_get(row, 2)));
      ++cases;
    }
    yyjson_arr_foreach(yyjson_obj_get(root, "follow"), i, n, row) {
      const std::vector<int> held = ints(yyjson_arr_get(row, 0));
      yyjson_val *pv = yyjson_arr_get(row, 1);
      const std::vector<int> prev = yyjson_is_null(pv) ? std::vector<int>{} : ints(pv);
      yyjson_val *want = yyjson_arr_get(row, 2);
      const auto got = rig::drone::followVoicing(held, prev);
      INFO("case " << i);
      if (yyjson_is_null(want)) {
        CHECK_FALSE(got.has_value());
      } else {
        REQUIRE(got.has_value());
        CHECK(got->bass == static_cast<int>(yyjson_get_num(yyjson_obj_get(want, "bass"))));
        const std::vector<int> up = ints(yyjson_obj_get(want, "upper"));
        CHECK(std::vector<int>(got->upper, got->upper + 3) == up);
      }
      ++cases;
    }
    yyjson_arr_foreach(yyjson_obj_get(root, "region"), i, n, row) {
      const double dur = yyjson_get_num(yyjson_arr_get(row, 0));
      yyjson_val *r = yyjson_arr_get(row, 1);
      const rig::drone::LoopRegion got = rig::drone::loopRegion(dur);
      CHECK(got.loop == (yyjson_obj_get(r, "loop") != nullptr));
      if (!got.loop) {
        CHECK(got.ls == yyjson_get_num(yyjson_obj_get(r, "ls")));
        CHECK(got.le == yyjson_get_num(yyjson_obj_get(r, "le")));
        CHECK(got.xf == yyjson_get_num(yyjson_obj_get(r, "xf")));
      }
      ++cases;
    }
    yyjson_arr_foreach(yyjson_obj_get(root, "key"), i, n, row) {
      const char *name = yyjson_get_str(yyjson_arr_get(row, 0));
      yyjson_val *want = yyjson_arr_get(row, 1);
      const auto got = rig::drone::detectKeyFromName(name);
      INFO(name);
      if (yyjson_is_null(want)) {
        CHECK_FALSE(got.has_value());
      } else {
        REQUIRE(got.has_value());
        CHECK(got->pc == static_cast<int>(yyjson_get_num(yyjson_obj_get(want, "pc"))));
        CHECK(got->minor == yyjson_get_bool(yyjson_obj_get(want, "minor")));
        CHECK(got->confidence == static_cast<int>(yyjson_get_num(yyjson_obj_get(want, "confidence"))));
      }
      ++cases;
    }
    CHECK(cases == 195 + 1878 + 16 + 43);
    yyjson_doc_free(doc);
  }
}
