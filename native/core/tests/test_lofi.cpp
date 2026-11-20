// T05 lofi (kind "lofi"): the lofi-* golden fixtures (lofi-crush-sweep exact; lofi-tape-sine statistical in the
// manifest, checked here against the exact tier as well), curves and keys (fx.js tanhCurve / quantCurve /
// Lofi._keys), the seeded crackle loop, and the JS tests lofiBypassExact, lofiEngageNoClick, lofiHeadroom
// (test/phase1/engine/suites.mjs) on the unit with a stimulus in place of the instruments.
#include <cmath>
#include <set>
#include <string>
#include <vector>

#include "doctest.h"
#include "fx/lofi_unit.h"
#include "helpers.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "test_delay_util.h"

using rig::fx::LofiState;
using rig::fx::LofiUnit;

namespace {

constexpr double kSr = 44100;

rig::LofiPatch quietPatch(double amount) {  // the JS tests' lofi: no crackle, wow, flutter, saturation, bits
  rig::LofiPatch p;
  p.amount = amount;
  p.crackle = p.wow = p.flutter = p.saturation = p.bits = 0;
  return p;
}

rig::Command applyCmd(const rig::LofiPatch &p, double when) {
  LofiState *s = LofiState::make(p);
  s->when = when;
  rig::Command c{};
  c.op = rig::opOf(rig::LofiOp::Apply);
  c.sub = rig::kSubOwnedPayload;
  c.p.ptr = static_cast<rig::Owned *>(s);
  return c;
}

/** Run with the unit's own garbage handed back through the driver sink: delete it here (control side). */
void freeGarbage(t05::Driver &d) {
  for (const auto &e : d.sink.ev)
    if (e.kind == rig::EventKind::Garbage) delete static_cast<rig::Owned *>(e.ptr);
  d.sink.ev.clear();
}

std::vector<std::vector<float>> sine(double hz, double amp, std::size_t n) {
  std::vector<std::vector<float>> x(2, std::vector<float>(n));
  for (std::size_t i = 0; i < n; ++i)
    x[0][i] = x[1][i] = static_cast<float>(amp * std::sin(2 * M_PI * hz * static_cast<double>(i) / kSr));
  return x;
}

}  // namespace

TEST_SUITE("lofi") {
  TEST_CASE("golden fixtures lofi-* at the exact tier, allocation trap on") {
    for (const char *id : {"lofi-crush-sweep", "lofi-tape-sine"}) {
      const std::string sid = id;
      INFO(sid);
      const t05::GoldenResult g = t05::goldenRun(sid);
      if (!g.present) continue;
      CHECK(g.rtAllocs == 0);
      CHECK(g.peak > 0.1);
      CHECK(g.maxDiff <= 2e-4);  // exact tier (lofi-tape-sine is statistical in the manifest: report for promotion)
      if (sid == "lofi-crush-sweep") CHECK(g.maxDiff <= 2e-5);
    }
  }

  TEST_CASE("keys and curves: Lofi._keys, tanhCurve(dk) and quantCurve(bits) as fx.js computes them") {
    rig::LofiPatch p;
    p.amount = 1;
    p.saturation = 1;
    p.bits = 1;
    auto k = rig::fx::lofiKeys(p);
    CHECK(k.dk == 9);
    CHECK(k.bits == 11);
    p.amount = 0.3;
    p.saturation = 0.4;
    p.bits = 0.5;
    k = rig::fx::lofiKeys(p);
    CHECK(k.dk == rig::js::round(9 * 0.3 * 2 * 0.4 * 4) / 4);
    CHECK(k.bits == 15);  // JS Math.round(16 - 5 * .3 = 14.5) = 15
    const auto t = rig::fx::lofiTanhCurve(9);
    REQUIRE(t->v.size() == 4096);
    const double g = rig::js::pow(10, 9.0 / 20);
    CHECK(t->v[0] == static_cast<float>(rig::js::tanh(g * -4) / g * 0.25));
    CHECK(t->v[4095] == static_cast<float>(rig::js::tanh(g * 4) / g * 0.25));
    CHECK(rig::fx::lofiTanhCurve(9) == t);  // cached
    const auto q = rig::fx::lofiQuantCurve(11);
    REQUIRE(q->v.size() == 32768);
    std::set<float> levels(q->v.begin(), q->v.end());
    CHECK(levels.size() == 8193);  // +-4 in the x4 domain at 2^10 steps per unit, both ends included
    const auto t0 = rig::fx::lofiTanhCurve(0);
    CHECK(t0->v[1000] == static_cast<float>(((1000 / 4095.0) * 2 - 1) / 0.25 * 0.25));  // identity at 0 dB
  }

  TEST_CASE("crackle loop: 6 s, 60..89 impulses per channel, seeded") {
    LofiUnit a(kSr, 1, LofiState::make(quietPatch(0))), b(kSr, 1, LofiState::make(quietPatch(0)));
    LofiUnit c(kSr, 2, LofiState::make(quietPatch(0)));
    const rig::SampleBuffer &ba = a.crackleBuffer();
    CHECK(ba.frames == static_cast<std::uint64_t>(6 * kSr));
    for (unsigned ch = 0; ch < 2; ++ch) {
      int onsets = 0;
      for (std::uint64_t i = 1; i < ba.frames; ++i)
        if (ba.f32[ch][i] != 0.0f && ba.f32[ch][i - 1] == 0.0f) ++onsets;
      CHECK(onsets <= 89);
      CHECK(onsets >= 50);  // overlapping impulses merge
      bool same = true, differs = false;
      for (std::uint64_t i = 0; i < ba.frames; ++i) {
        same = same && ba.f32[ch][i] == b.crackleBuffer().f32[ch][i];
        differs = differs || ba.f32[ch][i] != c.crackleBuffer().f32[ch][i];
      }
      CHECK(same);
      CHECK(differs);
    }
  }

  TEST_CASE("lofiBypassExact: amount 0 is bit-exact; engaged then bypassed is bit-exact again, wet disconnected") {
    const std::size_t n = static_cast<std::size_t>(2.0 * kSr) / 128 * 128;
    const auto in = sine(523.25, 0.4, n);
    {
      LofiUnit u(kSr, 1, LofiState::make(quietPatch(0)));
      t05::Driver d(&u, kSr);
      const auto out = d.run(n, in);
      CHECK(rigtest::maxAbsDiff(out[0], in[0]) == 0.0);
      CHECK(rigtest::maxAbsDiff(out[1], in[1]) == 0.0);
      CHECK_FALSE(u.wetConnected());
    }
    rig::LofiPatch on;  // defaults: wow .5, flutter .5, crackle .3, bits .5, tone .5, saturation .5
    on.amount = 1;
    rig::LofiPatch off = on;
    off.amount = 0;
    LofiUnit u(kSr, 1, LofiState::make(off));
    t05::Driver d(&u, kSr);
    std::vector<std::vector<float>> out(2);
    auto seg = [&](std::size_t frames) {  // the driver reads `in` at absolute frames
      const auto o = d.run(frames, in);
      for (std::size_t c = 0; c < 2; ++c) out[c].insert(out[c].end(), o[c].begin(), o[c].end());
      freeGarbage(d);
    };
    u.apply(applyCmd(on, 0.6));
    seg(static_cast<std::size_t>(1.2 * kSr) / 128 * 128);
    CHECK(u.engaged());
    CHECK(u.wetConnected());
    u.apply(applyCmd(off, 1.2));
    seg(n - out[0].size());
    CHECK_FALSE(u.engaged());
    CHECK_FALSE(u.wetConnected());
    // darker while engaged (lofi 1 colours), exact again from 1.2 + 30 ms
    double diffOn = 0;
    for (std::size_t i = static_cast<std::size_t>(0.8 * kSr); i < static_cast<std::size_t>(1.1 * kSr); ++i)
      diffOn = std::max(diffOn, double(std::fabs(out[0][i] - in[0][i])));
    CHECK(diffOn > 0.01);
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = static_cast<std::size_t>(1.24 * kSr); i < n; ++i)
        REQUIRE(out[static_cast<std::size_t>(c)][i] == in[static_cast<std::size_t>(c)][i]);
  }

  TEST_CASE("lofiEngageNoClick: engage at 1.0 s, and engage + bypass 12 ms / 40 ms later, without spikes") {
    const std::size_t n = static_cast<std::size_t>(2.0 * kSr) / 128 * 128;
    const auto in = sine(110, 0.5, n);
    for (double bypassAfter : {-1.0, 0.012, 0.04}) {
      INFO("bypass after " << bypassAfter);
      LofiUnit u(kSr, 1, LofiState::make(quietPatch(0)));
      t05::Driver d(&u, kSr);
      auto a = d.run(static_cast<std::size_t>(1.0 * kSr) / 128 * 128, in);
      u.apply(applyCmd(quietPatch(0.3), d.now()));
      std::size_t rest = n - a[0].size();
      if (bypassAfter > 0) {
        const std::size_t k = static_cast<std::size_t>(bypassAfter * kSr) / 128 * 128 + 128;
        const auto b = d.run(k, in);
        a[0].insert(a[0].end(), b[0].begin(), b[0].end());
        u.apply(applyCmd(quietPatch(0), d.now()));
        rest -= k;
      }
      const auto c = d.run(rest, in);
      a[0].insert(a[0].end(), c[0].begin(), c[0].end());
      freeGarbage(d);
      const double base = t05::maxD2(a[0], kSr, 0.5, 0.95), ev = t05::maxD2(a[0], kSr, 0.99, 1.3);
      MESSAGE("steady d2 " << base << ", event d2 " << ev);
      CHECK(ev < 0.002);
      CHECK(ev < 5 * base);
    }
  }

  TEST_CASE("hold-only apply (Lofi.hold): engages at amount 0; mid-ramp it changes nothing else (bit-exact)") {
    auto cmd = [](LofiState *s, double when, bool holdOnly) {
      s->holdOnly = holdOnly;
      s->when = when;
      rig::Command c{};
      c.op = rig::opOf(rig::LofiOp::Apply);
      c.sub = rig::kSubOwnedPayload;
      c.p.ptr = static_cast<rig::Owned *>(s);
      return c;
    };
    const std::size_t n = 44032;
    const auto in = sine(330, 0.4, n + 12800);
    {  // amount 0: the hold alone engages and releases the wet chain
      LofiUnit u(kSr, 1, LofiState::make(quietPatch(0)));
      t05::Driver d(&u, kSr);
      d.run(12800, in);
      u.apply(cmd(LofiState::make(quietPatch(0), true), d.now(), true));
      CHECK(u.engaged());
      CHECK(u.wetConnected());
      d.run(12800, in);
      u.apply(cmd(LofiState::make(quietPatch(0), false), d.now(), true));
      CHECK_FALSE(u.engaged());
      d.run(12800, in);
      freeGarbage(d);
      CHECK_FALSE(u.wetConnected());
    }
    // engaged at 0.29 s with every curve ramping; a hold 256 frames later must not restart those ramps
    rig::LofiPatch on;
    on.amount = 0.7;
    std::vector<std::vector<float>> out[2];
    for (int k = 0; k < 2; ++k) {
      LofiUnit u(kSr, 1, LofiState::make(quietPatch(0)));
      t05::Driver d(&u, kSr);
      d.run(12800, in);
      u.apply(cmd(LofiState::make(on), d.now(), false));
      d.run(256, in);
      if (k == 1) u.apply(cmd(LofiState::make(on, true), d.now(), true));
      out[k] = d.run(n, in);
      freeGarbage(d);
    }
    CHECK(rigtest::maxAbsDiff(out[0][0], out[1][0]) == 0.0);
    CHECK(rigtest::maxAbsDiff(out[0][1], out[1][1]) == 0.0);
  }

  TEST_CASE("lofiHeadroom: +6 dBFS into the sum passes the engaged wet chain unclamped") {
    const std::size_t n = static_cast<std::size_t>(1.0 * kSr) / 128 * 128;
    LofiUnit u(kSr, 1, LofiState::make(quietPatch(0.001)));
    CHECK(u.engaged());
    t05::Driver d(&u, kSr);
    const auto out = d.run(n, sine(440, 2.0, n));
    const double pk = t05::peakAbs(out[0], kSr, 0.5, 1.0);
    MESSAGE("out peak " << pk << " (clamped would be 1)");
    CHECK(pk > 1.8);
    CHECK(pk < 2.2);
  }
}
