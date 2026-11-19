#include "fixture_runner.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>

#include "io/wav.h"
#include "rig/rig_engine.h"
#include "yyjson.h"

namespace rig::tools {
namespace {

bool slurp(const std::string &path, std::string &out) {
  std::FILE *f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  char buf[65536];
  std::size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  std::fclose(f);
  return true;
}

std::string toJson(yyjson_val *v) {
  size_t len = 0;
  char *s = yyjson_val_write(v, 0, &len);
  std::string out = s ? std::string(s, len) : "null";
  std::free(s);
  return out;
}

double num(yyjson_val *o, const char *k, double d) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return v && yyjson_is_num(v) ? yyjson_get_num(v) : d;
}

struct Sink {
  std::vector<std::string> msgs;
};

void onEvent(void *user, const char *json, size_t len) {
  static_cast<Sink *>(user)->msgs.emplace_back(json, len);
}

}  // namespace

bool loadFixtures(const std::string &path, std::vector<Fixture> &out, std::string *err) {
  std::string text;
  if (!slurp(path, text)) {
    if (err) *err = "cannot read " + path;
    return false;
  }
  yyjson_doc *doc = yyjson_read(text.data(), text.size(), 0);
  if (!doc) {
    if (err) *err = "invalid JSON in " + path;
    return false;
  }
  yyjson_val *root = yyjson_doc_get_root(doc);
  yyjson_val *arr = yyjson_obj_get(root, "fixtures");
  size_t i, n;
  yyjson_val *it;
  yyjson_arr_foreach(arr, i, n, it) {
    yyjson_val *fx = yyjson_obj_get(it, "fixture");
    Fixture f;
    f.json = toJson(fx ? fx : it);
    yyjson_val *id = yyjson_obj_get(fx ? fx : it, "id");
    f.id = id && yyjson_is_str(id) ? yyjson_get_str(id) : "fixture" + std::to_string(i);
    yyjson_val *cls = yyjson_obj_get(it, "classification");
    if (cls && yyjson_is_str(cls)) f.classification = yyjson_get_str(cls);
    out.push_back(std::move(f));
  }
  yyjson_doc_free(doc);
  return true;
}

RunResult runFixture(const Fixture &f, const std::string &goldenDir, double sr) {
  RunResult res;
  res.sampleRate = sr;
  yyjson_doc *doc = yyjson_read(f.json.data(), f.json.size(), 0);
  if (!doc) {
    res.error = "bad fixture json";
    return res;
  }
  yyjson_val *fx = yyjson_doc_get_root(doc);
  yyjson_val *setup = yyjson_obj_get(fx, "setup");
  yyjson_val *events = yyjson_obj_get(fx, "events");
  const double seconds = num(fx, "seconds", 1.0);
  std::set<std::string> skipped;

  Sink sink;
  rig_config cfg;
  rig_config_init(&cfg);
  cfg.mode = RIG_MODE_OFFLINE;
  cfg.flags = RIG_FLAG_TEST_API;
  cfg.sample_rate = sr;
  cfg.seed = static_cast<uint32_t>(num(fx, "seed", 1));
  cfg.on_event = onEvent;
  cfg.event_user = &sink;
  rig_status st;
  rig_engine *e = rig_create(&cfg, &st);
  if (!e) {
    res.error = std::string("rig_create: ") + rig_status_string(st);
    yyjson_doc_free(doc);
    return res;
  }
  auto post = [&](const std::string &m) { return rig_post(e, m.data(), m.size()); };
  auto postSkippable = [&](const std::string &m, const char *what) {
    sink.msgs.clear();
    post(m);
    for (const auto &r : sink.msgs)
      if (r.find("\"ok\":false") != std::string::npos) skipped.insert(what);
  };
  post("{\"v\":1,\"op\":\"hello\",\"protocol\":1,\"app\":\"rig-golden\",\"id\":1}");

  yyjson_val *patch = yyjson_obj_get(setup, "patch");
  // 1. fx / master rows before start (so the song's reverb unit exists at start in the JS reference)
  if (patch) {
    yyjson_val *fxo = yyjson_obj_get(patch, "fx");
    size_t i, n;
    yyjson_val *k, *v;
    if (fxo && yyjson_is_obj(fxo)) {
      yyjson_obj_foreach(fxo, i, n, k, v) {
        if (!yyjson_is_obj(v)) continue;
        size_t j, m;
        yyjson_val *k2, *v2;
        yyjson_obj_foreach(v, j, m, k2, v2) {
          std::string path = std::string("fx.") + yyjson_get_str(k) + "." + yyjson_get_str(k2);
          postSkippable("{\"v\":1,\"op\":\"set\",\"id\":2,\"path\":\"" + path + "\",\"value\":" + toJson(v2) + "}",
                        "fx rows");
        }
      }
    }
  }
  post("{\"v\":1,\"op\":\"audio\",\"action\":\"start\",\"id\":3}");
  const char *keys[] = {"tempo", "timeSig"};
  for (const char *key : keys)
    if (yyjson_val *v = yyjson_obj_get(setup, key))
      postSkippable("{\"v\":1,\"op\":\"song\",\"id\":4,\"" + std::string(key) + "\":" + toJson(v) + "}", "song state");
  if (yyjson_obj_get(setup, "click")) skipped.insert("click");
  // 2. prepare + commit at t = 0
  if (patch) {
    sink.msgs.clear();
    post("{\"v\":1,\"op\":\"prepare\",\"id\":5,\"patch\":" + toJson(patch) + "}");
    long token = -1;
    for (const auto &r : sink.msgs) {
      const size_t p = r.find("\"token\":");
      if (p != std::string::npos) token = std::strtol(r.c_str() + p + 8, nullptr, 10);
    }
    if (token < 0) {
      res.error = "prepare failed: " + (sink.msgs.empty() ? std::string("no reply") : sink.msgs.back());
      rig_destroy(e);
      yyjson_doc_free(doc);
      return res;
    }
    post("{\"v\":1,\"op\":\"commit\",\"id\":6,\"token\":" + std::to_string(token) + ",\"when\":0}");
  }
  for (const char *key : {"transpose", "keyContext", "drone", "wheel"})
    if (yyjson_obj_get(setup, key)) skipped.insert(key);
  // 3. inject + tap
  if (yyjson_val *inj = yyjson_obj_get(setup, "inject")) {
    const char *name = yyjson_get_str(yyjson_obj_get(inj, "stimulus"));
    const char *at = yyjson_get_str(yyjson_obj_get(inj, "at"));
    io::WavData wav;
    std::string werr;
    if (!name || !at || !io::readWav(goldenDir + "/stimuli/" + name + ".wav", wav, &werr)) {
      res.error = "stimulus: " + werr;
      rig_destroy(e);
      yyjson_doc_free(doc);
      return res;
    }
    // The reference (tools/golden/page.js) always injects a 2-channel buffer: a mono stimulus is dual-mono, which
    // matters because the stereo pan law is unity at centre while the mono law is -3 dB.
    std::vector<const float *> ptrs;
    for (auto &c : wav.ch) ptrs.push_back(c.data());
    if (ptrs.size() == 1) ptrs.push_back(wav.ch[0].data());
    const rig_status s = rig_test_inject(e, at, ptrs.data(), static_cast<uint32_t>(ptrs.size()), wav.frames(),
                                         num(inj, "start", 0.0), static_cast<float>(num(inj, "gain", 1.0)));
    if (s != RIG_OK) skipped.insert(std::string("inject ") + at);
  }
  const char *tap = "out";
  if (yyjson_val *t = yyjson_obj_get(setup, "tap")) tap = yyjson_get_str(t);
  if (rig_test_tap(e, tap) != RIG_OK) skipped.insert(std::string("tap ") + tap);
  // 4. events (each with when = t)
  size_t i, n;
  yyjson_val *ev;
  yyjson_arr_foreach(events, i, n, ev) {
    const char *type = yyjson_get_str(yyjson_obj_get(ev, "type"));
    const std::string when = std::to_string(num(ev, "t", 0.0));
    if (!type) continue;
    const std::string ty = type;
    if (ty == "noteOn")
      post("{\"v\":1,\"op\":\"play\",\"e\":\"on\",\"n\":" + std::to_string(static_cast<int>(num(ev, "note", 60))) +
           ",\"vel\":" + std::to_string(static_cast<int>(num(ev, "vel", 100))) + ",\"when\":" + when + "}");
    else if (ty == "noteOff")
      post("{\"v\":1,\"op\":\"play\",\"e\":\"off\",\"n\":" + std::to_string(static_cast<int>(num(ev, "note", 60))) +
           ",\"when\":" + when + "}");
    else if (ty == "param")
      postSkippable("{\"v\":1,\"op\":\"set\",\"id\":7,\"path\":" + toJson(yyjson_obj_get(ev, "path")) +
                        ",\"value\":" + toJson(yyjson_obj_get(ev, "value")) +
                        ",\"glide\":" + std::to_string(num(ev, "glide", 0.0)) + ",\"when\":" + when + "}",
                    "param events");
    else
      skipped.insert("event " + ty);
  }
  // 5. render
  const size_t frames = static_cast<size_t>(std::ceil(seconds * sr));
  res.channels.assign(2, std::vector<float>(frames));
  float *out[2] = {res.channels[0].data(), res.channels[1].data()};
  for (size_t done = 0; done < frames;) {  // odd chunking on purpose: exercises the FIFO the same as one call
    const size_t n2 = std::min<size_t>(frames - done, 4096);
    float *p[2] = {out[0] + done, out[1] + done};
    rig_offline_render(e, p, 2, static_cast<uint32_t>(n2));
    done += n2;
  }
  rig_destroy(e);
  yyjson_doc_free(doc);
  res.skipped.assign(skipped.begin(), skipped.end());
  res.ok = true;
  return res;
}

}  // namespace rig::tools
