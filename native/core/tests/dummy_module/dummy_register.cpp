// rig_register_tests_dummy_module_dummy: discovered by cmake/RigModules.cmake (tests/**/*_register.cpp).
#include <cstring>

#include "api/registry.h"
#include "dummy.h"
#include "model/model.h"
#include "model/services.h"

namespace dummy {

Counters &counters() {
  static Counters c;
  return c;
}

namespace {

/** out = in + dc (in = the bus of the slot it is attached to; silence for sources). */
class DummyUnit final : public rig::Unit {
 public:
  void process(const rig::RenderContext &, rig::UnitIO &io) override {
    rig::Bus &out = *io.out;
    out.channels = 2;
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < rig::kQ; ++i) {
        const float x = io.in ? io.in->ch[io.in->channels == 1 ? 0 : c][i] : 0.0f;
        out.ch[c][i] = x + dc_;
      }
  }
  void apply(const rig::Command &c) override {
    if (c.op == rig::opOf(DummyOp::SetDc)) dc_ = static_cast<float>(c.f.a);
  }

 private:
  float dc_ = 0.0f;
};

rig::Unit *make(const rig::UnitEnv &, const rig::UnitSpec &) {
  ++counters().built;
  return new DummyUnit();
}

class DummyService final : public rig::Service {
 public:
  void onCommit(const rig::PatchSpec &, double) override { ++counters().commits; }
};

rig::Service *makeService(rig::Model &) {
  return new DummyService();
}

/** Claims fx.chorus.rate below module priority, so the real chorus (T05, "fx.chorus.") takes over once it lands. */
}  // namespace

bool onSet(rig::Model &m, const rig::SetRequest &req) {
  ++counters().sets;
  rig::Command c{};
  c.op = rig::opOf(DummyOp::SetDc);
  c.f.a = req.value;
  return m.sendUnitOp(rig::UnitSlot::Chorus, c, req.when);
}

}  // namespace dummy

void rig_register_tests_dummy_module_dummy(rig::Registry &r) {
  r.addUnit(dummy::kKind, &dummy::make);
  r.addService(dummy::kService, &dummy::makeService);
  r.addSetHandler("fx.chorus.rate", &dummy::onSet, dummy::kSetPriority);
}
