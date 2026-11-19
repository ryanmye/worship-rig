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
      if (r.find("\"ok\":false") != std::string::npos || r.find("\"applied\":false") != std::string::npos)
        skipped.insert(what);
  };
  // `warn` events with code 'unsupported' (e.g. an instrument type no module provides yet) are reported too.
  auto collectUnsupported = [&] {
    for (const auto &r : sink.msgs) {
      if (r.find("\"code\":\"unsupported\"") == std::string::npos) continue;
      const size_t a = r.find("'"), b = a == std::string::npos ? a : r.find("'", a + 1);
      if (b != std::string::npos) skipped.insert("instrument " + r.substr(a + 1, b - a - 1));
    }
  };
  post("{\"v\":1,\"op\":\"hello\",\"protocol\":1,\"app\":\"rig-golden\",\"id\":1}");

  yyjson_val *patch = yyjson_obj_get(setup, "patch");
  auto str = [](yyjson_val *v) { return toJson(v); };
  auto field = [&](yyjson_val *o, const char *k) -> std::string {
    yyjson_val *v = yyjson_obj_get(o, k);
    return v ? std::string(",\"") + k + "\":" + str(v) : std::string();
  };
  const std::string kindStr = [&] {
    yyjson_val *k = yyjson_obj_get(fx, "kind");
    return k && yyjson_is_str(k) ? std::string(yyjson_get_str(k)) : std::string();
  }();
  if (kindStr == "drone-freeze") {
    // renderDroneLoop in page.js (key, params, reverb, loopSec, prerollSec, seamSec): no bridge equivalent until T16
    // decides question 7; rendered as silence and reported.
    skipped.insert("drone-freeze");
  }
  // 1. fx / master rows before start (page.js: start() builds reverb/delay/lofi/glue for the song's values)
  if (patch) {
    yyjson_val *fxo = yyjson_obj_get(patch, "fx");
    size_t i, n;
    yyjson_val *k, *v;
    if (fxo && yyjson_is_obj(fxo)) {
      yyjson_obj_foreach(fxo, i, n, k, v) {
        if (!yyjson_is_obj(v)) continue;
        size_t j, m;
        yyjson_val *k2, *v2;
        const std::string unit = yyjson_get_str(k);
        yyjson_obj_foreach(v, j, m, k2, v2) {
          const std::string path = (unit == "master" ? "master." : "fx." + unit + ".") + yyjson_get_str(k2);
          postSkippable("{\"v\":1,\"op\":\"set\",\"id\":2,\"path\":\"" + path + "\",\"value\":" + str(v2) + "}",
                        "fx rows");
        }
      }
    }
  }
  post("{\"v\":1,\"op\":\"audio\",\"action\":\"start\",\"id\":3}");
  if (yyjson_val *v = yyjson_obj_get(setup, "tempo"))
    postSkippable("{\"v\":1,\"op\":\"song\",\"id\":4,\"tempo\":" + str(v) + "}", "song tempo");
  if (yyjson_val *v = yyjson_obj_get(setup, "timeSig"))
    postSkippable("{\"v\":1,\"op\":\"song\",\"id\":4,\"timeSig\":" + str(v) + "}", "song timeSig");
  if (yyjson_val *c = yyjson_obj_get(setup, "click"))
    postSkippable("{\"v\":1,\"op\":\"click\",\"id\":4,\"action\":\"config\"" + field(c, "level") + field(c, "record") +
                      field(c, "output") + ",\"when\":0}",
                  "click config");
  // 2. prepare + commit at t = 0
  if (patch) {
    sink.msgs.clear();
    post("{\"v\":1,\"op\":\"prepare\",\"id\":5,\"patch\":" + str(patch) + "}");
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
    sink.msgs.clear();
    post("{\"v\":1,\"op\":\"commit\",\"id\":6,\"token\":" + std::to_string(token) + ",\"when\":0}");
    collectUnsupported();
  }
  if (yyjson_val *v = yyjson_obj_get(setup, "transpose"))
    postSkippable("{\"v\":1,\"op\":\"song\",\"id\":7,\"transpose\":" + str(v) + "}", "song transpose");
  if (yyjson_val *kc = yyjson_obj_get(setup, "keyContext"))
    postSkippable("{\"v\":1,\"op\":\"song\",\"id\":7,\"key\":{\"pc\":" + str(yyjson_obj_get(kc, "pc")) +
                      ",\"minor\":" + (yyjson_get_bool(yyjson_obj_get(kc, "minor")) ? "true" : "false") + "}}",
                  "song key");
  if (yyjson_val *d = yyjson_obj_get(setup, "drone"); d && kindStr != "drone-freeze") {
    yyjson_val *mode = yyjson_obj_get(d, "mode");
    if (mode && yyjson_is_str(mode) && std::strcmp(yyjson_get_str(mode), "off") != 0) {
      yyjson_val *key = yyjson_obj_get(d, "key");
      const std::string pc = key && yyjson_obj_get(key, "pc") ? str(yyjson_obj_get(key, "pc")) : "0";
      const bool minor = key && yyjson_get_bool(yyjson_obj_get(key, "minor"));
      postSkippable("{\"v\":1,\"op\":\"drone\",\"id\":8,\"key\":{\"pc\":" + pc + ",\"minor\":" +
                        (minor ? "true" : "false") + "},\"when\":0}",
                    "drone");
      // config = the drone object without `key` (page.js: const {key, ...cfg} = s.drone)
      std::string cfgJson = "{";
      size_t i, n;
      yyjson_val *k, *v;
      yyjson_obj_foreach(d, i, n, k, v) {
        if (!std::strcmp(yyjson_get_str(k), "key")) continue;
        if (cfgJson.size() > 1) cfgJson += ',';
        cfgJson += str(k) + ":" + str(v);
      }
      cfgJson += "}";
      postSkippable("{\"v\":1,\"op\":\"drone\",\"id\":8,\"config\":" + cfgJson + ",\"when\":0}", "drone");
    }
  }
  if (yyjson_val *w = yyjson_obj_get(setup, "wheel")) {
    for (const char *src : {"mod", "expr"}) {
      yyjson_val *v = yyjson_obj_get(w, src);
      if (v && yyjson_is_num(v))
        postSkippable("{\"v\":1,\"op\":\"play\",\"id\":9,\"e\":\"wheel\",\"src\":\"" + std::string(src) +
                          "\",\"value\":" + str(v) + ",\"when\":0}",
                      "wheel");
    }
  }
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
  // 4. events (each with when = t; page.js applyEvent)
  size_t i, n;
  yyjson_val *ev;
  yyjson_arr_foreach(events, i, n, ev) {
    const char *type = yyjson_get_str(yyjson_obj_get(ev, "type"));
    if (!type) continue;
    const std::string when = ",\"when\":" + str(yyjson_obj_get(ev, "t")) + "}";
    const std::string ty = type;
    const std::string play = "{\"v\":1,\"op\":\"play\",\"id\":10,\"e\":";
    auto wheel = [&](const char *src, double value) {
      postSkippable(play + "\"wheel\",\"src\":\"" + src + "\",\"value\":" + std::to_string(value) + when, "wheel");
    };
    if (ty == "noteOn")
      post(play + "\"on\",\"n\":" + std::to_string(static_cast<int>(num(ev, "note", 60))) +
           ",\"vel\":" + std::to_string(static_cast<int>(num(ev, "vel", 100))) + field(ev, "touch") + when);
    else if (ty == "noteOff")
      post(play + "\"off\",\"n\":" + std::to_string(static_cast<int>(num(ev, "note", 60))) + when);
    else if (ty == "pedal")
      postSkippable(play + "\"pedal\",\"down\":" + (yyjson_get_bool(yyjson_obj_get(ev, "down")) ? "true" : "false") +
                        when,
                    "pedal");
    else if (ty == "cc") {  // controller.js mapping: 1 mod, 11 expression, 7 volume, 64 sustain (>= 64 down)
      const int cc = static_cast<int>(num(ev, "cc", -1));
      const double value = num(ev, "value", 0.0);
      if (cc == 1)
        wheel("mod", value / 127.0);
      else if (cc == 11)
        wheel("expr", value / 127.0);
      else if (cc == 7)
        wheel("vol", value / 127.0);
      else if (cc == 64)
        postSkippable(play + "\"pedal\",\"down\":" + (value >= 64 ? "true" : "false") + when, "pedal");
      else
        skipped.insert("cc " + std::to_string(cc));
    } else if (ty == "wheel")
      postSkippable(play + "\"wheel\",\"src\":" + str(yyjson_obj_get(ev, "source")) +
                        ",\"value\":" + str(yyjson_obj_get(ev, "value")) +
                        ",\"glide\":" + std::to_string(num(ev, "glide", 0.0)) + when,
                    "wheel");
    else if (ty == "bend")
      postSkippable(play + "\"bend\",\"x\":" + str(yyjson_obj_get(ev, "value")) + when, "bend");
    else if (ty == "param")
      postSkippable("{\"v\":1,\"op\":\"set\",\"id\":7,\"path\":" + str(yyjson_obj_get(ev, "path")) +
                        ",\"value\":" + str(yyjson_obj_get(ev, "value")) +
                        ",\"glide\":" + std::to_string(num(ev, "glide", 0.0)) + when,
                    "param events");
    else if (ty == "droneKey")
      postSkippable("{\"v\":1,\"op\":\"drone\",\"id\":11,\"key\":{\"pc\":" + str(yyjson_obj_get(ev, "pc")) +
                        ",\"minor\":" + (yyjson_get_bool(yyjson_obj_get(ev, "minor")) ? "true" : "false") +
                        field(ev, "fade") + "}" + when,
                    "droneKey");
    else if (ty == "clickStart")
      postSkippable("{\"v\":1,\"op\":\"click\",\"id\":12,\"action\":\"start\",\"countIn\":" +
                        std::to_string(static_cast<int>(num(ev, "countIn", 0))) + ",\"quietAfter\":" +
                        (yyjson_get_bool(yyjson_obj_get(ev, "quietAfter")) ? "true" : "false") + when,
                    "clickStart");
    else if (ty == "clickStop")
      postSkippable("{\"v\":1,\"op\":\"click\",\"id\":12,\"action\":\"stop\"" + when, "clickStop");
    else if (ty == "swell")
      postSkippable(play + "\"swell\",\"start\":" + (yyjson_get_bool(yyjson_obj_get(ev, "start")) ? "true" : "false") +
                        when,
                    "swell");
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
