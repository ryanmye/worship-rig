// T02: the slot strip (mix/slot_channel, slot_eq, width) and MasterEq. Ports of the strip parts of the JS suites
// test/phase1/engine/suites.mjs `filterQButterworth` (strip side HPF), `slotWidthEq` (width shape, width 1 / EQ 0
// identity, mono sources keep their law, legacy shelves), `dualMonoIdentity` (a dual-mono stereo input is untouched
// by width), plus resolveSlotEq (legacy rows), the SlotEq state machine (in-place moves, type fades, chain switches,
// audition) and MasterEq against the `master-eq` golden (impulse through the master EQ alone).
#include <cmath>
#include <complex>
#include <cstring>
#include <string>
#include <vector>

#include "api/registry.h"
#include "doctest.h"
#include "dsp/biquad.h"
#include "dsp/panner.h"
#include "graph/unit.h"
#include "helpers.h"
#include "io/wav.h"
#include "mix/master_eq.h"
#include "mix/slot_channel.h"
#include "mix/slot_channel_api.h"
#include "mix/slot_eq.h"
#include "mix/width.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "runtime/rt_guard.h"
#include "test_strip_vectors.h"
#include "yyjson.h"

using namespace rig;

namespace {

constexpr double kSr = 44100;

struct Sink final : EventSink {
  std::vector<AudioEvent> ev;
  bool push(const AudioEvent &e) override {
    if (ev.size() < ev.capacity()) ev.push_back(e);  // never allocates inside a render scope
    return true;
  }
  void freeGarbage() {
    for (const auto &e : ev)
      if (e.kind == EventKind::Garbage && e.aux == static_cast<std::uint32_t>(GarbageKind::Owned))
        delete static_cast<Owned *>(e.ptr);
    ev.clear();
  }
};

/** A SlotChannel built through the registry factory from a JSON slot (patch.cpp parsing), rendered quantum by
 *  quantum with an input generator. */
struct Strip {
  PatchSpec patch;
  Unit *u = nullptr;
  Sink sink;
  std::int64_t frame = 0;
  explicit Strip(const char *slotJson, double sr = kSr) {
    const std::string pj = std::string("{\"slots\":[") + slotJson + "]}";
    yyjson_doc *d = yyjson_read(pj.data(), pj.size(), 0);
    REQUIRE(parsePatch(yyjson_doc_get_root(d), patch, nullptr));
    yyjson_doc_free(d);
    ensureModulesRegistered();
    const Registry::UnitEntry *e = Registry::global().unit(kKindStrip);
    REQUIRE(e);
    CHECK(e->priority == kModulePriority);  // the module strip replaced the builtin one
    UnitEnv env;
    env.sampleRate = sr;
    UnitSpec spec;
    spec.slot = UnitSlot::Strip0;
    spec.channel = 0;
    spec.patch = &patch;
    u = e->factory(env, spec);
    REQUIRE(u);
    u->setSampleRate(sr);
    u->param(kStripFader)->setValue(1.0);
    sink.ev.reserve(256);
  }
  ~Strip() {
    sink.freeGarbage();
    delete u;
  }
  Strip(const Strip &) = delete;
  Strip &operator=(const Strip &) = delete;
  void op(Command c) {
    c.frame = frame;
    u->apply(c);
  }
  /** Render `frames` (multiple of 128) of a 1- or 2-channel input; returns L, R. */
  std::vector<std::vector<float>> run(const std::vector<std::vector<float>> &in, std::size_t frames,
                                      double sr = kSr) {
    std::vector<std::vector<float>> out(2, std::vector<float>(frames));
    for (std::size_t q = 0; q < frames; q += kQ) {
      Bus bin, bout, sends[3];
      bin.clear(static_cast<unsigned>(in.size()));
      for (std::size_t c = 0; c < in.size(); ++c) std::memcpy(bin.ch[c], in[c].data() + q, sizeof bin.ch[c]);
      for (auto &s : sends) s.clear(2);
      UnitIO io;
      io.in = &bin;
      io.out = &bout;
      for (unsigned k = 0; k < 3; ++k) io.sends[k] = &sends[k];
      RenderContext ctx{frame, sr, static_cast<std::uint64_t>(frame / 128), UnitSlot::Strip0, &sink};
      const long before = rigtest::g_rtAllocs;
      {
        rt::RenderScope scope;
        u->process(ctx, io);
      }
      CHECK(rigtest::g_rtAllocs == before);
      for (int c = 0; c < 2; ++c) std::memcpy(out[c].data() + q, bout.ch[c], sizeof bout.ch[c]);
      frame += static_cast<std::int64_t>(kQ);
      sink.freeGarbage();
    }
    return out;
  }
};

std::vector<float> sine(double hz, double amp, std::size_t n, double sr = kSr) {
  std::vector<float> x(n);
  for (std::size_t i = 0; i < n; ++i) x[i] = static_cast<float>(amp * std::sin(2 * js::kPi * hz * i / sr));
  return x;
}

/** Magnitude of the `hz` component of x[a..b) (single-bin DFT). */
double band(const std::vector<float> &x, double hz, std::size_t a, std::size_t b, double sr = kSr) {
  std::complex<double> s = 0;
  for (std::size_t i = a; i < b; ++i) s += static_cast<double>(x[i]) * std::polar(1.0, -2 * js::kPi * hz * i / sr);
  return std::abs(s) * 2 / static_cast<double>(b - a);
}

double magDb(const wa::BiquadCoeffs &c, double hz, double sr = kSr) {
  const std::complex<double> z = std::polar(1.0, -2.0 * js::kPi * hz / sr);
  return 20 * std::log10(std::abs((c.b0 + c.b1 * z + c.b2 * z * z) / (1.0 + c.a1 * z + c.a2 * z * z)));
}

SlotEqSpec specOf(const char *eqJson) {
  yyjson_doc *d = yyjson_read(eqJson, std::strlen(eqJson), 0);
  SlotEqSpec s;
  parseSlotEqJson(yyjson_doc_get_root(d), s);
  yyjson_doc_free(d);
  return s;
}

Command eqCmd(const SlotEqSpec &spec, double when, bool step = false) {
  auto *p = new SlotEqChange();
  p->spec = spec;
  p->when = when;
  p->step = step;
  Command c{};
  c.op = opOf(StripOp::SetEq);
  c.sub = kSubOwnedPayload;
  c.aux = kEqChangeSet;
  c.p.ptr = static_cast<Owned *>(p);
  return c;
}

}  // namespace

TEST_SUITE("strip") {
  TEST_CASE("resolveSlotEq: PARAMS defaults, legacy rows per band, b-rows win, double clamp") {
    const SlotEqSpec &d = defaultSlotEqSpec();
    CHECK((d.bands[0].on && d.bands[0].type == EqLowshelf && d.bands[0].hz == 120 && d.bands[0].db == 0));
    CHECK((d.bands[7].on && d.bands[7].type == EqHighshelf && d.bands[7].hz == 6000));
    for (int k = 1; k < 7; ++k) CHECK(!d.bands[k].on);
    CHECK((d.cutHz == 20 && d.hiCutHz == 20000));
    // legacy: b1 <- low/lowHz, b2 <- mid1* (400 Hz default), b3 <- mid2*, b8 <- high/highHz
    SlotEqSpec l = specOf(R"({"low":5,"high":-4,"mid1":6,"mid2Q":0.7,"cutHz":80})");
    CHECK((l.bands[0].type == EqLowshelf && l.bands[0].db == 5 && l.bands[0].hz == 120));
    CHECK((l.bands[1].on && l.bands[1].type == EqPeak && l.bands[1].hz == 400 && l.bands[1].db == 6 &&
           l.bands[1].q == 1));
    CHECK((l.bands[2].on && l.bands[2].hz == 2500 && l.bands[2].q == doctest::Approx(0.7) && l.bands[2].db == 0));
    CHECK((l.bands[7].db == -4 && l.bands[7].hz == 6000));
    CHECK(l.cutHz == 80);
    CHECK(!l.bands[3].on);
    // a band with a stored b-row takes PARAMS defaults for the rest and ignores the legacy rows
    SlotEqSpec b = specOf(R"({"mid1":6,"b2":{"db":3}})");
    CHECK((!b.bands[1].on && b.bands[1].hz == 210 && b.bands[1].db == 3));
    // clamps: legacy row range first (low +-12), then the band row
    SlotEqSpec c = specOf(R"({"low":30,"lowHz":5})");
    CHECK((c.bands[0].db == 12 && c.bands[0].hz == 40));
    // storeSlotEqRow (live `set`) resolves like parsing the same sparse object
    SlotEqSpec s = defaultSlotEqSpec();
    storeSlotEqRow(s, "mid1", 6);
    storeSlotEqRow(s, "b5.type", EqNotch);
    storeSlotEqRow(s, "b5.on", 1);
    const SlotEqSpec p = specOf(R"({"mid1":6,"b5":{"type":"notch","on":true}})");
    for (int k = 0; k < kEqBands; ++k) {
      CHECK(s.bands[k].on == p.bands[k].on);
      CHECK(s.bands[k].type == p.bands[k].type);
      CHECK(s.bands[k].hz == p.bands[k].hz);
      CHECK(s.bands[k].db == p.bands[k].db);
    }
    CHECK(!storeSlotEqRow(s, "nope", 1));
  }

  TEST_CASE("filterQButterworth (strip parts): side HPF and cut filters are Butterworth, 2-pole slope") {
    const double q = 20 * js::log10(js::kSqrt1_2);
    const wa::BiquadCoeffs hp = wa::biquadCoeffs(wa::BiquadType::Highpass, Width::kSideHpHz, q, 0, kSr);
    CHECK(magDb(hp, 150) == doctest::Approx(-3.01).epsilon(0.05 / 3.01));
    CHECK(magDb(hp, 75) < -11.5);
    CHECK(magDb(hp, 75) > -13);
    double peak = -1e9;
    for (double f = 20; f < 20000; f *= 1.01) peak = std::fmax(peak, magDb(hp, f));
    CHECK(peak < 0.02);
    EqFilter f[kMaxEqFilters];
    const SlotEqSpec s = specOf(R"({"cutHz":80,"hiCutHz":12000})");
    const std::size_t n = buildEqChain(s, f);
    REQUIRE(n == 4);  // lc, b1, b8, hc
    CHECK(magDb(wa::biquadCoeffs(f[0].type, f[0].hz, f[0].q, 0, kSr), 80) == doctest::Approx(-3.01).epsilon(0.02));
    CHECK(magDb(wa::biquadCoeffs(f[3].type, f[3].hz, f[3].q, 0, kSr), 12000) ==
          doctest::Approx(-3.01).epsilon(0.02));
  }

  TEST_CASE("slotWidthEq (1): L-only tones through the strip; w <= 1 scales the side, w > 1 widens above 150 Hz") {
    const std::size_t n = 44100;
    std::vector<float> L(n), R(n, 0.0f);
    const std::vector<float> a = sine(1000, 0.25, n), b = sine(60, 0.25, n);
    for (std::size_t i = 0; i < n; ++i) L[i] = a[i] + b[i];
    auto render = [&](double w) {
      std::string js = R"({"instrument":{"type":"test","id":"sine"},"gain":1,"width":)" + std::to_string(w) + "}";
      Strip s(js.c_str());
      return s.run({L, R}, n - n % kQ);
    };
    const auto ref = render(1);
    const std::size_t a0 = static_cast<std::size_t>(0.4 * kSr), a1 = static_cast<std::size_t>(0.9 * kSr);
    auto rel = [&](const std::vector<float> &x, double f) { return band(x, f, a0, a1) / band(ref[0], f, a0, a1); };
    const auto w0 = render(0), w5 = render(0.5), w15 = render(1.5);
    // expected (L-only input): L' = a(1+w)/2, R' = a(1-w)/2 for w <= 1; w 1.5 at 1 kHz: 1.25 / 0.25; 60 Hz ~ not
    // widened (2-pole side HPF leaves ~0.97 / 0.03)
    CHECK(rel(w0[0], 1000) == doctest::Approx(0.5).epsilon(0.04));
    CHECK(rel(w0[1], 1000) == doctest::Approx(0.5).epsilon(0.04));
    CHECK(rel(w0[0], 60) == doctest::Approx(0.5).epsilon(0.04));
    CHECK(rel(w5[0], 1000) == doctest::Approx(0.75).epsilon(0.03));
    CHECK(rel(w5[1], 1000) == doctest::Approx(0.25).epsilon(0.08));
    CHECK(rel(w15[0], 1000) == doctest::Approx(1.25).epsilon(0.02));
    CHECK(rel(w15[1], 1000) == doctest::Approx(0.25).epsilon(0.08));
    CHECK(rel(w15[0], 60) == doctest::Approx(1).epsilon(0.05));
    CHECK(rel(w15[1], 60) < 0.05);
  }

  TEST_CASE("slotWidthEq (2): width 1 + EQ at 0 dB = fader -> pan; mono source and dual-mono ignore width") {
    const std::size_t n = 128 * 200;
    const std::vector<float> L = t02::input(0, n, kSr, 0.3), R = t02::input(1, n, kSr, 0.3);
    Strip s(R"({"instrument":{"type":"test","id":"sine"},"gain":1,"pan":0.3})");
    const auto out = s.run({L, R}, n);
    // the old strip: StereoPanner(0.3) on the input (fader 1): two 0 dB shelves are the identity up to float rounding
    wa::StereoPanner p(0.3);
    std::vector<float> l(n), r(n);
    for (std::size_t q = 0; q < n; q += kQ) {
      const float *in[2] = {L.data() + q, R.data() + q};
      p.process(in, 2, l.data() + q, r.data() + q, kQ, static_cast<std::int64_t>(q), kSr);
    }
    CHECK(std::fmax(rigtest::maxAbsDiff(out[0], l), rigtest::maxAbsDiff(out[1], r)) <= 2e-6);
    // mono source at width .5 == width 1 (S = 0 and the channel count stays 1: mono pan law)
    Strip m1(R"({"instrument":{"type":"test","id":"sine"},"gain":1,"pan":-0.4})");
    Strip m5(R"({"instrument":{"type":"test","id":"sine"},"gain":1,"pan":-0.4,"width":0.5})");
    const auto o1 = m1.run({L}, n), o5 = m5.run({L}, n);
    CHECK(o1 == o5);
    // dual-mono stereo (L == R): M = L exactly, S = 0, so any width is the identity
    Strip d1(R"({"instrument":{"type":"test","id":"sine"},"gain":1})");
    Strip d7(R"({"instrument":{"type":"test","id":"sine"},"gain":1,"width":0.7})");
    Strip d15(R"({"instrument":{"type":"test","id":"sine"},"gain":1,"width":1.5})");
    const auto e1 = d1.run({L, L}, n), e7 = d7.run({L, L}, n), e15 = d15.run({L, L}, n);
    CHECK(e1 == e7);
    CHECK(e1 == e15);
  }

  TEST_CASE("slotWidthEq (3): legacy shelves low +6 / high -6 shape the strip (120 Hz low, 6 kHz high shelf)") {
    const SlotEqSpec s = specOf(R"({"low":6,"high":-6})");
    EqFilter f[kMaxEqFilters];
    REQUIRE(buildEqChain(s, f) == 2);
    auto tot = [&](double hz) {
      double t = 0;
      for (int i = 0; i < 2; ++i) t += magDb(wa::biquadCoeffs(f[i].type, f[i].hz, f[i].q, f[i].db, kSr), hz);
      return t;
    };
    CHECK(tot(30) == doctest::Approx(6).epsilon(0.35 / 6));
    CHECK(tot(120) == doctest::Approx(3).epsilon(0.2 / 3));
    CHECK(tot(6000) == doctest::Approx(-3).epsilon(0.2 / 3));
    CHECK(tot(16000) == doctest::Approx(-6).epsilon(0.35 / 6));
  }

  TEST_CASE("SlotEq state machine: in-place moves, peak/shelf fade, chain switch with warm-up and crossfade") {
    SlotEqSpec want = specOf(R"({"b3":{"on":true,"type":"peak","hz":600,"db":9,"q":2}})");
    SlotEqChains eq(want);
    REQUIRE(eq.filters() == 3);  // b1, b3, b8
    std::vector<float> x = t02::input(0, 128 * 400, kSr, 0.2);
    std::int64_t f = 0;
    auto step = [&](int quanta) {
      for (int i = 0; i < quanta; ++i, f += 128) {
        float *ch[1] = {x.data() + f};
        eq.process(ch, 1, 128, f, kSr);
      }
    };
    step(10);
    // gain / Hz in place: no switch
    want.bands[2].db = -3;
    want.bands[2].hz = 900;
    eq.set(want, f / kSr, false, f, kSr);
    CHECK((eq.chains() == 1 && eq.switches() == 0 && eq.pendingTimers() == 0));
    // peak -> low shelf: in-place type fade (one timer), no switch
    want.bands[2].type = EqLowshelf;
    eq.set(want, f / kSr, false, f, kSr);
    CHECK((eq.chains() == 1 && eq.switches() == 0 && eq.pendingTimers() == 1));
    step(20);  // > 30 ms: the swap ran
    CHECK(eq.pendingTimers() == 0);
    // -> notch: a cut / notch cannot be reached in place: second chain, 50 ms warm + 30 ms crossfade
    want.bands[2].type = EqNotch;
    const double t0 = f / kSr;
    eq.set(want, t0, false, f, kSr);
    CHECK((eq.chains() == 2 && eq.switches() == 1));
    const auto doneAt = static_cast<std::int64_t>(std::ceil((t0 + 0.085) * kSr / 128 - 1e-6)) * 128;
    while (f < doneAt) {
      CHECK(eq.chains() == 2);
      step(1);
    }
    step(1);
    CHECK((eq.chains() == 1 && eq.filters() == 3));
    // adding a band = switch; a step (fresh channel) rebuilds at once
    want.bands[4].on = true;
    eq.set(want, f / kSr, true, f, kSr);
    CHECK((eq.chains() == 1 && eq.filters() == 4 && eq.switches() == 1));
    bool finite = true;
    for (float v : x) finite = finite && std::isfinite(v);
    CHECK(finite);
  }

  TEST_CASE("SlotEq timers: 16 type fades during a chain switch (17 live timers) all complete (T02 review)") {
    // 8 bells; a cut starts a switch (2 chains), then every band turns peak -> shelf in place on both chains
    const char *bells = R"({"b1":{"type":"peak","hz":100,"db":6},"b2":{"on":true,"hz":200,"db":6},)"
                        R"("b3":{"on":true,"hz":400,"db":6},"b4":{"on":true,"hz":800,"db":6},)"
                        R"("b5":{"on":true,"hz":1600,"db":6},"b6":{"on":true,"hz":3200,"db":6},)"
                        R"("b7":{"on":true,"hz":6400,"db":6},"b8":{"type":"peak","hz":12000,"db":6}})";
    SlotEqSpec want = specOf(bells);
    SlotEqChains eq(want);
    const std::size_t n = 128 * 600;
    std::vector<float> x = sine(700, 0.2, n);
    std::int64_t f = 0;
    auto step = [&](int quanta) {
      for (int i = 0; i < quanta; ++i, f += 128) {
        float *ch[1] = {x.data() + f};
        eq.process(ch, 1, 128, f, kSr);
      }
    };
    step(10);
    want.cutHz = 60;
    want.cutStored = true;
    eq.set(want, f / kSr, false, f, kSr);
    REQUIRE(eq.chains() == 2);
    step(1);
    for (int k = 0; k < kEqBands; ++k) want.bands[k].type = k % 2 ? EqHighshelf : EqLowshelf;
    eq.set(want, f / kSr, false, f, kSr);
    CHECK(eq.pendingTimers() == 17);
    step(150);  // > 85 ms switch + the re-check switch + 2 x 30 ms fades
    CHECK((eq.chains() == 1 && eq.pendingTimers() == 0));
    // settled: the same output as a chain built directly at the target (no node left at 0 dB mid-fade)
    SlotEqChains ref(want);
    std::vector<float> y = sine(700, 0.2, n);
    for (std::int64_t g = 0; g < f; g += 128) {
      float *ch[1] = {y.data() + g};
      ref.process(ch, 1, 128, g, kSr);
    }
    double d = 0;
    for (std::int64_t i = f - 4096; i < f; ++i)
      d = std::fmax(d, std::fabs(x[static_cast<std::size_t>(i)] - y[static_cast<std::size_t>(i)]));
    CHECK(d < 1e-4);
  }

  TEST_CASE("eqAudition: bypass plays the flat EQ, 'on' restores the stored one, repeated modes are no-ops") {
    const std::size_t n = 128 * 120;
    const std::vector<float> L = t02::input(0, n, kSr, 0.3);
    Strip flat(R"({"instrument":{"type":"test","id":"sine"},"gain":1})");
    Strip a(R"({"instrument":{"type":"test","id":"sine"},"gain":1,"eq":{"b3":{"on":true,"db":12,"hz":800}}})");
    Command bypass{};
    bypass.op = opOf(StripOp::EqAudition);
    bypass.aux = 1;
    bypass.f.b = 0;
    a.op(bypass);
    a.op(bypass);  // same mode again: nothing
    const auto oa = a.run({L}, n), of = flat.run({L}, n);
    // bypassed at t = 0: the bell is an identity type, so it stays wired and ramps to 0 dB in place (tau 15 ms,
    // pinned at 12 tau = 180 ms); from then on the audition is the flat strip (a 0 dB peaking biquad: float rounding)
    const std::size_t from = static_cast<std::size_t>(0.2 * kSr);
    double d = 0;
    for (std::size_t i = from; i < n; ++i) d = std::fmax(d, std::fabs(oa[0][i] - of[0][i]));
    CHECK(d < 2e-6);
    Command on = bypass;
    on.aux = 0;
    on.f.b = static_cast<double>(a.frame) / kSr;
    a.op(on);
    const auto ob = a.run({L}, n);
    double e = 0;
    for (std::size_t i = from; i < n; ++i) e = std::fmax(e, std::fabs(ob[0][i] - of[0][i]));
    CHECK(e > 0.01);  // the +12 dB bell is back
  }

  TEST_CASE("SetEq payloads are handed back (Garbage) and the strip never allocates on the audio thread") {
    Strip s(R"({"instrument":{"type":"test","id":"sine"},"gain":1})");
    const std::vector<float> L = t02::input(0, 128 * 50, kSr, 0.3);
    s.op(eqCmd(specOf(R"({"b4":{"on":true,"type":"highcut","hz":3000}})"), 0));
    s.op(eqCmd(specOf(R"({"cutHz":100})"), 0.01));
    s.sink.ev.reserve(64);
    std::size_t garbage = 0;
    for (int q = 0; q < 50; ++q) {
      Bus bin, bout;
      bin.clear(1);
      std::memcpy(bin.ch[0], L.data() + q * 128, sizeof bin.ch[0]);
      UnitIO io;
      io.in = &bin;
      io.out = &bout;
      RenderContext ctx{s.frame, kSr, 0, UnitSlot::Strip0, &s.sink};
      const long before = rigtest::g_rtAllocs;
      {
        rt::RenderScope scope;
        s.u->process(ctx, io);
      }
      CHECK(rigtest::g_rtAllocs == before);
      for (const auto &e : s.sink.ev) garbage += e.kind == EventKind::Garbage ? 1 : 0;
      s.sink.freeGarbage();
      s.frame += 128;
    }
    CHECK(garbage == 2);
  }

  TEST_CASE("MasterEq: impulse through the master EQ alone = the master-eq golden (fx.eq low 6 / mid -4 / high 3)") {
    io::WavData g;
    std::string err;
    REQUIRE_MESSAGE(io::readWav(std::string(RIG_REPO_DIR) + "/native/golden/smoke/master-eq.wav", g, &err), err);
    REQUIRE(g.ch.size() == 2);
    const std::size_t n = g.frames();
    MasterEq eq(kSr, 6, -4, 3);
    std::vector<std::vector<float>> out(2, std::vector<float>(n));
    const auto lead = static_cast<std::size_t>(std::lround(0.25 * kSr));  // inject start + the stimulus lead-in
    const std::size_t at = lead + lead;
    for (std::size_t q = 0; q < n; q += kQ) {
      Bus b;
      b.clear(2);
      if (at >= q && at < q + kQ) b.ch[0][at - q] = b.ch[1][at - q] = 0.5f;
      eq.process(b, static_cast<std::int64_t>(q), kSr);
      for (int c = 0; c < 2; ++c)
        for (std::size_t i = 0; i < kQ && q + i < n; ++i) out[c][q + i] = b.ch[c][i];
    }
    const double d = std::fmax(rigtest::maxAbsDiff(out[0], g.ch[0]), rigtest::maxAbsDiff(out[1], g.ch[1]));
    MESSAGE("master-eq: max diff " << d);
    CHECK(d <= 1e-7);
    // the gains are the master chain's params (kMasterEqLow/Mid/High)
    REQUIRE(eq.gain(0));
    CHECK(eq.gain(0)->intrinsic() == 6);
    CHECK(eq.gain(3) == nullptr);
  }
}
