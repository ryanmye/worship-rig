// The scratch module of this directory registers a unit kind, an opcode, a set handler and a service; nothing outside
// tests/dummy_module/ names it. The engine finds it through the registry only.
#include <algorithm>
#include <cmath>

#include "api/engine.h"
#include "doctest.h"
#include "dummy.h"
#include "helpers.h"

using namespace rigtest;

TEST_SUITE("dummy-module") {
  TEST_CASE("a module registered from its own directory renders, taps, takes opcodes and set rows") {
    OfflineEngine e(48000);
    e.hello();
    rig::Engine &eng = *reinterpret_cast<rig::Engine *>(e.e);
    rig::Model &m = eng.model();
    CHECK(m.service(dummy::kService) != nullptr);

    // Not attached yet: the chorus test points are not served.
    CHECK(rig_test_tap(e.e, "fx.chorus.output") == RIG_E_UNSUPPORTED);
    REQUIRE(m.attachUnit(rig::UnitSlot::Chorus, dummy::kKind, -1.0));
    CHECK(m.attachedKind(rig::UnitSlot::Chorus) == dummy::kKind);
    CHECK(m.attachedIsModule(rig::UnitSlot::Chorus));
    CHECK(dummy::counters().built >= 1);
    REQUIRE(rig_test_tap(e.e, "fx.chorus.output") == RIG_OK);

    // A module opcode from the scratch range at frame 512. The graph applies a command at the start of the quantum
    // that contains Command::frame; a unit that needs sub-quantum accuracy reads c.frame itself.
    rig::Command c{};
    c.op = rig::opOf(dummy::DummyOp::SetDc);
    c.f.a = 0.25;
    REQUIRE(m.sendUnitOp(rig::UnitSlot::Chorus, c, 512.0 / 48000.0));
    // An injected ramp into the chorus send bus passes through the unit.
    std::vector<float> ramp(4800);
    for (size_t i = 0; i < ramp.size(); ++i) ramp[i] = static_cast<float>(i) / 48000.0f;
    const float *chans[1] = {ramp.data()};
    REQUIRE(rig_test_inject(e.e, "fx.chorus.input", chans, 1, ramp.size(), 0.05, 1.0f) == RIG_OK);

    const auto out = e.render(9600);
    CHECK(out[0][0] == 0.0f);
    CHECK(out[0][511] == 0.0f);
    CHECK(out[0][512] == doctest::Approx(0.25));
    CHECK(out[1][1000] == doctest::Approx(0.25));
    CHECK(out[0][2400 + 100] == doctest::Approx(0.25 + 100.0 / 48000.0));

    // A PARAMS row claimed by the module's set handler reaches the unit (fx.chorus.rate clamps to 0.05..3); skipped
    // once a real chorus module (T05) owns the row.
    const rig::Registry::SetEntry *h = rig::Registry::global().setHandler("fx.chorus.rate");
    REQUIRE(h != nullptr);
    if (h->handler != &dummy::onSet) return;
    const int setsBefore = dummy::counters().sets;
    const std::string r = e.call(R"({"v":1,"op":"set","id":9,"path":"fx.chorus.rate","value":1.5})");
    CHECK(contains(r, "\"applied\":true"));
    CHECK(dummy::counters().sets == setsBefore + 1);
    const auto out2 = e.render(1024);
    CHECK(out2[0][1000] == doctest::Approx(1.5));

    // The service sees commits.
    const int commits = dummy::counters().commits;
    e.call(R"({"v":1,"op":"prepare","id":2,"patch":{"slots":[null,null,null,null]}})");
    e.call(R"({"v":1,"op":"commit","id":3,"token":1})");
    CHECK(dummy::counters().commits == commits + 1);
  }
}
