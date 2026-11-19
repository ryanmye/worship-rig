// wa::Param + automation helpers replayed against Chromium 157 OfflineAudioContext renders of ConstantSourceNode.offset
// (tools/golden/vectors/data/automation.txt, dumped by tools/golden/vectors/dump-automation.mjs). Every case must
// match sample by sample (bit-exact float32); the max abs error per case is printed with RIG_T01_VERBOSE=1.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "doctest.h"
#include "num_vectors.h"
#include "runtime/rt_guard.h"
#include "time/automation.h"
#include "time/param.h"

using namespace rig::wa;

namespace rigtest {
extern long g_rtAllocs;  // tests/alloc_trap.cpp
}

namespace {

std::vector<std::uint8_t> base64(const std::string &s) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::vector<std::uint8_t> out;
  std::uint32_t acc = 0;
  int nbits = 0;
  for (char c : s) {
    const int v = val(c);
    if (v < 0) continue;  // '=' padding
    acc = (acc << 6) | static_cast<std::uint32_t>(v);
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      out.push_back(static_cast<std::uint8_t>((acc >> nbits) & 0xff));
    }
  }
  return out;
}

/** Inverse of dump-automation.mjs's encoding: second differences, zero runs, zigzag, LEB128, base64. */
std::vector<float> decodeSamples(const std::string &b64, std::size_t n) {
  const auto bytes = base64(b64);
  std::vector<float> out;
  std::uint32_t prev = 0, prevD = 0;
  auto emit = [&](std::uint32_t d2) {
    const std::uint32_t d1 = prevD + d2;
    const std::uint32_t b = prev + d1;
    prevD = d1;
    prev = b;
    float f;
    std::memcpy(&f, &b, sizeof f);
    out.push_back(f);
  };
  std::size_t i = 0;
  while (i < bytes.size()) {
    std::uint64_t v = 0;
    int shift = 0;
    for (;;) {
      const std::uint8_t b = bytes[i++];
      v |= static_cast<std::uint64_t>(b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    if (v & 1) {
      for (std::uint64_t r = 0; r < (v >> 1); ++r) emit(0);
    } else {
      const auto z = static_cast<std::uint32_t>(v >> 1);
      emit((z >> 1) ^ (0u - (z & 1)));  // un-zigzag
    }
  }
  REQUIRE(out.size() == n);
  return out;
}

double num(const std::string &s) {
  if (s == "nan" || s == "NaN") return std::nan("");
  return std::strtod(s.c_str(), nullptr);
}

struct Call {
  std::size_t frame;
  std::string op;
  std::vector<double> a;
  bool throws;
};

/** Run one dumped op on p; returns false where the JS call threw. */
bool runOp(Param &p, const Call &c, std::vector<std::unique_ptr<float[]>> &curves, std::size_t &nextCurve) {
  const auto &a = c.a;
  const std::string &op = c.op;
  if (op == "set") return p.setValueAtTime(a[0], a[1]);
  if (op == "lin") return p.linearRampToValueAtTime(a[0], a[1]);
  if (op == "exp") return p.exponentialRampToValueAtTime(a[0], a[1]);
  if (op == "target") return p.setTargetAtTime(a[0], a[1], a[2]);
  if (op == "curve") {
    const auto n = static_cast<std::size_t>(a[0]);
    float *buf = curves[nextCurve++].get();  // allocated before the render scope
    const std::size_t len = equalPowerCurve(buf, n, a[1] != 0);
    return p.setValueCurveAtTime(buf, static_cast<std::uint32_t>(len), a[2], a[3]);
  }
  if (op == "cancel") return p.cancelScheduledValues(a[0]);
  if (op == "hold") return p.cancelAndHoldAtTime(a[0]);
  if (op == "value") return p.setValueAttribute(a[0]);
  if (op == "setNow") return setNow(p, a[0], a[1]);
  if (op == "rampTo") return rampTo(p, a[0], a[1], a[2]);
  if (op == "glideTo") return glideTo(p, a[0], a[1], a[2], a[3]);
  if (op == "linearTo") return linearTo(p, a[0], a[1], a[2], a[3]);
  if (op == "holdAndFade") return holdAndFade(p, a[0], a[1]);
  if (op == "linFrom") return linFrom(p, a[0], a[1], a[2], a[3]);
  if (op == "glideFrom") return glideFrom(p, a[0], a[1], a[2], a[3]);
  if (op == "equalPowerFade") return equalPowerFade(p, a[0], a[1], a[2], a[3], static_cast<int>(a[4]));
  FAIL("unknown op " << op);
  return false;
}

}  // namespace

TEST_SUITE("time") {
  TEST_CASE("automation curves: sample-exact against Chromium 157 (ConstantSourceNode.offset renders)") {
    const auto all = rigvec::lines("automation.txt");
    REQUIRE(all.size() > 100);
    const bool verbose = std::getenv("RIG_T01_VERBOSE") != nullptr;
    int cases = 0;
    double worst = 0;
    for (std::size_t li = 0; li < all.size(); ++li) {
      const auto h = rigvec::split(all[li]);
      if (h.empty() || h[0] != "case") continue;
      REQUIRE(h.size() == 13);
      const std::string name = h[1];
      const double sr = num(h[3]);
      const auto frames = static_cast<std::size_t>(num(h[5]));
      const Param::Rate rate = h[7] == "k" ? Param::Rate::KRate : Param::Rate::ARate;
      const double init = num(h[9]);
      const auto w0 = static_cast<std::size_t>(num(h[11])), w1 = static_cast<std::size_t>(num(h[12]));
      std::vector<Call> calls;
      std::string outLine;
      for (++li; li < all.size() && all[li] != "end"; ++li) {
        const auto t = rigvec::split(all[li]);
        if (t[0] == "call") {
          Call c{static_cast<std::size_t>(num(t[1])), t[2], {}, false};
          for (std::size_t k = 3; k < t.size(); ++k) {
            if (t[k] == "!throw") c.throws = true;
            else c.a.push_back(num(t[k]));
          }
          calls.push_back(c);
        } else if (t[0] == "out") {
          outLine = t.size() > 1 ? t[1] : std::string();
        }
      }
      const std::vector<float> want = decodeSamples(outLine, w1 - w0);

      // ConstantSourceNode(ctx, {offset: init}): offset default 1, intrinsic value init, no event
      Param p(1.0);
      p.setValue(init);
      std::vector<std::unique_ptr<float[]>> curves;
      for (const auto &c : calls)
        if (c.op == "curve") curves.emplace_back(new float[c.a[0] < 2 ? 2 : static_cast<std::size_t>(c.a[0])]);
      std::size_t nextCurve = 0;
      std::vector<float> got(frames);
      std::vector<int> ok(calls.size(), -1);
      const long allocsBefore = rigtest::g_rtAllocs;
      {
        // as on the audio thread: commands are inserted and rendered inside the render scope (FTZ/DAZ on, the
        // allocation trap armed)
        rig::rt::RenderScope rs;
        for (std::size_t f = 0; f < frames; f += Param::kQuantum) {
          p.setContextTime(static_cast<std::int64_t>(f), sr);
          for (std::size_t ci = 0; ci < calls.size(); ++ci)
            if (calls[ci].frame == f) ok[ci] = runOp(p, calls[ci], curves, nextCurve) ? 1 : 0;
          const std::size_t n = std::min(Param::kQuantum, frames - f);
          p.process(rate, static_cast<std::int64_t>(f), sr, got.data() + f, n);
        }
      }
      CHECK(rigtest::g_rtAllocs == allocsBefore);
      for (std::size_t ci = 0; ci < calls.size(); ++ci) {
        INFO(name << " call " << calls[ci].op << " at frame " << calls[ci].frame);
        CHECK(ok[ci] == (calls[ci].throws ? 0 : 1));
      }
      std::size_t mism = 0, first = w1;
      double maxAbs = 0;
      for (std::size_t i = w0; i < w1; ++i) {
        const float g = got[i], w = want[i - w0];
        if (rigvec::bits(g) != rigvec::bits(w)) {
          if (!mism) first = i;
          ++mism;
          maxAbs = std::max(maxAbs, static_cast<double>(std::fabs(g - w)));
        }
      }
      worst = std::max(worst, maxAbs);
      if (verbose || mism)
        std::printf("  %-24s %s-rate sr %6.0f frames %6zu  mismatches %5zu  maxAbs %.3g%s\n", name.c_str(),
                    rate == Param::Rate::KRate ? "k" : "a", sr, frames, mism, maxAbs, mism ? "  <<<" : "");
      if (mism) {
        INFO(name << ": first mismatch at frame " << first << " got " << got[first] << " want " << want[first - w0]);
        CHECK(mism == 0);
      }
      ++cases;
    }
    CHECK(cases >= 40);
    if (verbose) std::printf("  %d cases, worst max abs error %.3g\n", cases, worst);
  }
}
