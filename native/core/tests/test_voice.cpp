#include <cmath>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "dsp/test_voice.h"

using namespace rig;

TEST_SUITE("voice") {
  TEST_CASE("starts at a sub-quantum offset: zeros before, signal from the start frame") {
    SlotSpec spec;
    spec.inst = InstKind::TestSine;
    spec.attack = 0.0;  // instant attack: envelope reaches 1 at the start frame
    TestVoice v;
    v.start(spec, 69, 127, 40, 48000);
    float buf[128] = {};
    CHECK(v.render(buf, 0, 128, 48000));
    for (int i = 0; i < 40; ++i) CHECK(buf[i] == 0.0f);
    CHECK(buf[40] == 0.0f);  // sin(0)
    CHECK(std::fabs(buf[41]) > 0.0f);
    CHECK(buf[41] == doctest::Approx(std::sin(2 * 3.14159265358979 * 440.0 / 48000)).epsilon(1e-4));
  }

  TEST_CASE("a voice scheduled for a later quantum renders nothing yet") {
    SlotSpec spec;
    TestVoice v;
    v.start(spec, 60, 100, 1000, 48000);
    float buf[128] = {};
    CHECK(v.render(buf, 0, 128, 48000));
    for (float x : buf) CHECK(x == 0.0f);
    CHECK(v.active());
  }

  TEST_CASE("release ends the voice after 12 time constants and not before") {
    SlotSpec spec;
    spec.release = 0.01;
    TestVoice v;
    v.start(spec, 60, 100, 0, 48000);
    float buf[128];
    std::int64_t q = 0;
    for (; q < 4800; q += 128) {
      std::fill(buf, buf + 128, 0.0f);
      CHECK(v.render(buf, q, 128, 48000));
    }
    v.release(spec, q, 48000);
    const std::int64_t end = q + static_cast<std::int64_t>(std::ceil(12 * 0.01 * 48000));
    bool alive = true;
    while (alive && q < end + 4000) {
      std::fill(buf, buf + 128, 0.0f);
      alive = v.render(buf, q, 128, 48000);
      q += 128;
    }
    CHECK(!alive);
    CHECK(q >= end);
    CHECK(q <= end + 256);
  }
}
