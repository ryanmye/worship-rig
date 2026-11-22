// T14 test-only module: instrument kind "inst.t14probe" recording the decoded perform opcodes (test_perform_probe.h).
#include <array>
#include <atomic>
#include <set>

#include "api/registry.h"
#include "inst/instrument.h"
#include "test_perform_probe.h"

namespace t14 {
namespace {

constexpr std::size_t kLog = 1 << 14;
std::array<Call, kLog> g_log;
std::atomic<std::size_t> g_n{0};

void rec(const Call &c) {
  const std::size_t i = g_n.load(std::memory_order_relaxed);
  if (i >= kLog) return;
  g_log[i] = c;
  g_n.store(i + 1, std::memory_order_release);
}

class Probe final : public rig::Instrument {
 public:
  explicit Probe(int channel) : ch_(channel) {}
  void noteOn(int note, int vel, float velGain, std::int64_t frame) override {
    rec({'N', ch_, note, -1, frame, velGain, vel});
    if (note >= 0 && note < 128) on_[static_cast<std::size_t>(note)] = true;
  }
  void noteOff(int note, std::int64_t frame, bool) override {
    rec({'F', ch_, note, -1, frame, 0, 0});
    if (note >= 0 && note < 128) on_[static_cast<std::size_t>(note)] = false;
  }
  void allNotesOff(std::int64_t frame) override {
    rec({'A', ch_, -1, -1, frame, 0, 0});
    on_.fill(false);
  }
  void kill() override {
    rec({'K', ch_, -1, -1, 0, 0, 0});
    on_.fill(false);
  }
  void setBend(double semis, std::int64_t frame) override { rec({'B', ch_, -1, -1, frame, semis, 0}); }
  void legatoTo(int from, int to, std::int64_t frame, double glide) override {
    rec({'L', ch_, from, to, frame, glide, 0});
    if (from >= 0 && from < 128) on_[static_cast<std::size_t>(from)] = false;
    if (to >= 0 && to < 128) on_[static_cast<std::size_t>(to)] = true;
  }
  void fadeNote(int note, std::int64_t frame, double seconds) override {
    rec({'D', ch_, note, -1, frame, seconds, 0});
    if (note >= 0 && note < 128) on_[static_cast<std::size_t>(note)] = false;
  }
  void setParam(std::uint32_t index, double value, double, double) override {
    rec({'P', ch_, static_cast<int>(index), -1, 0, value, 0});
  }
  unsigned outputChannels() const override { return 1; }
  void process(const rig::RenderContext &, rig::UnitIO &io) override {
    if (io.out) io.out->clear(1);
  }
  std::uint32_t liveVoices() const override {
    std::uint32_t n = 0;
    for (bool b : on_) n += b ? 1u : 0u;
    return n;
  }

 private:
  int ch_;
  std::array<bool, 128> on_{};
};

rig::Unit *makeProbe(const rig::UnitEnv &, const rig::UnitSpec &spec) {
  return new Probe(spec.channel);
}

}  // namespace

std::vector<Call> calls() {
  const std::size_t n = g_n.load(std::memory_order_acquire);
  return std::vector<Call>(g_log.begin(), g_log.begin() + static_cast<std::ptrdiff_t>(n));
}
void clear() {
  g_n.store(0, std::memory_order_release);
}
std::vector<Call> callsOf(char op, int channel) {
  std::vector<Call> out;
  for (const Call &c : calls())
    if (c.op == op && (channel < 0 || c.channel == channel)) out.push_back(c);
  return out;
}

}  // namespace t14

void rig_register_tests_test_perform_probe(rig::Registry &r) {
  r.addUnit("inst.t14probe", &t14::makeProbe);
}
