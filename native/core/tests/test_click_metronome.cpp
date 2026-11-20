// T07: the click service against the real metronome.js (tools/golden/vectors/data/click-metronome.txt, dumped by
// tools/golden/vectors/dump-click.mjs). Each case replays its script through the bridge of an offline engine
// (`song` tempo/timeSig, `click` config/start/stop; live calls posted at the first quantum boundary >= t, as page.js
// `setup.live`) and compares, in order and bit for bit: scheduled click times and kinds, stop thresholds, MIDI clock
// messages (24 ppq pulses, Start, Stop), the `click` state events and the start/config return values.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <string>
#include <vector>

#include "api/engine.h"
#include "click/click_service.h"
#include "doctest.h"
#include "helpers.h"
#include "num_vectors.h"
#include "yyjson.h"

using namespace rigtest;

namespace {

struct Call {
  double when;
  std::string op, args;
};
struct Case {
  std::string name;
  double sr = 0;
  std::size_t frames = 0;
  std::vector<Call> calls;
  std::vector<std::string> ticks, clears, clocks, states, rets;
};

std::vector<Case> loadCases() {
  std::vector<Case> out;
  for (const std::string &l : rigvec::lines("click-metronome.txt")) {
    const auto sp = l.find(' ');
    const std::string tag = l.substr(0, sp), rest = sp == std::string::npos ? "" : l.substr(sp + 1);
    if (tag == "case") {
      const auto t = rigvec::split(rest);
      Case c;
      c.name = t[0];
      c.sr = std::stod(t[1]);
      c.frames = std::stoul(t[2]);
      out.push_back(std::move(c));
    } else if (out.empty() || tag == "end") {
      continue;
    } else if (tag == "call") {
      const auto a = rest.find(' '), b = rest.find(' ', a + 1);
      out.back().calls.push_back({std::stod(rest.substr(0, a)), rest.substr(a + 1, b - a - 1), rest.substr(b + 1)});
    } else if (tag == "tick") {
      out.back().ticks.push_back(rest);
    } else if (tag == "clear") {
      out.back().clears.push_back(rest);
    } else if (tag == "clock") {
      out.back().clocks.push_back(rest);
    } else if (tag == "state") {
      out.back().states.push_back(rest);
    } else if (tag == "ret") {
      out.back().rets.push_back(rest);
    }
  }
  return out;
}

std::string hex(double t) {
  char b[20];
  std::snprintf(b, sizeof b, "%016llx", static_cast<unsigned long long>(rigvec::bits(t)));
  return b;
}

/** A JSON field of the script args as bridge text ("" = absent). */
std::string field(yyjson_val *o, const char *k) {
  yyjson_val *v = yyjson_obj_get(o, k);
  if (!v) return "";
  char *s = yyjson_val_write(v, 0, nullptr);
  std::string r = std::string(",\"") + k + "\":" + s;
  free(s);
  return r;
}

/** Every JSON message delivered (batches are arrays). */
void eachMessage(const std::vector<std::string> &msgs, const std::function<void(yyjson_val *)> &fn) {
  for (const std::string &m : msgs) {
    yyjson_doc *d = yyjson_read(m.data(), m.size(), 0);
    if (!d) continue;
    yyjson_val *root = yyjson_doc_get_root(d);
    if (yyjson_is_arr(root)) {
      std::size_t i, n;
      yyjson_val *v;
      yyjson_arr_foreach(root, i, n, v) fn(v);
    } else {
      fn(root);
    }
    yyjson_doc_free(d);
  }
}

std::string writeJson(yyjson_val *v) {
  char *s = yyjson_val_write(v, 0, nullptr);
  std::string r = s ? s : "";
  free(s);
  return r;
}

}  // namespace

TEST_SUITE("click") {
  TEST_CASE("metronome.js vectors: ticks, stop thresholds, MIDI clock, state events, return values") {
    const std::vector<Case> cases = loadCases();
    REQUIRE(cases.size() >= 14);
    std::size_t nTicks = 0, nClocks = 0, nStates = 0;
    for (const Case &c : cases) {
      CAPTURE(c.name);
      OfflineEngine e(c.sr);
      e.hello();
      e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
      rig::Engine &eng = *reinterpret_cast<rig::Engine *>(e.e);
      auto *svc = dynamic_cast<rig::ClickServiceImpl *>(eng.model().service(rig::ClickService::kName));
      REQUIRE(svc != nullptr);
      std::vector<std::string> ticks, clears, clocks, rets;
      svc->setTickObserver(
          [&](double t, rig::click::TickKind k) { ticks.push_back(hex(t) + " " + std::to_string(int(k))); });
      svc->setClearObserver([&](double t) { clears.push_back(hex(t)); });
      auto clockFn = [&](const rig::click::ClockMsg *m, std::size_t n) {
        for (std::size_t i = 0; i < n; ++i) clocks.push_back(hex(m[i].t) + " " + std::to_string(m[i].status));
      };
      std::vector<std::string> all;  // every delivered message string
      int id = 10;
      auto issue = [&](const Call &k) {
        yyjson_doc *d = yyjson_read(k.args.data(), k.args.size(), 0);
        yyjson_val *a = yyjson_doc_get_root(d);
        std::string msg;
        const std::string ids = std::to_string(++id);
        if (k.op == "tempo") {
          msg = R"({"v":1,"op":"song","id":)" + ids + field(a, "bpm").replace(2, 3, "tempo") + "}";
        } else if (k.op == "sig") {
          msg = R"({"v":1,"op":"song","id":)" + ids + field(a, "sig").replace(2, 3, "timeSig") + field(a, "newBar") +
                "}";  // newBar: song switch (T07 review O2, songswitch-newbar-* cases)
        } else if (k.op == "config") {
          msg = R"({"v":1,"op":"click","action":"config","id":)" + ids + field(a, "level") + field(a, "record") +
                field(a, "output") + field(a, "when") + "}";
        } else if (k.op == "start") {
          msg = R"({"v":1,"op":"click","action":"start","id":)" + ids + field(a, "countIn") + field(a, "quietAfter") +
                field(a, "when") + "}";
        } else if (k.op == "stop") {
          msg = R"({"v":1,"op":"click","action":"stop","id":)" + ids + field(a, "when") + "}";
        } else if (k.op == "clock") {
          if (yyjson_is_true(yyjson_obj_get(a, "on")))
            svc->setClockObserver(clockFn);
          else
            svc->setClockObserver(nullptr);
        }
        yyjson_doc_free(d);
        if (msg.empty()) return;
        e.msgs.clear();
        e.post(msg);
        eachMessage(e.msgs, [&](yyjson_val *v) {
          if (yyjson_get_num(yyjson_obj_get(v, "re")) != id) return;
          if (k.op == "start" || k.op == "config") rets.push_back(k.op + " " + writeJson(yyjson_obj_get(v, "result")));
        });
        all.insert(all.end(), e.msgs.begin(), e.msgs.end());
      };
      e.msgs.clear();
      std::vector<Call> live;
      for (const Call &k : c.calls) {
        if (k.when < 0)
          issue(k);
        else
          live.push_back(k);
      }
      // live calls at the first 128-frame boundary >= t (stable: script order within a quantum)
      std::stable_sort(live.begin(), live.end(), [&](const Call &a, const Call &b) {
        return std::ceil(a.when * c.sr / 128 - 1e-6) < std::ceil(b.when * c.sr / 128 - 1e-6);
      });
      std::size_t done = 0;
      for (const Call &k : live) {
        const auto q = static_cast<std::size_t>(std::ceil(k.when * c.sr / 128 - 1e-6));
        if (q * 128 > done) {
          e.msgs.clear();
          e.render(q * 128 - done, 128);
          all.insert(all.end(), e.msgs.begin(), e.msgs.end());
          done = q * 128;
        }
        issue(k);
      }
      e.msgs.clear();
      if (c.frames > done) e.render(c.frames - done, 128);
      all.insert(all.end(), e.msgs.begin(), e.msgs.end());
      std::vector<std::string> states;
      eachMessage(all, [&](yyjson_val *v) {
        const char *ev = yyjson_get_str(yyjson_obj_get(v, "ev"));
        if (!ev || std::string(ev) != "click") return;
        yyjson_mut_doc *md = yyjson_mut_doc_new(nullptr);
        yyjson_mut_val *mv = yyjson_val_mut_copy(md, v);
        yyjson_mut_obj_remove_key(mv, "v");
        yyjson_mut_obj_remove_key(mv, "ev");
        char *s = yyjson_mut_val_write(mv, 0, nullptr);
        states.emplace_back(s);
        free(s);
        yyjson_mut_doc_free(md);
      });
      CHECK(ticks == c.ticks);
      CHECK(clears == c.clears);
      CHECK(clocks == c.clocks);
      CHECK(states == c.states);
      CHECK(rets == c.rets);
      nTicks += ticks.size();
      nClocks += clocks.size();
      nStates += states.size();
    }
    CHECK(nTicks >= 100);
    CHECK(nClocks >= 1000);
    MESSAGE("click vectors: " << cases.size() << " cases, " << nTicks << " ticks, " << nClocks << " clock msgs, "
                              << nStates << " state events");
  }
}
