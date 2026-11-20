// T04 reverb through the engine: the six golden fixtures at the EXACT tier (the ctest golden.reverb compares at the
// manifest tier), the unit crossfade and the predelay crossfade against analytic mixes, the pool (LRU by count and
// bytes, retainReverb, memory trim), the quiet gate / deferral policy, and the IR worker on a realtime Model.
// Ports of the JS engine tests predelayNoWarp, reverbRetain, reverbDeferWhilePlaying, reverbQuietGate
// (test/phase1/engine/suites.mjs) where they apply to the native engine.
#include <algorithm>
#include <cmath>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "fixture_runner.h"
#include "fx/ir_gen.h"
#include "fx/reverb_service.h"
#include "fx/reverb_unit.h"
#include "helpers.h"
#include "io/wav.h"
#include "model/model.h"
#include "num/prng.h"
#include "time/automation.h"
#include "time/param.h"

using namespace rigtest;

namespace {

const std::string kGolden = std::string(RIG_REPO_DIR) + "/native/golden";

rig::Model &modelOf(OfflineEngine &e) {
  return reinterpret_cast<rig::Engine *>(e.e)->model();
}
rig::fx::ReverbPool &poolOf(OfflineEngine &e) {
  auto *p = dynamic_cast<rig::fx::ReverbPool *>(modelOf(e).service("reverb"));
  REQUIRE(p != nullptr);
  return *p;
}

std::string reverbFx(double size, double damp, double predelay, double rg) {
  char b[200];
  std::snprintf(b, sizeof b, R"({"reverb":{"size":%.17g,"damp":%.17g,"predelay":%.17g,"returnGain":%.17g}})", size,
                damp, predelay, rg);
  return b;
}
std::string patchJson(const std::string &fx) {
  return R"({"slots":[null,null,null,null],"fx":)" + fx + "}";
}
long tokenOf(const std::string &reply) {
  const std::size_t p = reply.find("\"token\":");
  return p == std::string::npos ? -1 : std::strtol(reply.c_str() + p + 8, nullptr, 10);
}

/** page.js order: fx rows before start, audio start, prepare + commit at 0, tap fx.reverb.output. */
void startReverb(OfflineEngine &e, double size, double damp, double predelay, double rg) {
  e.hello();
  const std::pair<const char *, double> rows[] = {
      {"size", size}, {"damp", damp}, {"predelay", predelay}, {"returnGain", rg}};
  for (const auto &r : rows)
    e.call(std::string(R"({"v":1,"op":"set","id":2,"path":"fx.reverb.)") + r.first + R"(","value":)" +
           std::to_string(r.second) + "}");
  e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
  const long tok = tokenOf(e.call(R"({"v":1,"op":"prepare","id":4,"patch":)" +
                                  patchJson(reverbFx(size, damp, predelay, rg)) + "}"));
  REQUIRE(tok > 0);
  e.call(R"({"v":1,"op":"commit","id":5,"token":)" + std::to_string(tok) + R"(,"when":0})");
  REQUIRE(rig_test_tap(e.e, "fx.reverb.output") == RIG_OK);
}

void inject(OfflineEngine &e, const std::vector<float> &x, double at) {
  const float *ch[2] = {x.data(), x.data()};
  REQUIRE(rig_test_inject(e.e, "fx.reverb.input", ch, 2, static_cast<uint32_t>(x.size()), at, 1.0f) == RIG_OK);
}

std::vector<float> noiseBurst(double sr, double seconds, std::uint32_t seed) {
  rig::Mulberry32 r(seed);
  std::vector<float> x(static_cast<std::size_t>(seconds * sr));
  for (float &v : x) v = static_cast<float>((r.next() * 2 - 1) * 0.25);
  return x;
}

/** The gain an equal-power fade leaves on a GainNode param, frame by frame (same Param port as the unit). */
std::vector<float> fadeCurve(double sr, std::size_t frames, double initial, double from, double to, double when,
                             double dur) {
  rig::wa::Param p(0.0);
  rig::wa::setNow(p, initial, 0.0);
  rig::wa::equalPowerFade(p, from, to, when, dur);
  std::vector<float> g((frames + 127) / 128 * 128);
  for (std::size_t f = 0; f < frames; f += 128) p.processARate(static_cast<std::int64_t>(f), sr, g.data() + f, 128);
  g.resize(frames);
  return g;
}

}  // namespace

TEST_SUITE("reverb") {
  TEST_CASE("golden fixtures reverb-* at the exact tier (and far below it), allocation trap on") {
    std::vector<rig::tools::Fixture> all;
    std::string err;
    REQUIRE(rig::tools::loadFixtures(kGolden + "/manifest.json", all, &err));
    const long allocs = g_rtAllocs;
    for (const char *id :
         {"reverb-dry", "reverb-room", "reverb-stage", "reverb-hall", "reverb-cathedral", "reverb-wash"}) {
      INFO(id);
      const auto it = std::find_if(all.begin(), all.end(), [&](const auto &f) { return f.id == id; });
      REQUIRE(it != all.end());
      rig::io::WavData gold;
      if (!rig::io::readWav(kGolden + "/out/" + id + ".wav", gold) &&
          !rig::io::readWav(kGolden + "/smoke/" + id + ".wav", gold)) {
        MESSAGE("golden WAV missing for " << id << " (node tools/golden/render.mjs --only " << id << "): skipped");
        continue;
      }
      const rig::tools::RunResult r = rig::tools::runFixture(*it, kGolden, 44100);
      REQUIRE(r.ok);
      for (const auto &s : r.skipped) MESSAGE("skipped: " << s);
      CHECK(r.skipped.empty());
      REQUIRE(r.channels.size() == 2);
      double m = 0, peak = 0;
      for (int c = 0; c < 2; ++c) {
        REQUIRE(r.channels[c].size() == gold.ch[c].size());
        m = std::max(m, maxAbsDiff(r.channels[c], gold.ch[c]));
        for (float v : gold.ch[c]) peak = std::max(peak, double(std::fabs(v)));
      }
      MESSAGE(id << ": max |native - golden| = " << m << ", golden peak " << peak);
      CHECK(m <= 2e-4);  // the exact tier
      CHECK(m <= 1e-6);  // what the port actually achieves (float rounding of the FFT convolution)
      if (std::string(id) != "reverb-dry") CHECK(peak > 0.005);  // a silent golden proves nothing
    }
    CHECK(g_rtAllocs == allocs);
  }

  TEST_CASE("unit switch at commit: 0.8 s equal-power crossfade, the incoming unit fed from the call") {
    const double sr = 44100;
    const std::size_t frames = 3 * 44100;
    const auto x = noiseBurst(sr, 0.3, 7);
    auto render = [&](double sizeA, bool switchToB) {
      OfflineEngine e(sr);
      startReverb(e, sizeA, 0.5, 0.01, 1);
      if (switchToB) {
        const long tok = tokenOf(e.call(R"({"v":1,"op":"prepare","id":6,"patch":)" +
                                        patchJson(reverbFx(0.9, 0.5, 0.01, 1)) + "}"));
        e.call(R"({"v":1,"op":"commit","id":7,"token":)" + std::to_string(tok) + R"(,"when":1.0})");
      }
      inject(e, x, 0.05);
      auto out = e.render(frames, 4410);
      if (switchToB) {
        CHECK(poolOf(e).activeKey() == "8|0.5|44100");
        CHECK(poolOf(e).units() == 2);
      }
      return out;
    };
    const auto mix = render(0.18, true);
    const auto a = render(0.18, false), b = render(0.9, false);
    const auto gA = fadeCurve(sr, frames, 1, 1, 0, 1.0, rig::fx::kReverbFade);
    const auto gB = fadeCurve(sr, frames, 0, 0, 1, 1.0, rig::fx::kReverbFade);
    double m = 0, energyB = 0;
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < frames; ++i) {
        const float want = a[c][i] * gA[i] + b[c][i] * gB[i];
        m = std::max(m, std::fabs(double(mix[c][i]) - double(want)));
        if (i > 2 * 44100) energyB += double(mix[c][i]) * mix[c][i];
      }
    CHECK(m <= 1e-7);
    CHECK(energyB > 1e-4);  // the 8 s space rings after the fade (it was fed from t = 0)
  }

  TEST_CASE("live size edit: 300 ms debounce, then the crossfade; same bucket does nothing") {
    OfflineEngine e(44100);
    startReverb(e, 0.18, 0.5, 0.01, 1);
    auto &pool = poolOf(e);
    e.call(R"({"v":1,"op":"set","id":8,"path":"fx.reverb.size","value":0.17,"when":0.1})");  // same bucket 1.5
    e.call(R"({"v":1,"op":"set","id":9,"path":"fx.reverb.size","value":0.6,"when":0.5})");
    e.render(static_cast<std::size_t>(0.79 * 44100));
    CHECK(pool.activeKey() == "1.5|0.5|44100");
    CHECK(pool.targetKey() == "5|0.5|44100");
    e.render(4410);
    CHECK(pool.activeKey() == "5|0.5|44100");
    CHECK(pool.units() == 2);
  }

  TEST_CASE("predelayNoWarp: commit and live predelay changes crossfade lines, never warp the pitch") {
    const double sr = 44100;
    OfflineEngine e(sr);
    // an identity IR turns the reverb output into the predelayed (filtered) input, as the JS test's probe tap
    e.hello();
    poolOf(e).setBuildOverride([](const std::string &key, double rate, double, double) {
      const float one = 1.0f;
      return rig::fx::ReverbKernel::fromIr(key, rate, &one, &one, 1);
    });
    e.call(R"({"v":1,"op":"set","id":2,"path":"fx.reverb.predelay","value":0.04})");
    e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
    const long t1 = tokenOf(e.call(R"({"v":1,"op":"prepare","id":4,"patch":)" +
                                   patchJson(reverbFx(0.5, 0.5, 0.04, 1)) + "}"));
    e.call(R"({"v":1,"op":"commit","id":5,"token":)" + std::to_string(t1) + R"(,"when":0})");
    REQUIRE(rig_test_tap(e.e, "fx.reverb.output") == RIG_OK);
    const long t2 = tokenOf(e.call(R"({"v":1,"op":"prepare","id":6,"patch":)" +
                                   patchJson(reverbFx(0.5, 0.5, 0.015, 1)) + "}"));
    e.call(R"({"v":1,"op":"commit","id":7,"token":)" + std::to_string(t2) + R"(,"when":1.0})");
    e.call(R"({"v":1,"op":"set","id":8,"path":"fx.reverb.predelay","value":0.1,"when":1.3})");
    std::vector<float> sine(static_cast<std::size_t>(2.4 * sr));
    for (std::size_t i = 0; i < sine.size(); ++i)
      sine[i] = static_cast<float>(0.3 * std::sin(2 * 3.141592653589793 * 440 * double(i) / sr));
    inject(e, sine, 0.0);
    const auto out = e.render(static_cast<std::size_t>(2.4 * sr), 4410);
    const auto &d = out[0];
    int bad = 0;
    for (double w = 0.9; w < 2.28; w += 0.01) {
      int zc = 0;
      for (std::size_t i = static_cast<std::size_t>(w * sr) + 1; i < static_cast<std::size_t>((w + 0.02) * sr); ++i)
        if ((d[i - 1] < 0) != (d[i] < 0)) ++zc;
      if (std::abs(zc * 25 - 440) > 40) ++bad;
    }
    CHECK(bad == 0);
    CHECK(poolOf(e).activePredelay() == doctest::Approx(0.1).epsilon(1e-12));
    CHECK(poolOf(e).units() == 1);
    // the commit's change ran its 0.5 s crossfade first; the live one waited for it (pending -> 1.505 s)
  }

  TEST_CASE("predelay crossfade = analytic mix of the two delayed copies") {
    const double sr = 48000;
    const std::size_t frames = 48000;
    auto run = [&](double pd0, bool change) {
      OfflineEngine e(sr);
      e.hello();
      poolOf(e).setBuildOverride([](const std::string &key, double rate, double, double) {
        const float one = 1.0f;
        return rig::fx::ReverbKernel::fromIr(key, rate, &one, &one, 1);
      });
      e.call(R"({"v":1,"op":"set","id":2,"path":"fx.reverb.predelay","value":)" + std::to_string(pd0) + "}");
      e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
      REQUIRE(rig_test_tap(e.e, "fx.reverb.output") == RIG_OK);
      if (change) e.call(R"({"v":1,"op":"set","id":8,"path":"fx.reverb.predelay","value":0.0253,"when":0.3})");
      inject(e, noiseBurst(sr, 0.9, 3), 0.01);
      return e.render(frames, 4800);
    };
    const auto mix = run(0.02, true), a = run(0.02, false), b = run(0.0253, false);
    const auto gA = fadeCurve(sr, frames, 1, 1, 0, 0.3, rig::fx::kPredelayFade);
    const auto gB = fadeCurve(sr, frames, 0, 0, 1, 0.3, rig::fx::kPredelayFade);
    double m = 0;
    for (std::size_t i = 0; i < frames; ++i) {
      const float want = a[0][i] * gA[i] + b[0][i] * gB[i];
      m = std::max(m, std::fabs(double(mix[0][i]) - double(want)));
    }
    CHECK(m <= 1e-6);
  }

  TEST_CASE("device rate change: the playing space is rebuilt at the new rate and replaced at once") {
    OfflineEngine e(44100);
    startReverb(e, 0.18, 0.5, 0.01, 1);
    auto &pool = poolOf(e);
    e.render(22050);
    CHECK(pool.activeKey() == "1.5|0.5|44100");
    rig_device_info d{};
    d.struct_size = sizeof d;
    d.device_id = "test";
    d.device_name = "test";
    d.sample_rate = 48000;
    d.channels = 2;
    d.buffer_frames = 256;
    rig_host_audio_started(e.e, &d);
    std::vector<float> imp(64, 0.0f);
    imp[0] = 0.5f;
    inject(e, imp, 0.8);
    const auto out = e.render(48000);
    CHECK(pool.activeKey() == "1.5|0.5|48000");
    CHECK(pool.units() == 1);  // the 44.1 kHz space is dropped once it is idle
    double peak = 0;
    for (float v : out[0]) peak = std::max(peak, double(std::fabs(v)));
    CHECK(peak > 0.005);
  }

  TEST_CASE("reverbRetain: idle units outside the retained spaces are dropped") {
    OfflineEngine e(44100);
    startReverb(e, 0.3, 0.5, 0.02, 1);
    auto &pool = poolOf(e);
    const std::string active = pool.activeKey();
    for (double sz : {0.2, 0.5, 0.7, 0.9}) pool.ensureBuilt(sz, 0.5);  // the old pool: earlier songs' units
    CHECK(pool.units() == 5);
    const std::string r = e.call(R"({"v":1,"op":"cache","id":9,"action":"retainReverb","patches":[)" +
                                 patchJson(reverbFx(0.5, 0.5, 0.02, 1)) + "]}");
    CHECK(contains(r, "\"ok\":true"));
    const auto keys = pool.keys();
    CHECK(keys.size() == 2);
    CHECK(std::count(keys.begin(), keys.end(), active) == 1);
    CHECK(std::count(keys.begin(), keys.end(), pool.irKeyFor(0.5, 0.5)) == 1);
    pool.warm(0.9, 0.5);  // offline: never warms (and 0.9 is not retained)
    CHECK(!pool.has(pool.irKeyFor(0.9, 0.5)));
    CHECK(contains(pool.statsFields(), "\"reverbUnits\":2"));
  }

  TEST_CASE("pool is capped by units and by bytes (LRU); busy units survive; memory pressure trims idle ones") {
    OfflineEngine e(44100);
    startReverb(e, 0.18, 0.5, 0.02, 1);
    auto &pool = poolOf(e);
    const std::string active = pool.activeKey();
    pool.setLimits(3, std::size_t(1) << 30);
    for (double sz : {0.2, 0.3, 0.42, 0.55}) pool.ensureBuilt(sz, 0.5);
    CHECK(pool.units() == 3);
    auto keys = pool.keys();
    CHECK(std::count(keys.begin(), keys.end(), active) == 1);  // the active space is never evicted
    CHECK(keys.back() == pool.irKeyFor(0.55, 0.5));           // the newest stays
    CHECK(!pool.has(pool.irKeyFor(0.2, 0.5)));                // the oldest idle went first
    // bytes: the 8 s space alone is ~6 MB at 44.1 kHz; a 10 MB cap keeps the active room plus at most one big one
    pool.setLimits(10, std::size_t(10) << 20);
    pool.ensureBuilt(1.0, 0.25);
    pool.ensureBuilt(0.9, 0.35);
    CHECK(pool.bytes() <= std::size_t(10) << 20);
    keys = pool.keys();
    CHECK(std::count(keys.begin(), keys.end(), active) == 1);
    CHECK(keys.back() == pool.irKeyFor(0.9, 0.35));
    rig_host_memory_pressure(e.e, 1);
    CHECK(pool.keys() == std::vector<std::string>{active});
  }

  TEST_CASE("reverbDeferWhilePlaying + reverbQuietGate: deferred space waits for 2 s of quiet, warm-ups 6 s") {
    const double sr = 44100;
    OfflineEngine e(sr);
    e.hello();
    auto &pool = poolOf(e);
    rig::Model &m = modelOf(e);
    pool.setSimulateRealtime(true);
    double releasedAt = 1.5;  // a key is held until 1.5 s; then nothing is played
    pool.setQuietProbe([&] { return m.now() < releasedAt ? 0.0 : m.now() - releasedAt; });
    startReverb(e, 0.2, 0.5, 0.02, 1);
    const std::string oldKey = pool.activeKey();
    CHECK(oldKey == "2|0.5|44100");
    // prepare under a held key (T13 passes defer), commit now: the old space keeps playing
    const rig::fx::ReverbPool::Stage st = pool.stage(0.9, 0.5, true);
    CHECK(st.deferred);
    CHECK(!pool.has(st.key));
    pool.commitTo(&st, 0.02, m.now());
    pool.warm(0.42, 0.3);  // a neighbour warm-up queued meanwhile
    const std::string warmKey = pool.irKeyFor(0.42, 0.3);
    auto renderTo = [&](double t) {
      e.render(static_cast<std::size_t>(t * sr) - static_cast<std::size_t>(m.now() * sr));
    };
    renderTo(1.2);
    CHECK(pool.activeKey() == oldKey);  // held: deferred
    CHECK(!pool.has(st.key));
    CHECK(pool.quietWaiting() == 2);
    renderTo(3.45);  // released at 1.5 s: quiet reaches 2 s at 3.5 s
    CHECK(pool.activeKey() == oldKey);
    renderTo(3.6);
    CHECK(pool.activeKey() == st.key);
    CHECK(pool.deferredBuilds() == 1);
    renderTo(9.4);  // the warm-up counts its 6 s from that build (one build per pause)
    CHECK(!pool.has(warmKey));
    renderTo(9.65);
    CHECK(pool.has(warmKey));
    CHECK(pool.quietBuilds() == 2);
    CHECK(pool.quietWaiting() == 0);
    CHECK(pool.activeKey() == st.key);
    // a switch with nothing held is built at once and active at its commit
    const rig::fx::ReverbPool::Stage st2 = pool.stage(0.3, 0.3, false);
    CHECK(pool.has(st2.key));
    pool.commitTo(&st2, 0.02, m.now());
    CHECK(pool.activeKey() == st2.key);
  }
}

// ---- realtime Model with a fake engine: the IR worker thread (run under TSan by the T04 report) ----------------

namespace {

struct FakeSink final : rig::CommandSink {
  std::vector<rig::Command> cmds;
  std::multimap<double, std::function<void(double)>> timers;
  rig::TimeBase tb;
  bool send(rig::Command c) override {
    cmds.push_back(c);
    return true;
  }
  rig::TimeBase timeBase() const override { return tb; }
  void emit(std::string &&) override {}
  void at(double t, std::function<void(double)> fn) override { timers.emplace(t, std::move(fn)); }
  void runTimersUntil(double t) {
    while (!timers.empty() && timers.begin()->first <= t) {
      auto fn = std::move(timers.begin()->second);
      timers.erase(timers.begin());
      fn(t);
    }
  }
  ~FakeSink() override {
    for (auto &c : cmds)
      if (c.sub == rig::kSubOwnedPayload) delete static_cast<rig::Owned *>(c.p.ptr);
  }
};

}  // namespace

TEST_SUITE("reverb-worker") {
  TEST_CASE("realtime: kernels are built on the IR worker and attached through AttachKernel") {
    rig::ensureModulesRegistered();
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    FakeSink sink;
    sink.tb.sampleRate = 48000;
    rig::UnitEnv env;
    env.sampleRate = 48000;
    env.seed = 1;
    env.config = &cfg;
    rig::Model m(sink, env);
    auto *pool = dynamic_cast<rig::fx::ReverbPool *>(m.service("reverb"));
    REQUIRE(pool);
    rig::UnitSpec spec;
    spec.slot = rig::UnitSlot::Reverb;
    spec.patch = &m.patch();
    std::unique_ptr<rig::Unit> u(rig::makeReverb(m.env(), spec));
    auto *ru = dynamic_cast<rig::fx::ReverbUnit *>(u.get());
    REQUIRE(ru);
    CHECK(ru->slotUnit(0) == nullptr);  // not built yet: the worker has it
    pool->waitBuilds();
    auto attachOf = [&]() -> rig::Command * {
      for (auto &c : sink.cmds)
        if (c.op == rig::opOf(rig::ReverbOp::AttachKernel) && c.p.ptr) return &c;
      return nullptr;
    };
    rig::Command *c = attachOf();
    REQUIRE(c);
    u->apply(*c);
    c->p.ptr = nullptr;  // the unit owns it now
    sink.cmds.clear();
    CHECK(pool->activeKey() == "5|0.5|48000");
    // the unit renders the impulse response of the 5 s space
    struct NullEvents final : rig::EventSink {
      bool push(const rig::AudioEvent &) override { return true; }
    } ev;
    rig::Bus in, out;
    in.clear(2);
    in.ch[0][3] = in.ch[1][3] = 0.5f;
    rig::UnitIO io;
    io.in = &in;
    io.out = &out;
    double peak = 0;
    for (int q = 0; q < 200; ++q) {
      rig::RenderContext ctx{q * 128, 48000, static_cast<std::uint64_t>(q), rig::UnitSlot::Reverb, &ev};
      u->process(ctx, io);
      if (q == 0) in.clear(2);
      for (std::size_t i = 0; i < 128; ++i) peak = std::max(peak, double(std::fabs(out.ch[0][i])));
    }
    CHECK(peak > 1e-3);
    // a live size edit: debounce timer, worker build, swap
    pool->request(0.9, 0.5, 0.0);
    sink.runTimersUntil(0.31);
    pool->waitBuilds();
    sink.runTimersUntil(0.31);
    CHECK(pool->activeKey() == "8|0.5|48000");
    REQUIRE(attachOf());
    CHECK(pool->kernelBuilds() == 2);
  }
}
