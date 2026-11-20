// BRIDGE v1 conformance generated from native/contract/engine-api.json (T08; ARCHITECTURE M2): the C++ argument
// table (bridge/schema.h) must equal the contract's `messages.ops`, every op answers exactly once per id, every
// argument is type-checked (one generated request per argument and failure kind), and every error code of
// `messages.errors` / every event of `messages.events` has a scenario here, so a contract change fails this suite
// until the bridge follows.
#include <cstdio>
#include <filesystem>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <unistd.h>
#include <vector>

#include "bridge/schema.h"
#include "doctest.h"
#include "helpers.h"
#include "yyjson.h"

using namespace rigtest;
namespace bs = rig::bridge;

namespace {

struct Contract {
  yyjson_doc *doc = nullptr;
  yyjson_val *messages = nullptr;
  Contract() {
    doc = yyjson_read_file(RIG_REPO_DIR "/native/contract/engine-api.json", 0, nullptr, nullptr);
    REQUIRE(doc != nullptr);
    messages = yyjson_obj_get(yyjson_doc_get_root(doc), "messages");
    REQUIRE(messages != nullptr);
  }
  ~Contract() { yyjson_doc_free(doc); }
  yyjson_val *get(const char *k) const { return yyjson_obj_get(messages, k); }
};

/** The contract's type string -> the schema's ArgType (engine-api.json uses TS-like notation). */
bs::ArgType kindOf(std::string t) {
  if (!t.empty() && t.back() == '?') t.pop_back();
  if (t == "'interactive'|s") return bs::ArgType::NumberOrString;
  if (t == "number|null") return bs::ArgType::NumberOrNull;
  if (!t.empty() && t[0] == '\'') return bs::ArgType::Enum;
  // T00c: an integer set ("64|128|256|512") is an Int with allowed values, like rec `bits` ("16")
  if (t == "int" || (!t.empty() && t.find_first_not_of("0123456789|") == std::string::npos)) return bs::ArgType::Int;
  if (t == "s" || t == "engine s" || t == "number" || t == "0..1") return bs::ArgType::Number;
  if (t == "string" || t == "ParamPath") return bs::ArgType::String;
  if (t == "bool") return bs::ArgType::Bool;
  if (t == "any" || t == "touch") return bs::ArgType::Any;
  if ((!t.empty() && t[0] == '[') || (t.size() > 2 && t.compare(t.size() - 2, 2, "[]") == 0))
    return bs::ArgType::Array;
  return bs::ArgType::Object;  // {..}, Patch, Routing, SongDrone, object
}

std::string enumValues(std::string t) {  // "'a'|'b'?" -> "a|b"
  std::string out;
  for (char c : t)
    if (c != '\'' && c != '?') out += c;
  return out;
}

const bs::ArgSpec *argOf(const bs::OpSpec &op, const std::string &name) {
  for (std::size_t i = 0; i < op.nargs; ++i)
    if (name == op.args[i].name) return &op.args[i];
  return nullptr;
}

std::string sample(const bs::ArgSpec &a) {
  switch (a.type) {
    case bs::ArgType::Int: return a.values ? std::string(a.values).substr(0, std::string(a.values).find('|')) : "1";
    case bs::ArgType::Number: return "0.5";
    case bs::ArgType::NumberOrNull: return "null";
    case bs::ArgType::NumberOrString: return "\"interactive\"";
    case bs::ArgType::String: return "\"x\"";
    case bs::ArgType::Bool: return "true";
    case bs::ArgType::Object: return "{}";
    case bs::ArgType::Array: return "[]";
    case bs::ArgType::Enum: return "\"" + std::string(a.values).substr(0, std::string(a.values).find('|')) + "\"";
    case bs::ArgType::Any: return "1";
  }
  return "null";
}

/** Values of the wrong type for an argument (each must be rejected with bad-request). */
std::vector<std::string> wrong(const bs::ArgSpec &a) {
  switch (a.type) {
    case bs::ArgType::Int: return a.values ? std::vector<std::string>{"\"x\"", "0.5", "17"} : std::vector<std::string>{
                                                                                                  "\"x\"", "0.5"};
    case bs::ArgType::Number: return {"\"x\"", "true", "{}"};
    case bs::ArgType::NumberOrNull: return {"\"x\"", "[]"};
    case bs::ArgType::NumberOrString: return {"true", "{}"};
    case bs::ArgType::String: return {"1", "[]"};
    case bs::ArgType::Bool: return {"1", "\"true\""};
    case bs::ArgType::Object: return {"1", "[]", "\"x\""};
    case bs::ArgType::Array: return {"1", "{}"};
    case bs::ArgType::Enum: return {"\"zzz\"", "1"};
    case bs::ArgType::Any: return {};
  }
  return {};
}

/** A message for `op` with every required argument (and per-variant requirement) set to a valid sample; a few ops
 *  get values that make the baseline meaningful (set needs path+value, rec start needs a folder). */
std::map<std::string, std::string> baseline(const bs::OpSpec &op) {
  std::map<std::string, std::string> m;
  for (std::size_t i = 0; i < op.nargs; ++i)
    if (op.args[i].required) m[op.args[i].name] = sample(op.args[i]);
  const std::string name = op.op;
  if (name == "set") m = {{"path", "\"slots.0.gain\""}, {"value", "0.5"}};
  if (name == "rec") m["action"] = "\"stop\"";
  if (name == "hello") m["protocol"] = "1";
  std::size_t nv = 0;
  const bs::VariantSpec *vs = bs::variants(&nv);
  for (std::size_t i = 0; i < nv; ++i) {
    if (name != vs[i].op || m[vs[i].key] != "\"" + std::string(vs[i].value) + "\"") continue;
    std::string need = vs[i].need;
    for (std::size_t p = 0; p <= need.size();) {
      const std::size_t bar = std::min(need.find('|', p), need.size());
      const std::string f = need.substr(p, bar - p);
      if (const bs::ArgSpec *a = argOf(op, f)) m[f] = f == "n" ? "60" : f == "vel" ? "100" : sample(*a);
      p = bar + 1;
    }
  }
  return m;
}

std::string build(const std::string &op, const std::map<std::string, std::string> &args, int id) {
  std::string s = R"({"v":1,"op":")" + op + R"(","id":)" + std::to_string(id);
  for (const auto &[k, v] : args) s += ",\"" + k + "\":" + v;
  return s + "}";
}

std::string afterHello(const std::string &msg) {
  OfflineEngine e;
  e.hello();
  return e.call(msg);
}

int count(const std::string &s, const std::string &needle) {
  int n = 0;
  for (std::size_t p = s.find(needle); p != std::string::npos; p = s.find(needle, p + 1)) ++n;
  return n;
}

}  // namespace

TEST_SUITE("bridge-conformance") {
  TEST_CASE("the schema table equals engine-api.json messages.ops (names, optionality, types, enum values)") {
    Contract c;
    yyjson_val *ops = c.get("ops");
    REQUIRE(yyjson_is_arr(ops));
    std::size_t nOps = 0;
    bs::ops(&nOps);
    CHECK(yyjson_arr_size(ops) == nOps);
    std::size_t i, n;
    yyjson_val *o;
    yyjson_arr_foreach(ops, i, n, o) {
      const std::string name = yyjson_get_str(yyjson_obj_get(o, "op"));
      INFO("op " << name);
      const bs::OpSpec *spec = bs::findOp(name.c_str());
      REQUIRE(spec != nullptr);
      yyjson_val *args = yyjson_obj_get(o, "args");
      CHECK(yyjson_obj_size(args) == spec->nargs);
      std::size_t j, m;
      yyjson_val *k, *v;
      yyjson_obj_foreach(args, j, m, k, v) {
        const std::string an = yyjson_get_str(k), at = yyjson_get_str(v);
        INFO("arg " << an << " : " << at);
        const bs::ArgSpec *a = argOf(*spec, an);
        REQUIRE(a != nullptr);
        CHECK(a->required == (at.back() != '?'));
        CHECK(static_cast<int>(a->type) == static_cast<int>(kindOf(at)));
        if (a->type == bs::ArgType::Enum) CHECK(std::string(a->values) == enumValues(at));
      }
    }
  }

  TEST_CASE("generated: every op answers exactly once per id; protocol rules come before the schema") {
    std::size_t nOps = 0;
    const bs::OpSpec *ops = bs::ops(&nOps);
    OfflineEngine eng;
    int id = 100;
    for (std::size_t k = 0; k < nOps; ++k) {  // before hello: everything but hello is a protocol error
      if (std::string(ops[k].op) == "hello") continue;
      const std::string r = eng.call(build(ops[k].op, baseline(ops[k]), ++id));
      INFO(ops[k].op << " -> " << r);
      CHECK(count(r, "\"re\":" + std::to_string(id) + ",") == 1);
      CHECK(contains(r, "\"code\":\"protocol\""));
    }
    eng.hello();
    for (std::size_t k = 0; k < nOps; ++k) {
      const std::string msg = build(ops[k].op, baseline(ops[k]), ++id);
      const std::string r = eng.call(msg);
      INFO(msg << " -> " << r);
      CHECK(count(r, "\"re\":" + std::to_string(id) + ",") == 1);
      CHECK(!contains(r, "bad-request"));
      CHECK(!contains(r, "unknown-op"));
      CHECK(!contains(r, "\"internal\""));
      // another major `v` is refused for every op
      std::string v2 = build(ops[k].op, baseline(ops[k]), ++id);
      v2.replace(v2.find("\"v\":1"), 5, "\"v\":2");
      CHECK(contains(eng.call(v2), "\"code\":\"protocol\""));
    }
  }

  TEST_CASE("generated: a missing required argument, a wrong type or an unknown enum value is bad-request") {
    std::size_t nOps = 0;
    const bs::OpSpec *ops = bs::ops(&nOps);
    OfflineEngine eng;
    eng.hello();
    int id = 1000, cases = 0;
    for (std::size_t k = 0; k < nOps; ++k) {
      const bs::OpSpec &op = ops[k];
      const auto base = baseline(op);
      for (std::size_t a = 0; a < op.nargs; ++a) {
        const bs::ArgSpec &arg = op.args[a];
        if (arg.required && !arg.lenient) {
          auto m = base;
          m.erase(arg.name);
          const std::string r = eng.call(build(op.op, m, ++id));
          INFO(op.op << " without " << arg.name << " -> " << r);
          CHECK(contains(r, "\"code\":\"bad-request\""));
          ++cases;
        }
        for (const std::string &w : wrong(arg)) {
          if (std::string(op.op) == "hello" && std::string(arg.name) == "protocol") continue;  // checked below
          auto m = base;
          m[arg.name] = w;
          const std::string msg = build(op.op, m, ++id);
          const std::string r = eng.call(msg);
          INFO(msg << " -> " << r);
          CHECK(contains(r, "\"code\":\"bad-request\""));
          CHECK(contains(r, ("\"re\":" + std::to_string(id) + ",").c_str()));
          CHECK(contains(r, arg.name));  // the message names the field
          ++cases;
        }
      }
      // per-variant requirements (contract 6.4 prose)
      std::size_t nv = 0;
      const bs::VariantSpec *vs = bs::variants(&nv);
      for (std::size_t v = 0; v < nv; ++v) {
        if (std::string(vs[v].op) != op.op) continue;
        const std::string first = std::string(vs[v].need).substr(0, std::string(vs[v].need).find('|'));
        auto m = base;
        m[vs[v].key] = "\"" + std::string(vs[v].value) + "\"";
        m.erase(first);
        const std::string r = eng.call(build(op.op, m, ++id));
        INFO(op.op << " " << vs[v].value << " without " << first << " -> " << r);
        CHECK(contains(r, "\"code\":\"bad-request\""));
        ++cases;
      }
    }
    MESSAGE("generated bad-request cases: " << cases);
    CHECK(cases > 100);
    // unknown fields are ignored (contract 6.2), null `when` means now
    CHECK(contains(eng.call(R"({"v":1,"op":"get","what":"stats","id":7,"zzz":{"a":1},"when":null})"), "\"ok\":true"));
  }

  TEST_CASE("every error code of messages.errors has a scenario that produces it") {
    Contract c;
    const std::string dir = (std::filesystem::temp_directory_path() / ("rig_t08_conf_" + std::to_string(::getpid())))
                                .string();
    std::filesystem::create_directories(dir);
    // a My Samples manifest whose sample file does not exist -> the cache service's `decode` warning (T06)
    const std::string man = dir + "/manifest.json";
    if (std::FILE *f = std::fopen(man.c_str(), "wb")) {
      const std::string j = R"({"instruments":[{"id":"ghost","layers":[{"files":{"C4":")" + dir + R"(/none.wav"}}]}]})";
      std::fwrite(j.data(), 1, j.size(), f);
      std::fclose(f);
    }
    using Scenario = std::function<std::string()>;
    const std::map<std::string, Scenario> scenarios = {
        {"protocol", [] { OfflineEngine e; return e.call(R"({"v":2,"op":"hello","protocol":2,"id":1})"); }},
        {"bad-request", [] { OfflineEngine e; e.hello(); return e.call(R"({"v":1,"op":"click","id":1})"); }},
        {"unknown-op", [] { OfflineEngine e; e.hello(); return e.call(R"({"v":1,"op":"nope","id":1})"); }},
        {"unknown-param",
         [] { return afterHello(R"({"v":1,"op":"set","path":"slots.0.zz","value":1,"id":1})"); }},
        {"not-started",  // a recording needs the audio graph (audio start or a first commit)
         [&] { OfflineEngine e; e.hello(); return e.call(R"({"v":1,"op":"rec","action":"start","dir":")" + dir +
                                                        R"(","id":1})"); }},
        {"stale-token", [] { return afterHello(R"({"v":1,"op":"commit","token":42,"id":1})"); }},
        {"superseded",
         [] {
           OfflineEngine e;
           e.hello();
           e.call(R"({"v":1,"op":"prepare","patch":{},"id":1})");
           e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
           e.call(R"({"v":1,"op":"audio","action":"restart","id":3})");  // the in-flight prepare dies
           return e.call(R"({"v":1,"op":"commit","token":1,"id":4})");
         }},
        {"decode",
         [&] {
           rig_config cfg;
           rig_config_init(&cfg);
           cfg.mode = RIG_MODE_OFFLINE;
           cfg.app_dir = RIG_REPO_DIR "/app";
           cfg.user_manifest = man.c_str();
           std::string all;
           cfg.on_event = [](void *u, const char *j, size_t n) { static_cast<std::string *>(u)->append(j, n); };
           cfg.event_user = &all;
           rig_engine *e = rig_create(&cfg, nullptr);
           auto post = [&](const std::string &m) { rig_post(e, m.data(), m.size()); };
           post(R"({"v":1,"op":"hello","protocol":1,"app":"t","id":1})");
           post(R"({"v":1,"op":"cache","action":"preload","pin":"none","id":2,"patches":[{"slots":[)"
                R"({"instrument":{"type":"sampler","id":"user:ghost"}},null,null,null]}]})");
           rig_destroy(e);
           return all;
         }},
        {"device",  // the host reports a failed / vanished device
         [] {
           OfflineEngine e;
           e.hello();
           e.msgs.clear();
           rig_host_audio_state(e.e, RIG_DEVICE_CLOSED, "unplugged");
           std::string all;
           for (const auto &m : e.msgs) all += m;
           return all;
         }},
        {"unsupported", [] { return afterHello(R"({"v":1,"op":"play","e":"bend","x":1,"id":1})"); }},
        {"busy",  // a second take while recording
         [&] {
           OfflineEngine e;
           e.hello();
           e.call(R"({"v":1,"op":"audio","action":"start","id":1})");
           const std::string rec = R"({"v":1,"op":"rec","action":"start","dir":")" + dir + R"(","id":2})";
           e.call(rec);
           const std::string r = e.call(rec);
           e.call(R"({"v":1,"op":"rec","action":"stop","id":3})");
           return r;
         }},
        {"internal", [] { OfflineEngine e; e.hello(); return e.call(R"({"v":1,"op":"__throw","id":1})"); }},
    };
    yyjson_val *errs = c.get("errors");
    REQUIRE(yyjson_is_arr(errs));
    std::size_t i, n;
    yyjson_val *it;
    yyjson_arr_foreach(errs, i, n, it) {
      const std::string code = yyjson_get_str(it);
      INFO("error code " << code);
      auto s = scenarios.find(code);
      REQUIRE_MESSAGE(s != scenarios.end(), "engine-api.json lists an error code with no conformance scenario");
      const std::string r = s->second();
      INFO(r);
      CHECK(contains(r, ("\"code\":\"" + code + "\"").c_str()));
    }
    CHECK(scenarios.size() == yyjson_arr_size(errs));
    std::filesystem::remove_all(dir);
  }

  TEST_CASE("every event of messages.events is known; the engine-side ones are produced here") {
    Contract c;
    // event -> where it comes from. Engine-side events are produced below (tick: realtime only, unit.runtime).
    const std::map<std::string, std::string> owners = {
        {"state", "engine"}, {"tick", "engine (realtime; unit.runtime)"}, {"warn", "engine"}, {"rec", "engine"},
        {"load", "cache service (T06)"}, {"notes", "Model perform (T14)"}, {"wheel", "Model perform (T14)"},
        {"click", "click service (T07)"}, {"midi", "midi service (T07)"}};
    yyjson_val *evs = c.get("events");
    std::size_t i, n;
    yyjson_val *it;
    yyjson_arr_foreach(evs, i, n, it) {
      const std::string ev = yyjson_get_str(yyjson_obj_get(it, "ev"));
      INFO("event " << ev);
      CHECK(owners.count(ev) == 1);
    }
    CHECK(owners.size() == yyjson_arr_size(evs));
    const std::string dir = (std::filesystem::temp_directory_path() / ("rig_t08_ev_" + std::to_string(::getpid())))
                                .string();
    std::filesystem::create_directories(dir);
    OfflineEngine e;
    e.hello();
    std::string all = e.call(R"({"v":1,"op":"audio","action":"start","id":1})");
    all += e.call(R"({"v":1,"op":"nope"})");
    all += e.call(R"({"v":1,"op":"rec","action":"start","dir":")" + dir + R"(","id":2})");
    e.render(4800);
    all += e.call(R"({"v":1,"op":"rec","action":"stop","id":3})");
    for (const char *ev : {"state", "warn", "rec"})
      CHECK(contains(all, (std::string("\"ev\":\"") + ev + "\"").c_str()));
    std::filesystem::remove_all(dir);
  }
}
