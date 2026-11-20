// Integrator (T07 review O5): in RIG_MODE_OFFLINE, rig_midi_in bytes are queued like in realtime mode and reach the
// "midi" service at the next rig_post or rendered quantum (realtime: the control loop drains the queue).
#include <cstdint>
#include <string>

#include "doctest.h"
#include "helpers.h"

using namespace rigtest;

namespace {

std::size_t count(const std::string &s, const char *needle) {
  std::size_t n = 0;
  for (std::size_t p = s.find(needle); p != std::string::npos; p = s.find(needle, p + 1)) ++n;
  return n;
}

std::string joined(const OfflineEngine &e) {
  std::string all;
  for (const auto &m : e.msgs) all += m;
  return all;
}

}  // namespace

TEST_SUITE("offline-midi") {
  TEST_CASE("rig_midi_in offline: delivered at the next quantum and at the next post, counted in stats") {
    OfflineEngine e(48000);
    e.hello();
    const std::string ports = R"([{"id":"k1","name":"Keys","state":"connected","kind":"input"}])";
    REQUIRE(rig_host_midi_ports(e.e, ports.data(), ports.size()) == RIG_OK);
    const std::uint8_t on[] = {0x90, 60, 100};
    e.msgs.clear();
    REQUIRE(rig_midi_in(e.e, "k1", on, sizeof on, 0) == RIG_OK);
    e.render(128);
    const std::string a = joined(e);
    CHECK(count(a, R"("type":"msg")") == 1);
    CHECK(contains(a, R"("port":"k1","data":[144,60,100])"));
    const std::uint8_t off[] = {0x80, 60, 0};
    REQUIRE(rig_midi_in(e.e, "k1", off, sizeof off, 0) == RIG_OK);
    const std::string b = e.call(R"({"v":1,"op":"get","what":"stats","id":9})");
    CHECK(contains(b, R"("data":[128,60,0])"));
    CHECK(contains(b, R"("midiReceived":2)"));
  }
}
