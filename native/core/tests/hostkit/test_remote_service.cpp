// Remote service (remote lane, D45; REMOTE.md §2.3): pairing, limits, Lock, mapping, dedupe and the view, on a fake
// clock and a scripted random source.
#include <cstdint>
#include <cstring>
#include <set>
#include <string>
#include <vector>

#include "doctest.h"
#include "remote_service.h"

using namespace rig::hostkit::remote;

namespace {

struct Rig {
  std::int64_t t = 1000000;
  std::uint32_t counter = 0;
  std::vector<std::uint32_t> script;  // returned first (as 4-byte words), then a counter-based stream
  Service svc;
  explicit Rig(Limits l = {})
      : svc(l, [this] { return t; }, [this](std::uint8_t *p, std::size_t n) { fill(p, n); }) {}
  void fill(std::uint8_t *p, std::size_t n) {
    for (std::size_t i = 0; i < n; i += 4) {
      std::uint32_t w;
      if (!script.empty()) {
        w = script.front();
        script.erase(script.begin());
      } else {
        w = 2654435761u * ++counter;
      }
      for (std::size_t k = 0; k < 4 && i + k < n; ++k) p[i + k] = static_cast<std::uint8_t>(w >> (8 * k));
    }
  }
  std::string pairOk(const std::string &ip = "192.168.1.20") {
    PairResult r = svc.pair(ip, svc.code());
    REQUIRE(r.status == 200);
    return r.token;
  }
};

std::string state(const std::string &extra = "") {
  return R"({"v":1,"current":{"id":"a","name":"Goodness of God","key":"A"},"modes":[],"master":1,"masterDb":0,)"
         R"("droneOn":false,"droneKey":"A","audio":"running","latencyMs":5,"midi":{"connected":false,"name":null},)"
         R"("lowResource":false,"recording":false,"windowVisible":true,"memoryMB":null)"
         + extra + "}";
}
/** JS String.prototype.replace with a string pattern (first match). */
std::string rep(std::string s, const std::string &from, const std::string &to) {
  const std::size_t i = s.find(from);
  REQUIRE(i != std::string::npos);
  return s.replace(i, from.size(), to);
}
std::string cmd(const std::string &c, const std::string &id) { return R"({"cmd":")" + c + R"(","id":")" + id + "\"}"; }

}  // namespace

TEST_SUITE("hostkit-remote-service") {
  TEST_CASE("codes: 6 digits with leading zeros, uniform by rejection, a new code differs") {
    Rig r;
    CHECK(r.svc.code().size() == 6);
    r.script = {0xFFFFFFFFu, 42};  // above the rejection limit, then 42 → "000042"
    r.svc.newCode();
    CHECK(r.svc.code() == "000042");
    r.script = {42, 43};  // the same code again is skipped
    r.svc.newCode();
    CHECK(r.svc.code() == "000043");
    std::set<std::string> seen;
    for (int i = 0; i < 200; ++i) {
      r.svc.newCode();
      seen.insert(r.svc.code());
    }
    CHECK(seen.size() > 190);
  }

  TEST_CASE("pairing: right code → a 32-hex token; wrong code → 403; bad format → 400 and not counted") {
    Rig r;
    const std::uint64_t v0 = r.svc.infoVersion();
    PairResult bad = r.svc.pair("10.0.0.2", "12a456");
    CHECK(bad.status == 400);
    CHECK(bad.error == "bad-code-format");
    CHECK(r.svc.pair("10.0.0.2", "1234567").status == 400);
    CHECK(r.svc.pair("10.0.0.2", "").status == 400);
    const std::string wrong = r.svc.code() == "000000" ? "000001" : "000000";
    CHECK(r.svc.pair("10.0.0.2", wrong).status == 403);
    const std::string tok = r.pairOk("10.0.0.2");
    CHECK(tok.size() == 32);
    CHECK(tok.find_first_not_of("0123456789abcdef") == std::string::npos);
    CHECK(r.svc.tokenValid(tok));
    CHECK_FALSE(r.svc.tokenValid(tok.substr(0, 31)));
    CHECK_FALSE(r.svc.tokenValid(""));
    CHECK(r.svc.pairedCount() == 1);
    CHECK(r.svc.infoVersion() > v0);
    CHECK(r.pairOk("10.0.0.2") != tok);  // the same code pairs a second phone
  }

  TEST_CASE("brute force: 5 wrong codes per IP per minute; 20 in total rotate the code and pause pairing") {
    Limits l;
    Rig r(l);
    const std::string code = r.svc.code();
    const std::string wrong = code == "000000" ? "000001" : "000000";
    for (int i = 0; i < 5; ++i) CHECK(r.svc.pair("10.0.0.9", wrong).status == 403);
    PairResult blocked = r.svc.pair("10.0.0.9", code);  // even the right code: the IP is out of tries
    CHECK(blocked.status == 429);
    CHECK(blocked.error == "too-many-tries");
    CHECK(blocked.retryAfterSec == 60);
    r.t += 30000;
    CHECK(r.svc.pair("10.0.0.9", code).retryAfterSec == 30);
    r.t += 30001;
    CHECK(r.svc.pair("10.0.0.9", code).status == 200);  // the window passed
    // 15 more failures from other IPs reach 20 in total: the code rotates, pairing pauses for a minute
    for (int i = 0; i < 15; ++i) CHECK(r.svc.pair("10.0.1." + std::to_string(i), wrong).status == 403);
    CHECK(r.svc.code() != code);
    PairResult paused = r.svc.pair("10.0.2.1", r.svc.code());
    CHECK(paused.status == 429);
    CHECK(paused.error == "paused");
    CHECK(paused.retryAfterSec == 60);
    CHECK(r.svc.pausedMs() == 60000);
    r.t += 60000;
    CHECK(r.svc.pausedMs() == 0);
    CHECK(r.svc.pair("10.0.2.1", r.svc.code()).status == 200);
    CHECK(r.svc.pairedCount() == 2);  // pairings made before the rotation stay
  }

  TEST_CASE("brute force backoff: the pause doubles with each rotation up to an hour; New code or a pairing resets it") {
    Rig r;
    auto burn = [&](int base) {  // 20 wrong codes from 20 IPs: one rotation
      const std::string wrong = r.svc.code() == "000000" ? "000001" : "000000";
      for (int i = 0; i < 20; ++i) REQUIRE(r.svc.pair("10.9." + std::to_string(base) + "." + std::to_string(i), wrong)
                                           .status == 403);
    };
    const std::int64_t want[] = {60000, 120000, 240000, 480000, 960000, 1920000, 3600000, 3600000};
    for (int k = 0; k < 8; ++k) {
      burn(k);
      CHECK(r.svc.pausedMs() == want[k]);
      r.t += want[k];
    }
    // a guess every pause, forever: ≤ 20 per hour once grown (10^6 codes: ~0.05 % a day)
    burn(50);
    CHECK(r.svc.pausedMs() == 3600000);
    r.svc.newCode(true);  // Settings "New code": a person at the Mac ends the pause and resets the backoff
    CHECK(r.svc.pausedMs() == 0);
    burn(51);
    CHECK(r.svc.pausedMs() == 60000);
    r.t += 60000;
    burn(52);
    CHECK(r.svc.pausedMs() == 120000);
    r.t += 120000;
    r.pairOk("10.8.0.1");  // a phone paired: the backoff starts over
    burn(53);
    CHECK(r.svc.pausedMs() == 60000);
  }

  TEST_CASE("hasToken does not count as a use (LRU)") {
    Rig r;
    std::vector<std::string> toks;
    for (int i = 0; i < 8; ++i) {
      toks.push_back(r.pairOk());
      r.t += 10;
    }
    CHECK(r.svc.hasToken(toks[0]));  // not a use: toks[0] stays the least recent
    r.pairOk();
    CHECK_FALSE(r.svc.hasToken(toks[0]));
    CHECK(r.svc.hasToken(toks[1]));
  }

  TEST_CASE("view: huge counts are capped, not cast (UB)") {
    Rig r;
    CHECK(r.svc.setState(state(R"(,"scene":{"n":null,"count":1e300})")));
    CHECK(r.svc.viewJson().find(R"("snapshotCount":1000000000)") != std::string::npos);
  }

  TEST_CASE("tokens: at most 8, least recently used dropped; forgetAll ends every pairing") {
    Rig r;
    std::vector<std::string> toks;
    for (int i = 0; i < 8; ++i) {
      toks.push_back(r.pairOk());
      r.t += 10;
    }
    r.t += 10;
    CHECK(r.svc.tokenValid(toks[0]));  // used now: toks[1] is the least recent
    r.t += 10;
    const std::string ninth = r.pairOk();
    CHECK(r.svc.pairedCount() == 8);
    CHECK(r.svc.tokenValid(toks[0]));
    CHECK_FALSE(r.svc.tokenValid(toks[1]));
    CHECK(r.svc.tokenValid(ninth));
    r.svc.forgetAll();
    CHECK(r.svc.pairedCount() == 0);
    CHECK_FALSE(r.svc.tokenValid(ninth));
  }

  TEST_CASE("request limit: 60 at once per IP, then 30 per second; IP tables are capped") {
    Limits l;
    l.maxTrackedIps = 4;
    Rig r(l);
    int ok = 0;
    for (int i = 0; i < 100; ++i) ok += r.svc.allowRequest("10.0.0.1") ? 1 : 0;
    CHECK(ok == 60);
    r.t += 100;
    ok = 0;
    for (int i = 0; i < 10; ++i) ok += r.svc.allowRequest("10.0.0.1") ? 1 : 0;
    CHECK(ok == 3);
    CHECK(r.svc.allowRequest("10.0.0.2"));  // another IP has its own bucket
    for (int i = 3; i < 10; ++i) r.svc.allowRequest("10.0.0." + std::to_string(i));  // evicts the oldest
    CHECK(r.svc.allowRequest("10.0.0.1"));  // 10.0.0.1 was evicted: a fresh bucket (bounded memory over fairness)
  }

  TEST_CASE("view: not ready until a valid state; seq moves only when the page would change") {
    Rig r;
    CHECK(r.svc.viewJson() == R"({"seq":0,"ready":false})");
    CHECK_FALSE(r.svc.setState("{}"));
    CHECK_FALSE(r.svc.hasState());
    CHECK(r.svc.setState(state()));
    CHECK(r.svc.viewJson()
          == R"({"seq":1,"ready":true,"song":"Goodness of God","snapshot":null,"snapshotN":null,"snapshotCount":0,)"
             R"("droneOn":false,"locked":false,"audio":"running"})");
    CHECK(r.svc.setState(rep(state(), "\"latencyMs\":5", "\"latencyMs\":7")));  // not shown: same seq
    CHECK(r.svc.seq() == 1);
    CHECK(r.svc.setState(state(R"(,"scene":{"n":1,"count":3,"name":"Bridge"},"locked":true)")));
    CHECK(r.svc.viewJson()
          == R"({"seq":2,"ready":true,"song":"Goodness of God","snapshot":"Bridge","snapshotN":1,"snapshotCount":3,)"
             R"("droneOn":false,"locked":true,"audio":"running"})");
    CHECK(r.svc.setState(state(R"(,"scene":{"n":null,"count":3,"name":"x"})")));  // no scene playing: no name
    CHECK(r.svc.viewJson().find(R"("snapshot":null,"snapshotN":null,"snapshotCount":3)") != std::string::npos);
    CHECK_FALSE(r.svc.setState(state(R"(,"locked":1)")));  // invalid: ignored, the last good state stays
    CHECK(r.svc.seq() == 3);
    // names: quoted safely, cut to 80 code points
    CHECK(r.svc.setState(rep(state(), "Goodness of God", "<script>\\\"x\\u2028" + std::string(100, 'a'))));
    const std::string v = r.svc.viewJson();
    CHECK(v.find(R"("song":"<script>\"x)") != std::string::npos);
    // <script> " x U+2028 = 11 code points, + 69 = 80
    CHECK(v.find(std::string(69, 'a') + "\"") != std::string::npos);
    CHECK(v.find(std::string(70, 'a')) == std::string::npos);
    CHECK(r.svc.setState(R"({"v":1,"current":null,"modes":[],"master":0,"masterDb":null,"droneOn":true,)"
                         R"("droneKey":"","audio":"stalled","latencyMs":0,"midi":{"connected":false,"name":null},)"
                         R"("lowResource":false,"recording":false,"windowVisible":false,"memoryMB":null})"));
    CHECK(r.svc.viewJson().find(R"("song":null)") != std::string::npos);
  }

  TEST_CASE("commands: mapping to bus commands with via remote") {
    Rig r;
    const std::string tok = r.pairOk();
    REQUIRE(r.svc.setState(state()));
    auto bus = [&](const std::string &c, const std::string &id) {
      CommandResult res = r.svc.command(tok, cmd(c, id));
      REQUIRE(res.status == 200);
      REQUIRE(res.ok);
      return res.bus.value_or("none");
    };
    CHECK(bus("nextSong", "a1") == R"({"v":1,"type":"nextSong","via":"remote"})");
    CHECK(bus("prevSong", "a2") == R"({"v":1,"type":"prevSong","via":"remote"})");
    CHECK(bus("nextSnapshot", "a3") == R"({"v":1,"type":"nextScene","via":"remote"})");
    CHECK(bus("prevSnapshot", "a4") == R"({"v":1,"type":"prevScene","via":"remote"})");
    CHECK(bus("panic", "a5") == R"({"v":1,"type":"panic","via":"remote"})");
    // drone: absolute on/off (D45 droneToggle.on): the same press twice, or against a stale state, sets it twice
    CHECK(bus("droneOff", "d1") == R"({"v":1,"type":"droneToggle","on":false,"via":"remote"})");
    CHECK(bus("droneOn", "d2") == R"({"v":1,"type":"droneToggle","on":true,"via":"remote"})");
    CHECK(bus("droneOn", "d3") == R"({"v":1,"type":"droneToggle","on":true,"via":"remote"})");
    CommandResult rep = r.svc.command(tok, cmd("nextSong", "a1"));
    CHECK(rep.ok);
    CHECK(rep.repeated);
    CHECK_FALSE(rep.bus);
    CHECK(rep.replyJson == R"({"id":"a1","ok":true})");
  }

  TEST_CASE("commands: Lock and no state refuse everything but PANIC") {
    Rig r;
    const std::string tok = r.pairOk();
    CommandResult nr = r.svc.command(tok, cmd("nextSong", "n1"));
    CHECK(nr.status == 200);
    CHECK_FALSE(nr.ok);
    CHECK(nr.error == "not-ready");
    CHECK_FALSE(nr.bus);
    CHECK(r.svc.command(tok, cmd("panic", "n2")).bus.has_value());
    REQUIRE(r.svc.setState(state(R"(,"locked":true)")));
    for (const char *c : {"nextSong", "prevSong", "nextSnapshot", "prevSnapshot", "droneOn"}) {
      CommandResult l = r.svc.command(tok, cmd(c, std::string("l") + c));
      CHECK_FALSE(l.ok);
      CHECK(l.error == "locked");
      CHECK_FALSE(l.bus);
      CHECK(l.replyJson == std::string(R"({"id":"l)") + c + R"(","ok":false,"error":"locked"})");
    }
    CommandResult p = r.svc.command(tok, cmd("panic", "p1"));
    CHECK(p.ok);
    CHECK(p.bus.value() == R"({"v":1,"type":"panic","via":"remote"})");
    // a refused id stays refused when repeated after the unlock (it is the same press)
    REQUIRE(r.svc.setState(state(R"(,"locked":false)")));
    CommandResult again = r.svc.command(tok, cmd("nextSong", "lnextSong"));
    CHECK(again.repeated);
    CHECK_FALSE(again.ok);
    CHECK(r.svc.command(tok, cmd("nextSong", "fresh")).ok);
  }

  TEST_CASE("commands: not paired, bad bodies, bad ids, rate limit") {
    Limits l;
    l.cmdBurst = 3;
    l.cmdRatePerSec = 1;
    Rig r(l);
    REQUIRE(r.svc.setState(state()));
    CHECK(r.svc.command("", cmd("panic", "x")).status == 401);
    CHECK(r.svc.command(std::string(32, '0'), cmd("panic", "x")).status == 401);
    const std::string tok = r.pairOk();
    CHECK(r.svc.command(tok, "nope").status == 400);  // takes a token from the bucket too
    CommandResult badId = r.svc.command(tok, R"({"cmd":"panic","id":"<b>"})");
    CHECK(badId.status == 400);
    CHECK(badId.error == "bad-id");
    CHECK(badId.replyJson == R"({"ok":false,"error":"bad-id"})");  // the raw id is never echoed
    r.t += 3000;
    CHECK(r.svc.command(tok, R"({"cmd":"panic","id":")" + std::string(33, 'a') + "\"}").error == "bad-id");
    CHECK(r.svc.command(tok, R"({"cmd":"master","id":"m1"})").error == "bad-command");
    CHECK(r.svc.command(tok, R"({"cmd":"panic","id":"z","x":[[[[[1]]]]]})").error == "bad-id");  // too deep
    r.t += 3000;
    int ok = 0;
    for (int i = 0; i < 10; ++i) ok += r.svc.command(tok, cmd("panic", "r" + std::to_string(i))).status == 200;
    CHECK(ok == 3);
    CHECK(r.svc.command(tok, cmd("panic", "rx")).error == "rate-limited");
    r.t += 1000;
    CHECK(r.svc.command(tok, cmd("panic", "ry")).ok);
  }

  TEST_CASE("dedupe: 30 s and 64 ids per token") {
    Rig r;
    const std::string tok = r.pairOk();
    REQUIRE(r.svc.setState(state()));
    CHECK(r.svc.command(tok, cmd("nextSong", "same")).bus);
    r.t += 29999;
    CHECK(r.svc.command(tok, cmd("nextSong", "same")).repeated);
    r.t += 2;
    CHECK(r.svc.command(tok, cmd("nextSong", "same")).bus);  // 30 s later: a new press
    const std::string other = r.pairOk();
    CHECK(r.svc.command(other, cmd("nextSong", "same")).bus);  // ids are per phone
  }

  TEST_CASE("constantTimeEquals") {
    CHECK(constantTimeEquals("", ""));
    CHECK(constantTimeEquals("abc", "abc"));
    CHECK_FALSE(constantTimeEquals("abc", "abd"));
    CHECK_FALSE(constantTimeEquals("abc", "ab"));
  }
}
