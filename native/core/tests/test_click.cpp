// T07: the click sound tables, the click unit (BufferSource voices, ClickOp::Schedule / ClearAfter, level param),
// routing (main / aux 3-4 / record flag), the MIDI clock reaching rig_host.midi_send, stats, a rate-change re-attach,
// the allocation trap and the CPU cost per 128-frame quantum. Sample-exact parity with Chromium is the golden
// fixtures' job (golden.click: click-120-44 and click-90-68-countin match bit for bit).
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "api/engine.h"
#include "api/registry.h"
#include "click/click.h"
#include "click/click_math.h"
#include "click/click_service.h"
#include "doctest.h"
#include "helpers.h"
#include "runtime/rt_guard.h"

using namespace rigtest;
using namespace rig;

namespace {

std::unique_ptr<Unit> makeUnit(double sr) {
  UnitEnv env;
  env.sampleRate = sr;
  UnitSpec spec;
  spec.slot = UnitSlot::Click;
  const Registry::UnitEntry *e = Registry::global().unit(kKindClick);
  REQUIRE(e != nullptr);
  return std::unique_ptr<Unit>(e->factory(env, spec));
}

struct NullEvents final : EventSink {
  bool push(const AudioEvent &) override { return true; }
};

Command op(ClickOp o, double t, std::uint32_t aux = 0) {
  Command c{};
  c.op = opOf(o);
  c.frame = kFrameNow;
  c.target = static_cast<std::uint32_t>(UnitSlot::Click);
  c.aux = aux;
  c.f.a = t;
  return c;
}

/** Render `quanta` quanta of a lone click unit; returns the mono output. */
std::vector<float> renderUnit(Unit &u, double sr, std::size_t quanta, std::int64_t frame0 = 0) {
  NullEvents ev;
  std::vector<float> out;
  Bus bus;
  for (std::size_t q = 0; q < quanta; ++q) {
    RenderContext ctx{frame0 + static_cast<std::int64_t>(q * kQ), sr, q, UnitSlot::Click, &ev};
    UnitIO io;
    io.out = &bus;
    {
      rt::RenderScope scope;
      u.process(ctx, io);
    }
    CHECK(bus.channels == 1u);
    out.insert(out.end(), bus.ch[0], bus.ch[0] + kQ);
  }
  return out;
}

struct FakeHost {
  struct Sent {
    std::string port;
    std::vector<std::uint8_t> bytes;
    std::uint64_t at;
  };
  std::vector<Sent> sent;
  std::uint64_t nowNs = 1'000'000'000;
  std::vector<std::string> listens;
};

}  // namespace

TEST_SUITE("click") {
  TEST_CASE("click tables: 40 ms, peak-normalised to the kind's peak, cosine onset, faded to zero") {
    for (double sr : {44100.0, 48000.0, 96000.0}) {
      for (int k = 0; k < 3; ++k) {
        const auto kind = static_cast<click::TickKind>(k);
        const std::vector<float> s = click::clickSamples(sr, click::clickHz(kind), click::clickPeak(kind));
        CHECK(s.size() == static_cast<std::size_t>(std::lround(0.04 * sr)));
        float mx = 0;
        for (float v : s) mx = std::max(mx, std::fabs(v));
        CHECK(mx == doctest::Approx(click::clickPeak(kind)).epsilon(1e-7));
        CHECK(s[0] > 0.0f);
        CHECK(s.back() == 0.0f);
      }
    }
    CHECK(click::clickPeak(click::TickKind::Accent) == 0.5);
    CHECK(click::clickPeak(click::TickKind::Beat) == 0.5 * 0.55);
    CHECK(click::clickPeak(click::TickKind::Sub) == 0.5 * 0.3);
    CHECK(click::clickHz(click::TickKind::Accent) == 1980);
  }

  TEST_CASE("click unit: a scheduled click is its table times the level, ClearAfter drops, RT allocation-free") {
    const double sr = 48000;
    auto u = makeUnit(sr);
    const std::vector<float> table = click::clickSamples(sr, 1320, 0.5 * 0.55);
    const long allocs = g_rtAllocs;
    u->apply(op(ClickOp::Schedule, 0.0, 1));           // beat at frame 0
    u->apply(op(ClickOp::Schedule, 10000.0 / sr, 0));  // accent at 10000 (dropped below)
    u->apply(op(ClickOp::Schedule, 9000.0 / sr, 2));   // sub at 9000 (kept: before the threshold)
    u->apply(op(ClickOp::ClearAfter, 9500.0 / sr));
    CHECK(u->liveVoices() == 2u);
    const std::vector<float> out = renderUnit(*u, sr, 100);
    CHECK(g_rtAllocs == allocs);
    for (std::size_t i = 0; i < table.size(); ++i) {
      if (out[i] != table[i] * 0.6f) {
        CHECK(out[i] == table[i] * 0.6f);
        break;
      }
    }
    for (std::size_t i = table.size(); i < 8990; ++i) CHECK(out[i] == 0.0f);
    CHECK(out[9000] != 0.0f);
    for (std::size_t i = 10000; i < 10100; ++i) CHECK(out[i] == 0.0f);
    CHECK(u->liveVoices() == 0u);  // both ended
    // the level param is the bus gain
    REQUIRE(u->param(kClickLevel) != nullptr);
    CHECK(u->param(kClickLevel)->intrinsic() == doctest::Approx(0.6));
    CHECK(u->param(1) == nullptr);
  }

  TEST_CASE("click unit: pool of 32 voices; more than that is dropped, never allocated") {
    const double sr = 44100;
    auto u = makeUnit(sr);
    const long allocs = g_rtAllocs;
    {
      rt::RenderScope scope;
      for (int i = 0; i < 40; ++i) u->apply(op(ClickOp::Schedule, 0.5 + 0.001 * i, 0));
    }
    CHECK(g_rtAllocs == allocs);
    CHECK(u->liveVoices() == 32u);
  }

  TEST_CASE("routing: main sums into out 1-2, aux on device channels 3-4 (4-channel output), record flag") {
    for (unsigned ch : {2u, 4u}) {
      CAPTURE(ch);
      rig_config cfg;
      rig_config_init(&cfg);
      cfg.mode = RIG_MODE_OFFLINE;
      cfg.flags = RIG_FLAG_TEST_API;
      cfg.sample_rate = 48000;
      cfg.output_channels = ch;
      std::vector<std::string> msgs;
      cfg.on_event = [](void *u, const char *j, size_t n) {
        static_cast<std::vector<std::string> *>(u)->emplace_back(j, n);
      };
      cfg.event_user = &msgs;
      rig_engine *e = rig_create(&cfg, nullptr);
      REQUIRE(e);
      auto post = [&](const std::string &m) {
        msgs.clear();
        rig_post(e, m.data(), m.size());
        std::string all;
        for (auto &s : msgs) all += s;
        return all;
      };
      post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
      post(R"({"v":1,"op":"audio","action":"start","id":2})");
      post(R"({"v":1,"op":"song","id":3,"tempo":120})");
      std::string r = post(R"({"v":1,"op":"click","action":"config","id":4,"output":"aux","level":1})");
      if (ch == 4) {
        CHECK(contains(r, R"("result":{"output":"aux","auxAvailable":true})"));
      } else {
        CHECK(contains(r, R"("result":{"output":"main","auxAvailable":false})"));
        CHECK(contains(r, "no outputs 3"));  // the warning
      }
      r = post(R"({"v":1,"op":"click","action":"start","id":5,"when":0.01})");
      CHECK(contains(r, R"("result":{"t0":0.06,"downbeat":0.06})"));
      CHECK(contains(r, R"("ev":"click","running":true)"));
      std::vector<std::vector<float>> buf(4, std::vector<float>(9600));
      float *p[4] = {buf[0].data(), buf[1].data(), buf[2].data(), buf[3].data()};
      REQUIRE(rig_offline_render(e, p, ch, 9600) == RIG_OK);
      auto peak = [&](unsigned c) {
        float m = 0;
        for (float v : buf[c]) m = std::max(m, std::fabs(v));
        return m;
      };
      const std::size_t f0 = static_cast<std::size_t>(0.06 * 48000);
      if (ch == 4) {
        CHECK(peak(0) == 0.0f);
        CHECK(peak(1) == 0.0f);
        CHECK(peak(2) == doctest::Approx(0.5).epsilon(2e-3));
        CHECK(buf[2] == buf[3]);
        CHECK(buf[2][f0 - 1] == 0.0f);
        CHECK((buf[2][f0] != 0.0f || buf[2][f0 + 1] != 0.0f));
      } else {
        CHECK(peak(0) == doctest::Approx(0.5).epsilon(2e-3));
        CHECK(buf[0] == buf[1]);
        CHECK(buf[0][f0 - 1] == 0.0f);
      }
      r = post(R"({"v":1,"op":"click","action":"config","id":6,"record":true})");
      CHECK(contains(r, R"("record":true)"));
      r = post(R"({"v":1,"op":"click","action":"stop","id":7})");
      CHECK(contains(r, R"("result":{"wasRunning":true})"));
      r = post(R"({"v":1,"op":"get","what":"stats","id":8})");
      CHECK(contains(r, R"("click":{"running":false)"));
      CHECK(contains(r, R"("ticks":)"));
      rig_destroy(e);
    }
  }

  TEST_CASE("MIDI clock goes to rig_host.midi_send on the configured port ('auto' = first output), timestamped") {
    FakeHost fh;
    rig_host host{};
    host.struct_size = sizeof host;
    host.user = &fh;
    host.midi_send = [](void *u, const char *port, const uint8_t *b, size_t n, uint64_t at) {
      static_cast<FakeHost *>(u)->sent.push_back({port, std::vector<std::uint8_t>(b, b + n), at});
    };
    host.midi_listen = [](void *u, const char *ids) { static_cast<FakeHost *>(u)->listens.emplace_back(ids); };
    host.host_time_ns = [](void *u) { return static_cast<FakeHost *>(u)->nowNs; };
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.flags = RIG_FLAG_TEST_API;
    cfg.sample_rate = 48000;
    cfg.host = &host;
    rig_engine *e = rig_create(&cfg, nullptr);
    REQUIRE(e);
    auto post = [&](const std::string &m) { rig_post(e, m.data(), m.size()); };
    post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    post(R"({"v":1,"op":"audio","action":"start","id":2})");
    Engine &eng = *reinterpret_cast<Engine *>(e);
    const std::string ports = R"([{"id":"in1","name":"Keys","state":"connected","kind":"input"},
      {"id":"out7","name":"Synth","state":"connected","kind":"output"}])";
    eng.model().midiPorts(ports.data(), ports.size());
    post(R"({"v":1,"op":"config","id":3,"midiClock":{"port":"auto"}})");
    auto *svc = dynamic_cast<ClickServiceImpl *>(eng.model().service(ClickService::kName));
    REQUIRE(svc);
    CHECK(svc->clockTarget() == "out7");
    post(R"({"v":1,"op":"song","id":4,"tempo":120})");
    post(R"({"v":1,"op":"click","action":"start","id":5,"countIn":1,"when":0.1})");
    // first pump: [0, 0.3) at 48 pulses per second
    REQUIRE(!fh.sent.empty());
    CHECK(fh.sent[0].port == "out7");
    CHECK(fh.sent[0].bytes == std::vector<std::uint8_t>{0xf8});
    CHECK(fh.sent[0].at == fh.nowNs + 100'000'000);  // t = 0.1 s ahead of engine time 0
    std::size_t clocks = 0, starts = 0;
    for (const auto &s : fh.sent) clocks += s.bytes[0] == 0xf8, starts += s.bytes[0] == 0xfa;
    CHECK(clocks == 10);  // 0.1 .. 0.2875 every 1/48 s
    CHECK(starts == 0);   // the downbeat (2.1 s) is not in the window yet
    std::vector<float> l(48000 * 3), r(48000 * 3);
    float *p[2] = {l.data(), r.data()};
    REQUIRE(rig_offline_render(e, p, 2, 48000 * 3) == RIG_OK);
    starts = 0;
    for (const auto &s : fh.sent) starts += s.bytes[0] == 0xfa;
    CHECK(starts == 1);
    // by name; unknown names stop the clock without disturbing the click
    post(R"({"v":1,"op":"config","id":6,"midiClock":{"port":"Synth"}})");
    CHECK(svc->clockTarget() == "out7");
    post(R"({"v":1,"op":"config","id":7,"midiClock":{"port":"nope"}})");
    CHECK(svc->clockTarget().empty());
    post(R"({"v":1,"op":"config","id":8,"midiClock":{"port":"out7"}})");
    fh.sent.clear();
    post(R"({"v":1,"op":"click","action":"stop","id":9})");
    REQUIRE(fh.sent.size() == 1);
    CHECK(fh.sent[0].bytes == std::vector<std::uint8_t>{0xfc});
    CHECK(fh.sent[0].at == 0);  // stop now
    // midi send / listen reach the host
    post(R"({"v":1,"op":"midi","id":10,"action":"send","port":"out7","data":[176,7,100],"when":3.5})");
    REQUIRE(fh.sent.size() == 2);
    CHECK(fh.sent[1].bytes == std::vector<std::uint8_t>{176, 7, 100});
    CHECK(fh.sent[1].at == fh.nowNs + 500'000'000);  // engine time 3.0 after the render
    post(R"({"v":1,"op":"midi","id":11,"action":"listen","ids":["in1"]})");
    REQUIRE(fh.listens.size() == 1);
    CHECK(fh.listens[0] == R"(["in1"])");
    rig_destroy(e);
  }

  TEST_CASE("before audio start: config is stored and applied at attach; start answers null with a warning") {
    OfflineEngine e(48000);
    e.hello();
    std::string r = e.call(R"({"v":1,"op":"click","action":"config","id":2,"level":0.2})");
    CHECK(contains(r, R"("result":null)"));
    r = e.call(R"({"v":1,"op":"song","id":3,"tempo":90})");
    r = e.call(R"({"v":1,"op":"click","action":"start","id":4})");
    CHECK(contains(r, R"("result":null)"));
    CHECK(contains(r, "clickStart() before start()"));
    e.call(R"({"v":1,"op":"audio","action":"start","id":5})");
    r = e.call(R"({"v":1,"op":"click","action":"start","id":6})");
    CHECK(contains(r, R"("level":0.2)"));
    CHECK(contains(r, R"("bpm":90)"));
    const auto out = e.render(48000);
    float mx = 0;
    for (float v : out[0]) mx = std::max(mx, std::fabs(v));
    CHECK(mx == doctest::Approx(0.5 * 0.2).epsilon(1e-2));  // the level ramps from 0.6 at t 0 (tau 10 ms)
    // no tempo stops a running click (audio.js setTempo(null) -> retime({bpm: null}))
    r = e.call(R"({"v":1,"op":"song","id":7,"tempo":null})");
    CHECK(contains(r, R"("ev":"click","running":false)"));
  }

  TEST_CASE("rate change: the unit is rebuilt at the new rate, keeps its level and the pump reschedules") {
    OfflineEngine e(48000);
    e.hello();
    e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
    e.call(R"({"v":1,"op":"song","id":3,"tempo":240})");
    e.call(R"({"v":1,"op":"click","action":"config","id":4,"level":1})");
    e.call(R"({"v":1,"op":"click","action":"start","id":5})");
    e.render(4800);
    Engine &eng = *reinterpret_cast<Engine *>(e.e);
    const std::uint32_t attached = eng.model().stats().unitsAttached;
    AudioEvent ev{};
    ev.kind = EventKind::RateChanged;
    ev.f.a = 48000;
    ev.f.b = 48000;
    eng.model().onAudioEvent(ev);
    CHECK(eng.model().stats().unitsAttached == attached + 1);
    const auto out = e.render(48000);
    int onsets = 0;
    for (std::size_t i = 1; i < out[0].size(); ++i) onsets += out[0][i - 1] == 0.0f && out[0][i] != 0.0f;
    CHECK(onsets >= 3);  // 240 bpm: a click every 0.25 s
    float mx = 0;
    for (float v : out[0]) mx = std::max(mx, std::fabs(v));
    CHECK(mx == doctest::Approx(0.5).epsilon(1e-3));
  }

  TEST_CASE("CPU per 128-frame quantum (informational)") {
    const double sr = 48000;
    auto u = makeUnit(sr);
    NullEvents ev;
    Bus bus;
    auto run = [&](int quanta) {
      const auto t0 = std::chrono::steady_clock::now();
      for (int q = 0; q < quanta; ++q) {
        RenderContext ctx{static_cast<std::int64_t>(q) * 128, sr, static_cast<std::uint64_t>(q), UnitSlot::Click,
                          &ev};
        UnitIO io;
        io.out = &bus;
        u->process(ctx, io);
      }
      return std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count() / quanta;
    };
    const double idle = run(20000);
    u->apply(op(ClickOp::Schedule, 0.0, 0));
    u->apply(op(ClickOp::Schedule, 0.01, 1));
    const double busy = run(15);  // both voices sound for 40 ms = 15 quanta
    const double budget = 128.0 / sr * 1e9;
    MESSAGE("click unit: idle " << idle << " ns/quantum, 2 sounding voices " << busy << " ns/quantum ("
                                << 100.0 * busy / budget << " % of a core at 48 kHz)");
    CHECK(busy < budget * 0.05);
  }
}
