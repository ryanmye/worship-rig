#include <cmath>
#include <vector>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "dr_mp3.h"
#include "pffft.h"
#include "yyjson.h"

TEST_SUITE("thirdparty") {
  TEST_CASE("yyjson parses and navigates") {
    const char *j = R"({"a":[1,2,{"b":"x"}],"n":null})";
    yyjson_doc *d = yyjson_read(j, std::strlen(j), 0);
    REQUIRE(d != nullptr);
    yyjson_val *a = yyjson_obj_get(yyjson_doc_get_root(d), "a");
    CHECK(yyjson_arr_size(a) == 3);
    CHECK(std::string(yyjson_get_str(yyjson_obj_get(yyjson_arr_get(a, 2), "b"))) == "x");
    yyjson_doc_free(d);
    CHECK(yyjson_read("{\"a\":", 5, 0) == nullptr);
  }

  TEST_CASE("pffft: real forward/backward round trip and a sine lands in the right bin") {
    const int N = 1024;
    PFFFT_Setup *s = pffft_new_setup(N, PFFFT_REAL);
    REQUIRE(s != nullptr);
    float *in = static_cast<float *>(pffft_aligned_malloc(N * sizeof(float)));
    float *spec = static_cast<float *>(pffft_aligned_malloc(N * sizeof(float)));
    float *back = static_cast<float *>(pffft_aligned_malloc(N * sizeof(float)));
    for (int i = 0; i < N; ++i) in[i] = static_cast<float>(std::sin(2 * 3.14159265358979 * 37 * i / N));
    pffft_transform_ordered(s, in, spec, nullptr, PFFFT_FORWARD);
    int best = 0;
    float bm = 0;
    for (int k = 1; k < N / 2; ++k) {
      const float m = std::hypot(spec[2 * k], spec[2 * k + 1]);
      if (m > bm) {
        bm = m;
        best = k;
      }
    }
    CHECK(best == 37);
    pffft_transform_ordered(s, spec, back, nullptr, PFFFT_BACKWARD);
    float err = 0;
    for (int i = 0; i < N; ++i) err = std::fmax(err, std::fabs(back[i] / N - in[i]));
    CHECK(err < 1e-5f);
    pffft_aligned_free(in);
    pffft_aligned_free(spec);
    pffft_aligned_free(back);
    pffft_destroy_setup(s);
  }

  TEST_CASE("dr_mp3 decodes a factory sample") {
    drmp3 mp3;
    const std::string path = std::string(RIG_REPO_DIR) + "/app/samples/marimba/E3.mp3";
    if (!drmp3_init_file(&mp3, path.c_str(), nullptr)) {
      MESSAGE("factory mp3 not present: skipped");
      return;
    }
    CHECK(mp3.channels >= 1);
    CHECK(mp3.sampleRate >= 22050);
    float buf[2048 * 2];
    const drmp3_uint64 n = drmp3_read_pcm_frames_f32(&mp3, 2048, buf);
    CHECK(n == 2048);
    drmp3_uninit(&mp3);
  }
}
