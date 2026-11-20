// Test-only module for unit.runtime (T08): a service that records what the runtime delivers to every service
// (onRateChanged, synthesized VoiceEnded rescans) and a unit kind that floods the event ring.
#include "test_runtime_probe.h"

#include "api/registry.h"
#include "model/model.h"

namespace t08 {

std::atomic<int> g_rateChanges{0}, g_rescans{0}, g_rescanSlot{-1};
std::atomic<double> g_lastRate{0};
std::atomic<int> g_floodPerQuantum{0};

namespace {

class Probe final : public rig::Service {
 public:
  void onRateChanged(double sr) override {
    g_lastRate = sr;
    ++g_rateChanges;
  }
  void onAudioEvent(const rig::AudioEvent &e) override {
    if (e.kind == rig::EventKind::VoiceEnded && e.sub == 1 && e.f.b < 0) {
      ++g_rescans;
      g_rescanSlot = static_cast<int>(e.f.a);
    }
  }
};

/** Pushes g_floodPerQuantum VoiceEnded events per quantum (more than the 4096-entry ring holds). */
class Flood final : public rig::Unit {
 public:
  void process(const rig::RenderContext &ctx, rig::UnitIO &io) override {
    if (io.out) io.out->clear(2);
    const int n = g_floodPerQuantum.load(std::memory_order_relaxed);
    for (int i = 0; i < n; ++i) {
      rig::AudioEvent e{};
      e.frame = ctx.frame0;
      e.kind = rig::EventKind::VoiceEnded;
      e.f.a = static_cast<double>(ctx.self);
      e.f.b = i;
      ctx.events->push(e);
    }
  }
};

rig::Service *makeProbe(rig::Model &) {
  return new Probe();
}
rig::Unit *makeFlood(const rig::UnitEnv &, const rig::UnitSpec &) {
  return new Flood();
}

}  // namespace
}  // namespace t08

void rig_register_tests_test_runtime_probe(rig::Registry &r) {
  r.addService("t08-probe", &t08::makeProbe);
  r.addUnit("t08.flood", &t08::makeFlood);
}
