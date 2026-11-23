// CORE3 measurement, realtime engine (as rig-devhost runs it): per song switch, how long the control thread is held
// (a `play` posted right after the `prepare` is answered only when the prepare returns), the tick gap, the prepare
// reply latency, and the unit builds by kind (factory wrappers, control thread). Then the RSS cost per instrument.
#include <malloc.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "api/registry.h"
#include "graph/unit.h"
#include "model/patch.h"
#include "rig/rig_engine.h"
#include "yyjson.h"

using Clock = std::chrono::steady_clock;
static double msOf(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}

struct Acc {
  double ms = 0;
  long n = 0;
};
static std::mutex g_mu;
static std::map<std::string, Acc> g_acc;
static std::map<std::string, rig::UnitFactory> g_orig;
static const char *kKinds[] = {"inst.synth", "inst.organ", "inst.sampler", "strip"};
template <int K>
rig::Unit *wrap(const rig::UnitEnv &env, const rig::UnitSpec &spec) {
  std::string kind = kKinds[K];
  if (K <= 1 && spec.patch && spec.channel >= 0) kind = spec.patch->slots[spec.channel].instId;
  if (K == 2) kind = "sampler";
  const auto t = Clock::now();
  rig::Unit *u = g_orig[kKinds[K]](env, spec);
  const double ms = msOf(t, Clock::now());
  std::lock_guard<std::mutex> lk(g_mu);
  Acc &a = g_acc[kind];
  a.ms += ms;
  a.n++;
  return u;
}

struct Ev {
  Clock::time_point at;
  std::string text;
};
static std::mutex g_evMu;
static std::vector<Ev> g_evs;

static long rssKB() {
  long pages = 0, res = 0;
  std::ifstream f("/proc/self/statm");
  f >> pages >> res;
  return res * (sysconf(_SC_PAGESIZE) / 1024);
}

static std::pair<Clock::time_point, std::string> reply(int id, int ms = 60000) {
  const std::string needle = "\"re\":" + std::to_string(id) + ",";
  const auto end = Clock::now() + std::chrono::milliseconds(ms);
  for (;;) {
    {
      std::lock_guard<std::mutex> lk(g_evMu);
      for (const Ev &v : g_evs)
        if (v.text.find(needle) != std::string::npos) return {v.at, v.text};
    }
    if (Clock::now() >= end) return {Clock::time_point{}, std::string()};
    std::this_thread::sleep_for(std::chrono::microseconds(200));
  }
}
static double maxGap(Clock::time_point from, Clock::time_point to) {
  std::lock_guard<std::mutex> lk(g_evMu);
  double worst = 0;
  Clock::time_point prev = from;
  for (const Ev &v : g_evs)
    if (v.at >= from && v.at <= to && v.text.find("\"ev\":\"tick\"") != std::string::npos) {
      worst = std::max(worst, msOf(prev, v.at));
      prev = v.at;
    }
  return std::max(worst, msOf(prev, to));
}

int main(int argc, char **argv) {
  const char *repo = argc > 1 ? argv[1] : "/home/claude/worship-rig";
  const char *songsFile = argc > 2 ? argv[2] : "songs.json";
  auto &reg = rig::Registry::global();
  rig_config cfg;
  rig_config_init(&cfg);
  cfg.mode = RIG_MODE_REALTIME;
  cfg.sample_rate = 48000;
  std::string app = std::string(repo) + "/app";
  cfg.app_dir = app.c_str();
  cfg.on_event = [](void *, const char *j, size_t n) {
    const auto now = Clock::now();
    std::lock_guard<std::mutex> lk(g_evMu);
    g_evs.push_back({now, std::string(j, n)});
  };
  {
    rig_config c2 = cfg;
    c2.mode = RIG_MODE_OFFLINE;
    rig_engine *d = rig_create(&c2, nullptr);
    rig_destroy(d);
  }
  for (const char *k : kKinds) g_orig[k] = reg.unit(k)->factory;
  reg.addUnit("inst.synth", &wrap<0>, reg.unit("inst.synth")->info, 1000);
  reg.addUnit("inst.organ", &wrap<1>, reg.unit("inst.organ")->info, 1000);
  reg.addUnit("inst.sampler", &wrap<2>, reg.unit("inst.sampler")->info, 1000);
  reg.addUnit("strip", &wrap<3>, reg.unit("strip")->info, 1000);

  std::ifstream f(songsFile);
  std::stringstream ss;
  ss << f.rdbuf();
  const std::string text = ss.str();
  yyjson_doc *doc = yyjson_read(text.data(), text.size(), 0);
  std::map<std::string, std::string> byId;
  std::vector<std::string> order;
  size_t idx, max;
  yyjson_val *s;
  yyjson_arr_foreach(yyjson_doc_get_root(doc), idx, max, s) {
    size_t len = 0;
    char *pj = yyjson_val_write(yyjson_obj_get(s, "patch"), 0, &len);
    const std::string id = yyjson_get_str(yyjson_obj_get(s, "id"));
    byId[id] = std::string(pj, len);
    if (id.rfind("factory:", 0) == 0) order.push_back(id);
    free(pj);
  }

  rig_engine *e = rig_create(&cfg, nullptr);
  auto post = [&](const std::string &m) { rig_post(e, m.data(), m.size()); };
  std::atomic<bool> stop{false};
  post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
  reply(1);
  post(R"({"v":1,"op":"audio","action":"start","id":2})");
  reply(2);
  std::thread audio([&] {
    std::vector<float> l(128), r(128);
    float *p[2] = {l.data(), r.data()};
    auto next = Clock::now();
    while (!stop) {
      rig_render(e, p, 2, 128, 0);
      next += std::chrono::nanoseconds(static_cast<long long>(128 * 1e9 / 48000.0));
      std::this_thread::sleep_until(next);
      if (Clock::now() > next + std::chrono::milliseconds(50)) next = Clock::now();
    }
  });
  post(R"({"v":1,"op":"config","meters":{"rate":30},"id":3})");
  reply(3);
  std::this_thread::sleep_for(std::chrono::milliseconds(300));

  int id = 10;
  auto doSwitch = [&](const std::string &sid) {
    {
      std::lock_guard<std::mutex> lk(g_mu);
      g_acc.clear();
    }
    const int pid = id++, nid = id++;
    const auto t0 = Clock::now();
    post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pid) + ",\"patch\":" + byId[sid] + "}");
    post("{\"v\":1,\"op\":\"play\",\"e\":\"on\",\"n\":60,\"vel\":80,\"id\":" + std::to_string(nid) + "}");
    const auto pl = reply(nid);
    const auto pr = reply(pid);
    post("{\"v\":1,\"op\":\"play\",\"e\":\"off\",\"n\":60}");
    const size_t at = pr.second.find("\"token\":");
    const long tok = at == std::string::npos ? -1 : std::strtol(pr.second.c_str() + at + 8, nullptr, 10);
    const int cid = id++;
    const auto tc = Clock::now();
    post("{\"v\":1,\"op\":\"commit\",\"id\":" + std::to_string(cid) + ",\"token\":" + std::to_string(tok) + "}");
    const auto cr = reply(cid);
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    const double gap = maxGap(t0, Clock::now());
    std::string units;
    double instMs = 0;
    {
      std::lock_guard<std::mutex> lk(g_mu);
      for (auto &[k, a] : g_acc) {
        char buf[96];
        std::snprintf(buf, sizeof buf, "%s%s %.1f", units.empty() ? "" : ", ", k.c_str(), a.ms);
        if (a.n > 1) std::snprintf(buf + std::strlen(buf), sizeof buf - std::strlen(buf), " (x%ld)", a.n);
        units += buf;
        if (k != "strip" && k != "sampler") instMs += a.ms;
      }
    }
    std::printf("| %-26s | %7.1f | %8.1f | %6.1f | %6.1f | %6.1f | %s |\n", sid.c_str(), msOf(t0, pl.first),
                msOf(t0, pr.first), msOf(tc, cr.first), gap, instMs, units.c_str());
    std::fflush(stdout);
  };
  const char *hdr = "| song | play held (ms) | prepare reply (ms) | commit (ms) | max tick gap (ms) | synth/organ builds "
                    "(ms) | unit builds on the control thread (ms) |\n|---|---|---|---|---|---|---|\n";
  for (int pass = 1; pass <= 2; ++pass) {
    std::printf("\n### pass %d (%s)\n%s", pass, pass == 1 ? "cold process" : "warm", hdr);
    for (const auto &sid : order) doSwitch(sid);
    doSwitch("test:heavy16");
    doSwitch("factory:grand-piano");
    doSwitch("test:heavy16b");
  }
  stop = true;
  audio.join();
  rig_destroy(e);

  // RSS per instrument (warm banks; offline engine, factories called directly)
  {
    rig_config c2 = cfg;
    c2.mode = RIG_MODE_OFFLINE;
    c2.on_event = nullptr;
    rig_engine *d = rig_create(&c2, nullptr);
    (void)d;
    std::printf("\n### RSS per instance (warm banks, 6 instances each)\n| instrument | RSS KB each |\n|---|---|\n");
    rig::UnitEnv env;
    env.sampleRate = 48000;
    env.seed = 1;
    for (auto [type, iid] : std::vector<std::pair<const char *, const char *>>{{"organ", "gospel"},
                                                                               {"synth", "warm-pad"},
                                                                               {"synth", "glass-pad"},
                                                                               {"synth", "supersaw-pad"},
                                                                               {"synth", "juno-pad"},
                                                                               {"synth", "dx-epiano"},
                                                                               {"synth", "shimmer-pad"},
                                                                               {"synth", "sub-bass"}}) {
      rig::PatchSpec ps;
      ps.slots[0].present = true;
      ps.slots[0].instType = type;
      ps.slots[0].instId = iid;
      ps.slots[0].paramsJson = "{}";
      rig::UnitSpec sp;
      sp.channel = 0;
      sp.patch = &ps;
      const char *kind = std::strcmp(type, "organ") == 0 ? "inst.organ" : "inst.synth";
      delete g_orig[kind](env, sp);  // banks warm
      malloc_trim(0);
      const long r0 = rssKB();
      std::vector<rig::Unit *> us;
      for (int k = 0; k < 6; ++k) us.push_back(g_orig[kind](env, sp));
      const long r1 = rssKB();
      std::printf("| %s %s | %.0f |\n", type, iid, (r1 - r0) / 6.0);
      for (auto *u : us) delete u;
      malloc_trim(0);
    }
    rig_destroy(d);
  }
  yyjson_doc_free(doc);
  return 0;
}
