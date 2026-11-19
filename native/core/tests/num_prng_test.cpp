// PRNG, hashSeed, rngFor, String(n) and ToUint32 vs prng.js / fx.js in the golden Chromium
// (tools/golden/vectors/data/prng.txt).
#include <cmath>
#include <map>
#include <string>
#include <vector>

#include "doctest.h"
#include "num/js_number.h"
#include "num/prng.h"
#include "num_vectors.h"

using rigvec::hexToDouble;

namespace {
std::vector<double> hexList(const std::vector<std::string> &t, std::size_t from, std::size_t to) {
  std::vector<double> v;
  for (std::size_t i = from; i < to; ++i) v.push_back(hexToDouble(t[i]));
  return v;
}
}  // namespace

TEST_SUITE("num") {
  TEST_CASE("prng vectors: hashSeed, mulberry32, createRng helpers, rngFor, String(n), >>> 0") {
    const auto all = rigvec::lines("prng.txt");
    REQUIRE(all.size() > 2000);
    std::map<std::string, int> counted;
    std::map<std::uint32_t, rig::Rng> rngs;  // stream state per seed for the `rng` lines (in file order)
    for (const auto &l : all) {
      const auto t = rigvec::split(l);
      INFO(l);
      const std::string &k = t[0];
      ++counted[k];
      if (k == "hash") {
        const std::string s = t.size() == 3 ? t[1] : std::string();
        CHECK(rig::hashSeed(s) == std::stoul(t.back()));
      } else if (k == "hash16") {
        std::u16string s;
        std::size_t p = 0;
        while (p < t[1].size()) {
          const std::size_t c = t[1].find(',', p);
          s.push_back(static_cast<char16_t>(std::stoul(t[1].substr(p, c - p), nullptr, 16)));
          if (c == std::string::npos) break;
          p = c + 1;
        }
        CHECK(rig::hashSeed(std::u16string_view(s)) == std::stoul(t[2]));
      } else if (k == "mul") {
        rig::Mulberry32 g(static_cast<std::uint32_t>(std::stoul(t[1])));
        for (const double v : hexList(t, 2, t.size())) CHECK(g.next() == v);
      } else if (k == "rng") {
        const auto seed = static_cast<std::uint32_t>(std::stoul(t[1]));
        auto it = rngs.find(seed);
        if (it == rngs.end()) it = rngs.emplace(seed, rig::Rng(seed)).first;
        rig::Rng &g = it->second;
        const std::string &op = t[2];
        std::vector<double> args;
        if (t[3] != "-") {
          std::size_t p = 0;
          while (p <= t[3].size()) {
            const std::size_t c = t[3].find(',', p);
            args.push_back(std::stod(t[3].substr(p, c - p)));
            if (c == std::string::npos) break;
            p = c + 1;
          }
        }
        const auto want = hexList(t, 5, t.size());
        if (op == "next") CHECK(g.next() == want[0]);
        else if (op == "range") CHECK(g.range(args[0], args[1]) == want[0]);
        else if (op == "int") CHECK(g.integer(args[0], args[1]) == want[0]);
        else if (op == "gaussian") CHECK(g.gaussian() == want[0]);
        else if (op == "pick") CHECK(static_cast<double>(g.pickIndex(static_cast<std::size_t>(args[0]))) == want[0]);
        else if (op == "shuffle") {
          std::vector<int> a(static_cast<std::size_t>(args[0]));
          for (std::size_t i = 0; i < a.size(); ++i) a[i] = static_cast<int>(i);
          g.shuffle(a.data(), a.size());
          REQUIRE(want.size() == a.size());
          for (std::size_t i = 0; i < a.size(); ++i) CHECK(a[i] == want[i]);
        } else if (op == "fork") {
          rig::Rng f = g.fork();
          CHECK(static_cast<double>(f.seed()) == want[0]);
          CHECK(f.next() == want[1]);
          CHECK(f.next() == want[2]);
        } else {
          FAIL("unknown op " << op);
        }
      } else if (k == "rngfor") {
        rig::Rng g = rig::rngFor(static_cast<std::uint32_t>(std::stoul(t[1])), t[2]);
        for (const double v : hexList(t, 3, t.size())) CHECK(g.next() == v);
      } else if (k == "str") {
        CHECK(rig::js::numberToString(hexToDouble(t[1])) == t[2]);
      } else if (k == "u32") {
        CHECK(rig::toUint32(hexToDouble(t[1])) == std::stoul(t[2]));
      } else {
        FAIL("unknown line kind " << k);
      }
    }
    CHECK(counted["hash"] > 100);
    CHECK(counted["hash16"] == 5);
    CHECK(counted["mul"] == 8);
    CHECK(counted["rng"] > 50);
    CHECK(counted["rngfor"] == 12);
    CHECK(counted["str"] > 1000);
    CHECK(counted["u32"] > 1000);
  }

  TEST_CASE("String(n) basics and the RT-safe buffer form") {
    using rig::js::numberToString;
    CHECK(numberToString(44100) == "44100");
    CHECK(numberToString(0.30000000000000004) == "0.30000000000000004");
    CHECK(numberToString(1e21) == "1e+21");
    CHECK(numberToString(1e-7) == "1e-7");
    CHECK(numberToString(123e-20) == "1.23e-18");
    CHECK(numberToString(-0.0) == "0");
    CHECK(numberToString(-INFINITY) == "-Infinity");
    CHECK(numberToString(5e-324) == "5e-324");
    CHECK(numberToString(-1.7976931348623157e308) == "-1.7976931348623157e+308");
    char buf[rig::js::kNumberToStringMax];
    CHECK(std::string(buf, numberToString(0.1, buf)) == "0.1");
  }

  TEST_CASE("rngFor builds the JS seed string") {
    // fx.js rngFor(seed, name) = createRng(hashSeed(`${seed >>> 0}|${name}`))
    CHECK(rig::rngFor(7, "drone").seed() == rig::hashSeed("7|drone"));
    CHECK(rig::Rng("1|chorus").seed() == rig::hashSeed("1|chorus"));
    std::string key = "1|ir|";
    rig::appendJs(key, 2.5);
    key += '|';
    rig::appendJs(key, 0.3);
    key += '|';
    rig::appendJs(key, 48000);
    CHECK(key == "1|ir|2.5|0.3|48000");
  }
}
