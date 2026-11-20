// T08 meters (M16): out peaks never missed (Q14), slot levels over 256 frames (contract 3.11 slotLevel), the RTA
// encoding (engine-api.json messages.rta), tick rate rules (G6) and the tick builder.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "helpers.h"
#include "meter/meter.h"
#include "yyjson.h"

using namespace rigtest;

namespace {

rig::Engine &impl(rig_engine *e) {
  return *reinterpret_cast<rig::Engine *>(e);
}

std::vector<std::uint8_t> unbase64(const std::string &s) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    return c == '+' ? 62 : c == '/' ? 63 : -1;
  };
  std::vector<std::uint8_t> out;
  unsigned buf = 0;
  int bits = 0;
  for (char c : s) {
    const int v = val(c);
    if (v < 0) break;
    buf = buf << 6 | static_cast<unsigned>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>(buf >> bits & 0xff));
    }
  }
  return out;
}

void sineSlot(OfflineEngine &e) {
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
  e.call(R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[{"instrument":{"type":"test","id":"sine"},"gain":0.8,)"
         R"("params":{"attack":0.002,"release":0.05}},null,null,null]}})");
  e.call(R"({"v":1,"op":"commit","token":1,"when":0})");
}

}  // namespace

TEST_SUITE("meter") {
  TEST_CASE("base64 (RFC 4648 vectors)") {
    auto b = [](const char *s) { return rig::base64(reinterpret_cast<const std::uint8_t *>(s), std::strlen(s)); };
    CHECK(b("") == "");
    CHECK(b("f") == "Zg==");
    CHECK(b("fo") == "Zm8=");
    CHECK(b("foo") == "Zm9v");
    CHECK(b("foobar") == "Zm9vYmFy");
  }

  TEST_CASE("out peaks: the max over all reads equals the max of the rendered output; a spike is never missed") {
    OfflineEngine e;
    sineSlot(e);
    rig::MeterServiceImpl *ms = rig::MeterServiceImpl::of(impl(e.e).model());
    REQUIRE(ms != nullptr);
    CHECK(ms->shared().attached.load());
    // one-sample spike through the sum (fx.sum inject) on top of a short note
    std::vector<float> spike(1, 0.9f);
    const float *d[1] = {spike.data()};
    REQUIRE(rig_test_inject(e.e, "fx.sum", d, 1, 1, 0.31234, 1.0f) == RIG_OK);
    e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":100,"when":0.05})");
    e.call(R"({"v":1,"op":"play","e":"off","n":69,"when":0.15})");
    float readMax[2] = {0, 0}, outMax[2] = {0, 0};
    int reads = 0;
    for (std::size_t chunk : {333u, 1000u, 47u, 4096u, 128u, 2000u, 5000u, 7777u, 9000u, 12000u, 6000u}) {
      const auto out = e.render(chunk);
      for (int c = 0; c < 2; ++c) {
        for (float x : out[c]) outMax[c] = std::max(outMax[c], std::fabs(x));
        readMax[c] = std::max(readMax[c], ms->shared().takePeak(c));
      }
      ++reads;
    }
    // the meter sees whole quanta rendered ahead of the FIFO: every rendered sample was read exactly once
    for (int c = 0; c < 2; ++c) {
      readMax[c] = std::max(readMax[c], ms->shared().takePeak(c));
      CHECK(outMax[c] > 0.5f);
      CHECK(readMax[c] == outMax[c]);
    }
    CHECK(ms->shared().takePeak(0) == 0.0f);  // reset by the read
    CHECK(reads > 5);
  }

  TEST_CASE("slot levels: peak and rms of 0.5 (L + R) of the strip output over the last 256 frames") {
    OfflineEngine e;
    sineSlot(e);
    REQUIRE(rig_test_tap(e.e, "slot0.pan") == RIG_OK);
    e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":100,"when":0})");
    const auto out = e.render(128 * 40);
    rig_meters m{};
    m.struct_size = sizeof m;
    REQUIRE(rig_get_meters(e.e, &m) == RIG_OK);
    float pk = 0;
    double sq = 0;
    for (std::size_t i = out[0].size() - 256; i < out[0].size(); ++i) {
      const float x = 0.5f * (out[0][i] + out[1][i]);
      pk = std::max(pk, std::fabs(x));
      sq += double(x) * double(x);
    }
    CHECK(pk > 0.05f);
    CHECK(m.slot_peak[0] == pk);
    CHECK(m.slot_rms[0] == doctest::Approx(std::sqrt(sq / 256)).epsilon(1e-6));
    CHECK(m.slot_peak[1] == 0.0f);
    CHECK(m.slot_rms[2] == 0.0f);
  }

  TEST_CASE("RTA of a bin-centred sine: peak bin, level (Blackman coherent gain), byte encoding, smoothing") {
    OfflineEngine e;
    e.hello();
    rig::MeterServiceImpl *ms = rig::MeterServiceImpl::of(impl(e.e).model());
    REQUIRE(ms != nullptr);
    yyjson_doc *d = yyjson_read(R"({"rta":true})", 12, 0);
    ms->subscribe(yyjson_doc_get_root(d));
    yyjson_doc_free(d);
    CHECK(ms->rtaOn());
    rig::MeterShared &s = ms->shared();
    const int bin = 40;
    const double A = 0.5;
    for (std::size_t i = 0; i < rig::MeterShared::kRing; ++i) {
      const double ph = 2 * 3.141592653589793 * bin * static_cast<double>(i) / 2048.0;
      s.ring[0][i].store(static_cast<float>(A * std::sin(ph)));
      s.ring[1][i].store(static_cast<float>(A / 4 * std::sin(ph)));
    }
    s.written.store(rig::MeterShared::kRing);
    std::string b64;
    for (int k = 0; k < 60; ++k) b64 = ms->rtaBase64();  // smoothing 0.8: converged after ~60 reads
    const auto bytes = unbase64(b64);
    REQUIRE(bytes.size() == 2048);
    const auto &db = ms->lastDb(0);
    const auto peak = std::max_element(db.begin(), db.end()) - db.begin();
    CHECK(peak == bin);
    const double expect = 20 * std::log10(A / 2 * 0.42);  // |X_k| / N for a bin-centred sine, Blackman a0 = 0.42
    CHECK(db[bin] == doctest::Approx(expect).epsilon(0.002));
    CHECK(ms->lastDb(1)[bin] == doctest::Approx(expect - 20 * std::log10(4.0)).epsilon(0.002));
    CHECK(bytes[bin] == static_cast<std::uint8_t>(std::lround(-db[bin] * 2)));
    CHECK(bytes[1024 + bin] > bytes[bin]);  // R quieter -> larger byte
    CHECK(bytes[500] == 255);                // far bins: below -127.5 dB clamps
    // first read after a fresh subscription is 1 - 0.8 of the converged magnitude (-14 dB)
    yyjson_doc *off = yyjson_read(R"({"rta":false})", 13, 0);
    ms->subscribe(yyjson_doc_get_root(off));
    yyjson_doc_free(off);
    yyjson_doc *on = yyjson_read(R"({"rta":true})", 12, 0);
    ms->subscribe(yyjson_doc_get_root(on));
    yyjson_doc_free(on);
    ms->rtaBase64();
    CHECK(ms->lastDb(0)[bin] == doctest::Approx(expect + 20 * std::log10(0.2)).epsilon(0.002));
  }

  TEST_CASE("tick rate rules and the tick builder fields") {
    OfflineEngine e;
    sineSlot(e);
    rig::MeterServiceImpl *ms = rig::MeterServiceImpl::of(impl(e.e).model());
    REQUIRE(ms != nullptr);
    CHECK(ms->tickHz() == rig::kIdleTickHz);
    e.call(R"({"v":1,"op":"config","meters":{"slots":[0,2]}})");
    CHECK(ms->tickHz() == rig::kActiveTickHz);
    CHECK(ms->slotSubscribed(0));
    CHECK(!ms->slotSubscribed(1));
    e.call(R"({"v":1,"op":"config","meters":{"rate":2}})");
    CHECK(ms->tickHz() == rig::kIdleTickHz);  // G6 floor
    e.call(R"({"v":1,"op":"config","meters":{"rate":500,"rta":true}})");
    CHECK(ms->tickHz() == rig::kMaxTickHz);
    e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":100})");
    e.render(4096);
    const std::string t = impl(e.e).buildTick(true);
    for (const char *k : {"\"ev\":\"tick\"", "\"out\":[", "\"slots\":[[", "\"rta\":\"", "\"blockers\":[",
                          "\"runtime\":{", "\"stats\":{", "\"slotLevelTaps\":2"})
      CHECK_MESSAGE(contains(t, k), k);
    yyjson_doc *d = yyjson_read(t.data(), t.size(), 0);
    REQUIRE(d != nullptr);
    yyjson_val *slots = yyjson_obj_get(yyjson_doc_get_root(d), "slots");
    CHECK(yyjson_arr_size(slots) == 4);
    CHECK(yyjson_get_num(yyjson_arr_get(yyjson_arr_get(slots, 0), 0)) > 0);
    CHECK(yyjson_get_num(yyjson_arr_get(yyjson_arr_get(slots, 1), 0)) == 0);  // not subscribed
    yyjson_doc_free(d);
    e.call(R"({"v":1,"op":"config","lowResource":true})");
    CHECK(contains(impl(e.e).buildTick(false), "\"slots\":[[0,0],[0,0],[0,0],[0,0]]"));  // zeros in low-resource
  }
}
