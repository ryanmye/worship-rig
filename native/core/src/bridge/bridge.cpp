#include "bridge/bridge.h"

#include <cmath>
#include <cstring>
#include <string>

#include "api/engine.h"
#include "bridge/json_out.h"
#include "model/patch.h"
#include "params/params.h"
#include "yyjson.h"

namespace rig {
namespace {

struct Req {
  yyjson_val *m = nullptr;
  bool hasId = false;
  std::uint64_t id = 0;
  std::string op;
};

std::string envelopeHead(const Req &r, bool ok) {
  JsonOut j;
  j.raw("{\"v\":1,\"re\":").num(static_cast<double>(r.id)).raw(ok ? ",\"ok\":true" : ",\"ok\":false");
  return j.take();
}

void warn(Engine &e, const std::string &msg, const char *code, const std::string &op) {
  JsonOut j;
  j.begin().kv("v", 1).kv("ev", "warn").kv("message", msg);
  if (code) j.kv("code", code);
  if (!op.empty()) j.kv("op", op);
  j.end();
  e.emit(j.take());
}

void ok(Engine &e, const Req &r, const std::string &resultJson) {
  if (!r.hasId) return;
  e.emit(envelopeHead(r, true) + ",\"result\":" + resultJson + "}");
}

void fail(Engine &e, const Req &r, const char *code, const std::string &msg) {
  if (!r.hasId) {
    warn(e, msg, code, r.op);
    return;
  }
  JsonOut j;
  j.raw(",\"error\":").begin().kv("code", code).kv("message", msg).end();
  e.emit(envelopeHead(r, false) + j.take() + "}");
}

double getNum(yyjson_val *o, const char *k, double dflt) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return v && yyjson_is_num(v) ? yyjson_get_num(v) : dflt;
}
const char *getStr(yyjson_val *o, const char *k) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return v && yyjson_is_str(v) ? yyjson_get_str(v) : nullptr;
}
/** `when`: absent / null / non-numeric = now (-1). */
double getWhen(yyjson_val *o) {
  return getNum(o, "when", -1.0);
}

void opHello(Engine &e, const Req &r) {
  if (getNum(r.m, "protocol", 1) != RIG_BRIDGE_PROTOCOL) {
    fail(e, r, "protocol", "unsupported protocol version");
    return;
  }
  JsonOut j;
  j.begin().kv("protocol", RIG_BRIDGE_PROTOCOL).kv("minor", 0).kv("engine", rig_version_string());
  j.key("caps").beginArray().elemStr("skeleton").elemStr("when").elemStr("testVoice").endArray();
  j.kv("sampleRate", e.sampleRate()).kv("seed", e.seed()).end();
  ok(e, r, j.take());
}

void opAudio(Engine &e, const Req &r) {
  const char *action = getStr(r.m, "action");
  if (!action) return fail(e, r, "bad-request", "audio: action required");
  const std::string a = action;
  JsonOut j;
  if (a == "sleep" || a == "wake") {
    e.setAwake(a == "wake");  // T00: immediate, no ramp
    j.begin().kvBool("done", true).end();
  } else if (a == "start" || a == "restart" || a == "output") {
    const char *dev = getStr(r.m, "deviceId");
    e.requestAudio(a, dev ? dev : "", getNum(r.m, "latency", 0.0));
    j.begin().kv("state", e.host() ? "suspended" : "running").kv("sleep", e.awake() ? "awake" : "asleep");
    j.kv("latencyMs", 0).kv("sampleRate", e.sampleRate()).kv("deviceId", dev ? dev : "default");
    j.kv("channels", e.outChannels()).end();
  } else {
    return fail(e, r, "bad-request", "audio: unknown action " + a);
  }
  ok(e, r, j.take());
}

void opPrepare(Engine &e, const Req &r) {
  PatchSpec p;
  std::string err;
  if (!parsePatch(yyjson_obj_get(r.m, "patch"), p, &err)) return fail(e, r, "bad-request", "prepare: " + err);
  const std::uint32_t token = e.model().prepare(std::move(p));
  JsonOut j;
  j.begin().kv("token", token).end();
  ok(e, r, j.take());
}

void opCommit(Engine &e, const Req &r) {
  yyjson_val *t = yyjson_obj_get(r.m, "token");
  if (!t || !yyjson_is_num(t)) return fail(e, r, "bad-request", "commit: token required");
  const bool committed = e.model().commit(static_cast<std::uint32_t>(yyjson_get_num(t)), getWhen(r.m));
  if (!committed) return fail(e, r, "stale-token", "commit: unknown or superseded token");
  JsonOut j;
  j.begin().kvBool("committed", true).end();
  ok(e, r, j.take());
}

bool setOne(Engine &e, const Req &r, const char *path, yyjson_val *value, double glide, double when, bool single) {
  const SetResult s = e.model().set(path, value, glide, when);
  if (single && s.status == SetResult::Unknown)
    fail(e, r, "unknown-param", s.message);
  else if (single && s.status == SetResult::Bad)
    fail(e, r, "bad-request", s.message);
  return s.status == SetResult::Applied;
}

void opSet(Engine &e, const Req &r) {
  const double when = getWhen(r.m);
  yyjson_val *batch = yyjson_obj_get(r.m, "batch");
  if (batch && yyjson_is_arr(batch)) {
    JsonOut j;
    j.beginArray();
    std::size_t i, n;
    yyjson_val *it;
    yyjson_arr_foreach(batch, i, n, it) {
      bool applied = false;
      if (yyjson_is_arr(it) && yyjson_arr_size(it) >= 2) {
        yyjson_val *p = yyjson_arr_get(it, 0);
        yyjson_val *g = yyjson_arr_size(it) > 2 ? yyjson_arr_get(it, 2) : nullptr;
        if (yyjson_is_str(p))
          applied = setOne(e, r, yyjson_get_str(p), yyjson_arr_get(it, 1),
                           g && yyjson_is_num(g) ? yyjson_get_num(g) : 0.0, when, false);
      }
      j.elemBool(applied);
    }
    j.endArray();
    return ok(e, r, "{\"applied\":" + j.take() + "}");
  }
  const char *path = getStr(r.m, "path");
  yyjson_val *value = yyjson_obj_get(r.m, "value");
  if (!path || !value) return fail(e, r, "bad-request", "set: path and value required");
  const SetResult s = e.model().set(path, value, getNum(r.m, "glide", 0.0), when);
  if (s.status == SetResult::Unknown) return fail(e, r, "unknown-param", s.message);
  if (s.status == SetResult::Bad) return fail(e, r, "bad-request", s.message);
  ok(e, r, s.status == SetResult::Applied ? "{\"applied\":true}" : "{\"applied\":false}");
}

void opPlay(Engine &e, const Req &r) {
  const char *ev = getStr(r.m, "e");
  if (!ev) return fail(e, r, "bad-request", "play: e required");
  const std::string k = ev;
  const double when = getWhen(r.m);
  bool done = false;
  Model &m = e.model();
  if (k == "on")
    done = m.noteOn(static_cast<int>(getNum(r.m, "n", 60)), static_cast<int>(getNum(r.m, "vel", 100)), when,
                    yyjson_obj_get(r.m, "touch"));
  else if (k == "off")
    done = m.noteOff(static_cast<int>(getNum(r.m, "n", 60)), when);
  else if (k == "panic") {
    m.panic(when);
    done = true;
  } else if (k == "pedal") {  // bool-returning skeletons answer {ok:false} until T14 implements them
    done = m.sustain(yyjson_is_true(yyjson_obj_get(r.m, "down")), when);
  } else if (k == "wheel") {
    const char *src = getStr(r.m, "src");
    done = m.setWheel(src ? src : "mod", getNum(r.m, "value", 0.0), when, getNum(r.m, "glide", 0.0));
  } else if (k == "swell") {
    yyjson_val *s = yyjson_obj_get(r.m, "start");
    done = m.swell(s && yyjson_is_bool(s) ? (yyjson_get_bool(s) ? 1 : 0) : -1, when);
  } else {
    // bend / fade / input: void Model skeletons (T14); kept `unsupported` so callers and the golden runner can tell
    return fail(e, r, "unsupported", "play: '" + k + "' is not implemented yet (T14)");
  }
  ok(e, r, done ? "{\"ok\":true}" : "{\"ok\":false}");
}

void opGet(Engine &e, const Req &r) {
  const char *what = getStr(r.m, "what");
  if (!what) return fail(e, r, "bad-request", "get: what required");
  const std::string w = what;
  Model &m = e.model();
  std::string res;
  if (w == "state")
    res = m.stateJson();
  else if (w == "stats")
    res = e.statsJson();
  else if (w == "devices")
    res = e.deviceListJson();
  else if (w == "instruments") {
    if (yyjson_is_true(yyjson_obj_get(r.m, "reload"))) m.reloadManifests();
    res = m.listInstruments();
  } else if (w == "sampleStatus")
    res = m.sampleStatus(yyjson_obj_get(r.m, "patches"));
  if (res.empty()) return fail(e, r, "unsupported", "get: '" + w + "' has no provider in this build");
  ok(e, r, res);
}

// ---- ops whose bodies live in module services (WAVE0B_REVIEW V1: SETUP_REVIEW 1(f) "bridge op dispatch -> Model
// methods, one per contract member"). An EMPTY Model result or a missing service = reply `unsupported`, so the
// golden runner keeps reporting what is not implemented. T08 owns this file and refines it.

/** Reply `unsupported` unless the named service is registered. */
bool needService(Engine &e, const Req &r, const char *name) {
  if (e.model().service(name)) return true;
  fail(e, r, "unsupported", "op '" + r.op + "': no '" + std::string(name) + "' module in this build");
  return false;
}

void opSong(Engine &e, const Req &r) {  // contract order: transpose, routing, tempo, timeSig, key
  Model &m = e.model();
  const double when = getWhen(r.m);
  if (yyjson_val *v = yyjson_obj_get(r.m, "transpose"); v && yyjson_is_num(v))
    m.setTranspose(static_cast<int>(std::lround(yyjson_get_num(v))));
  if (yyjson_val *v = yyjson_obj_get(r.m, "routing"); v && yyjson_is_obj(v)) m.setRouting(v, when);
  if (yyjson_val *v = yyjson_obj_get(r.m, "tempo")) {
    if (yyjson_is_null(v))
      m.setTempo(0);
    else if (yyjson_is_num(v))
      m.setTempo(yyjson_get_num(v));
  }
  if (const char *sig = getStr(r.m, "timeSig")) m.setTimeSig(sig, yyjson_is_true(yyjson_obj_get(r.m, "newBar")));
  if (yyjson_val *k = yyjson_obj_get(r.m, "key"); k && yyjson_is_obj(k))
    m.setKeyContext(static_cast<int>(getNum(k, "pc", 0)), yyjson_is_true(yyjson_obj_get(k, "minor")));
  ok(e, r, "{}");
}

void opClick(Engine &e, const Req &r) {
  const char *action = getStr(r.m, "action");
  if (!action) return fail(e, r, "bad-request", "click: action required");
  if (!needService(e, r, ClickService::kName)) return;
  Model &m = e.model();
  const std::string a = action;
  const double when = getWhen(r.m);
  std::string res;
  if (a == "start")
    res = m.clickStart(static_cast<int>(getNum(r.m, "countIn", 0)), yyjson_is_true(yyjson_obj_get(r.m, "quietAfter")),
                       when);
  else if (a == "stop")
    res = std::string("{\"wasRunning\":") + (m.clickStop(when) ? "true" : "false") + "}";
  else if (a == "config")
    res = m.setClick(r.m, when);
  else
    return fail(e, r, "bad-request", "click: unknown action " + a);
  if (res.empty()) return fail(e, r, "unsupported", "click: '" + a + "' not implemented");
  ok(e, r, res);
}

void opDrone(Engine &e, const Req &r) {  // contract order: key, files, config
  if (!needService(e, r, DroneService::kName)) return;
  Model &m = e.model();
  const double when = getWhen(r.m);
  JsonOut j;
  j.begin();
  if (yyjson_val *k = yyjson_obj_get(r.m, "key"); k && yyjson_is_obj(k))
    j.kvBool("changed", m.droneSetKey(static_cast<int>(getNum(k, "pc", 0)), yyjson_is_true(yyjson_obj_get(k, "minor")),
                                      getNum(k, "fade", -1.0), when));
  if (yyjson_val *f = yyjson_obj_get(r.m, "files"); f && yyjson_is_arr(f)) {
    const int n = m.droneAttachFiles(f);
    if (n < 0) return fail(e, r, "unsupported", "drone: files not implemented");
    j.kv("files", n);
  }
  if (yyjson_val *c = yyjson_obj_get(r.m, "config"); c && yyjson_is_obj(c)) m.droneConfigure(c, when);
  j.end();
  ok(e, r, j.take());
}

void opCache(Engine &e, const Req &r) {
  const char *action = getStr(r.m, "action");
  if (!action) return fail(e, r, "bad-request", "cache: action required");
  Model &m = e.model();
  const std::string a = action;
  yyjson_val *patches = yyjson_obj_get(r.m, "patches");
  std::string res;
  if (a == "preload") {
    const char *pin = getStr(r.m, "pin");
    res = m.preload(patches, pin ? pin : "auto");
  } else if (a == "estimate") {
    res = m.estimatePreloadMB(patches);
  } else if (a == "retainReverb") {
    if (!needService(e, r, ReverbService::kName)) return;
    res = std::string("{\"ok\":") + (m.retainReverb(patches) ? "true" : "false") + "}";
  } else {
    return fail(e, r, "bad-request", "cache: unknown action " + a);
  }
  if (res.empty()) return fail(e, r, "unsupported", "cache: '" + a + "' has no provider in this build");
  ok(e, r, res);
}

void opConfig(Engine &e, const Req &r) {
  Model &m = e.model();
  const double when = getWhen(r.m);
  JsonOut j;
  j.begin();
  if (yyjson_val *v = yyjson_obj_get(r.m, "mono"); v && yyjson_is_bool(v)) m.setMono(yyjson_get_bool(v));
  if (yyjson_val *v = yyjson_obj_get(r.m, "lowResource"); v && yyjson_is_bool(v))
    j.kvBool("lowResource", m.setLowResource(yyjson_get_bool(v)));
  if (yyjson_val *a = yyjson_obj_get(r.m, "eqAudition"); a && yyjson_is_obj(a)) {
    const char *mode = getStr(a, "mode");
    j.kvBool("eqAudition", m.eqAudition(static_cast<int>(getNum(a, "slot", -1)), mode ? mode : "off", when));
  }
  if (yyjson_val *v = yyjson_obj_get(r.m, "meters"); v && yyjson_is_obj(v)) m.subscribeMeters(v);
  if (yyjson_val *c = yyjson_obj_get(r.m, "midiClock"); c && yyjson_is_obj(c)) m.setClockPort(getStr(c, "port"));
  j.end();
  ok(e, r, j.take());
}

void opRec(Engine &e, const Req &r) {
  const char *action = getStr(r.m, "action");
  if (!action) return fail(e, r, "bad-request", "rec: action required");
  if (!needService(e, r, RecService::kName)) return;
  const std::string a = action;
  std::string res;
  if (a == "start")
    res = e.model().recStart(r.m);
  else if (a == "stop")
    res = e.model().recStop();
  else
    return fail(e, r, "bad-request", "rec: unknown action " + a);
  if (res.empty()) return fail(e, r, "unsupported", "rec: '" + a + "' not implemented");
  ok(e, r, res);
}

void opMidi(Engine &e, const Req &r) {
  if (!needService(e, r, MidiService::kName)) return;
  const std::string res = e.model().midiOp(r.m);
  if (res.empty()) return fail(e, r, "unsupported", "midi: not implemented");
  ok(e, r, res);
}

}  // namespace

bool Bridge::handle(const char *json, std::size_t len) {
  yyjson_doc *doc = yyjson_read(json, len, 0);
  if (!doc) return false;
  yyjson_val *root = yyjson_doc_get_root(doc);
  auto one = [&](yyjson_val *m) {
    if (!yyjson_is_obj(m)) {
      warn(e_, "message is not an object", "bad-request", "");
      return;
    }
    Req r;
    r.m = m;
    yyjson_val *id = yyjson_obj_get(m, "id");
    if (id && yyjson_is_uint(id)) {
      r.hasId = true;
      r.id = yyjson_get_uint(id);
    } else if (id && yyjson_is_sint(id) && yyjson_get_sint(id) > 0) {
      r.hasId = true;
      r.id = static_cast<std::uint64_t>(yyjson_get_sint(id));
    }
    const char *op = getStr(m, "op");
    r.op = op ? op : "";
    yyjson_val *v = yyjson_obj_get(m, "v");
    if (!v || !yyjson_is_num(v) || yyjson_get_num(v) != RIG_BRIDGE_PROTOCOL) {
      fail(e_, r, "protocol", "message needs v:1");
      return;
    }
    if (r.op.empty()) return fail(e_, r, "bad-request", "op required");
    if (r.op == "hello") {
      helloDone_ = true;
      return opHello(e_, r);
    }
    if (!helloDone_) return fail(e_, r, "protocol", "hello must be the first message");
    if (r.op == "audio")
      opAudio(e_, r);
    else if (r.op == "prepare")
      opPrepare(e_, r);
    else if (r.op == "commit")
      opCommit(e_, r);
    else if (r.op == "set")
      opSet(e_, r);
    else if (r.op == "play")
      opPlay(e_, r);
    else if (r.op == "get")
      opGet(e_, r);
    else if (r.op == "config")
      opConfig(e_, r);
    else if (r.op == "song")
      opSong(e_, r);
    else if (r.op == "click")
      opClick(e_, r);
    else if (r.op == "drone")
      opDrone(e_, r);
    else if (r.op == "cache")
      opCache(e_, r);
    else if (r.op == "rec")
      opRec(e_, r);
    else if (r.op == "midi")
      opMidi(e_, r);
    else
      fail(e_, r, "unknown-op", "unknown op '" + r.op + "'");
  };
  if (yyjson_is_arr(root)) {
    std::size_t i, n;
    yyjson_val *it;
    yyjson_arr_foreach(root, i, n, it) one(it);
  } else if (yyjson_is_obj(root)) {
    one(root);
  } else {
    yyjson_doc_free(doc);
    return false;
  }
  yyjson_doc_free(doc);
  return true;
}

}  // namespace rig
