#include "bridge/bridge.h"

#include <cmath>
#include <cstring>
#include <exception>
#include <stdexcept>
#include <string>

#include "api/engine.h"
#include "bridge/json_out.h"
#include "bridge/schema.h"
#include "drone/drone_service.h"  // T16: config {droneFreeze}
#include "model/param_read.h"  // INTERFACE-CHANGE(CORE2B): get param
#include "model/patch.h"
#include "params/params.h"
#include "samples/cache_service.h"  // CORE2A: preloadAsync, the prepare reply after its samples decoded
#include "yyjson.h"

namespace rig {

struct Req {
  yyjson_val *m = nullptr;
  bool hasId = false;
  std::uint64_t id = 0;
  std::string op;
};

namespace {

// The bridge handling the current message (re-entrant: an offline on_event callback may post again).
thread_local Bridge *g_current = nullptr;
Bridge *bridgeOf(Engine &) {
  return g_current;
}


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

/** A service result: "" = unsupported, {"error":{code,message}} = error reply (services' convention, T08), else ok. */
void reply(Engine &e, const Req &r, const std::string &res, const std::string &what) {
  if (res.empty()) return fail(e, r, "unsupported", what + " is not implemented in this build");
  if (res.rfind("{\"error\":", 0) == 0) {
    yyjson_doc *d = yyjson_read(res.data(), res.size(), 0);
    yyjson_val *er = d ? yyjson_obj_get(yyjson_doc_get_root(d), "error") : nullptr;
    yyjson_val *c = er ? yyjson_obj_get(er, "code") : nullptr;
    yyjson_val *m = er ? yyjson_obj_get(er, "message") : nullptr;
    const std::string code = c && yyjson_is_str(c) ? yyjson_get_str(c) : "internal";
    const std::string msg = m && yyjson_is_str(m) ? yyjson_get_str(m) : what + " failed";
    if (d) yyjson_doc_free(d);
    return fail(e, r, code.c_str(), msg);
  }
  ok(e, r, res);
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
  // T00c: minor 1 = D1-D3 (config.polyphony, audio.bufferFrames, 16 slots), each with a capability string.
  // INTERFACE-CHANGE(D4): minor 2 = config.voiceLimit (contract README rule; D4 review R4, wave-2 integrator)
  // INTERFACE-CHANGE(W3B): minor 3 = config.droneFreeze (D5, T16), capability "droneFreeze"
  // INTERFACE-CHANGE(UIB): minor 4 = config.dynamicRange (T12 O1, settings.dynamicRange), capability "dynamicRange"
  // INTERFACE-CHANGE(CORE2B): minor 5 = `get {what:'param', path}` (engine.getParam contracted), capability
  // "getParam"; the tick now fills `pedal` / `held` and `runtime.swelling` (contract 6.5 rows that were unfilled).
  // A minor-5 core also has CORE2A's timing (no shape change, no capability): `cache preload` answered from the
  // control loop, a realtime `prepare` answered once its samples are decoded.
  j.begin().kv("protocol", RIG_BRIDGE_PROTOCOL).kv("minor", 5).kv("engine", rig_version_string());
  j.key("caps").beginArray().elemStr("when").elemStr("testVoice").elemStr("meters").elemStr("rta");
  j.elemStr("polyphony").elemStr("bufferFrames").elemStr("slots16");
  j.elemStr("voiceLimit");  // D4 (additive, minor 2)
  j.elemStr("droneFreeze");  // D5 / T16 (additive, minor 3)
  j.elemStr("dynamicRange");  // T12 O1 / UIB (additive, minor 4)
  j.elemStr("getParam");  // INTERFACE-CHANGE(CORE2B) (additive, minor 5)
  if (e.model().service(RecService::kName)) j.elemStr("rec");
  j.endArray();
  j.kv("sampleRate", e.sampleRate()).kv("seed", e.seed()).end();
  ok(e, r, j.take());
}

void opAudio(Engine &e, Bridge &b, const Req &r) {
  const std::string a = getStr(r.m, "action");
  if (a == "sleep" || a == "wake") {
    const double ramp = getNum(r.m, "ramp", -1.0);
    const bool done = a == "sleep" ? e.sleepAudio(ramp) : e.wakeAudio(ramp);
    return ok(e, r, done ? "{\"done\":true}" : "{\"done\":false}");
  }
  const char *dev = getStr(r.m, "deviceId");
  yyjson_val *lat = yyjson_obj_get(r.m, "latency");  // 'interactive' | seconds (0 = interactive)
  const double latency = lat && yyjson_is_num(lat) ? yyjson_get_num(lat) : 0.0;
  // T00c D2: host buffer size (validated 64|128|256|512 by the schema; absent = keep the last request)
  const auto frames = static_cast<std::uint32_t>(getNum(r.m, "bufferFrames", 0));
  if (const char *err = e.requestAudio(a, dev ? dev : "", latency, frames); *err)
    return fail(e, r, err, std::string("audio ") + a + ": " +
                               (std::strcmp(err, "busy") == 0 ? "a device start is still pending"
                                                              : "the host has no audio output"));
  if (a == "restart") b.restartFloor_ = b.maxToken_;  // in-flight prepares die with the old context
  ok(e, r, e.stateFieldsJson(e.deviceState()));
}

void opPrepare(Engine &e, const Req &r) {
  PatchSpec p;
  std::string err;
  if (!parsePatch(yyjson_obj_get(r.m, "patch"), p, &err)) return fail(e, r, "bad-request", "prepare: " + err);
  // CORE2A (PARITY UI row 1): audio.js prepare resolves once the new song's samples are decoded, while the old song
  // plays on, and the controller commits only then. The reply therefore waits until none of the samples the new
  // sampler units requested is still decoding (the control loop keeps running: the reply goes out from its pump()).
  // A newer prepare supersedes: replies still waiting are sent at once (their tokens can no longer commit).
  // Offline (inline decodes) nothing is in flight and the reply goes out here, as before.
  Bridge *b = bridgeOf(e);
  auto *cs = dynamic_cast<samples::CacheServiceImpl *>(e.model().service<CacheService>());
  std::vector<std::string> keys = cs && r.hasId ? cs->samplerLoadKeys(p) : std::vector<std::string>();
  const std::uint32_t token = e.model().prepare(std::move(p));
  if (b) b->maxToken_ = std::max(b->maxToken_, token);
  JsonOut j;
  j.begin().kv("token", token).end();
  if (!b || !cs || !r.hasId) return ok(e, r, j.take());
  for (auto &w : b->pendingPrepares_) {
    if (w->sent) continue;
    w->sent = true;
    e.emit(std::move(w->text));
  }
  b->pendingPrepares_.clear();
  auto w = std::make_shared<Bridge::PendingReply>();
  w->text = envelopeHead(r, true) + ",\"result\":" + j.take() + "}";
  b->pendingPrepares_.push_back(w);
  cs->whenSettled(keys, [&e, w] {
    if (w->sent) return;
    w->sent = true;
    e.emit(std::move(w->text));
  });
}

void opCommit(Engine &e, const Req &r) {
  yyjson_val *t = yyjson_obj_get(r.m, "token");
  if (!t || !yyjson_is_num(t)) return fail(e, r, "bad-request", "commit: token required");
  const double tv = yyjson_get_num(t);
  const std::uint32_t token = tv >= 1 && tv <= 4294967295.0 ? static_cast<std::uint32_t>(tv) : 0;
  Bridge *b = bridgeOf(e);
  if (!token || (b && token > b->maxToken_)) return fail(e, r, "stale-token", "commit: unknown token");
  if (b && token <= b->restartFloor_ && token != b->committedToken_)
    return fail(e, r, "superseded", "commit: token prepared before an audio restart");
  if (!e.model().commit(token, getWhen(r.m)))
    return fail(e, r, "superseded", "commit: token superseded by later prepares");
  if (b) b->committedToken_ = token;
  // INTERFACE-CHANGE(W3A) T00c review O2: rig_meters.slot_count is set by Model::commit (CommandSink::setSlotCount)
  // for every commit, not only this one
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
  } else if (k == "bend") {  // T14: contract 1.4 pitchBend / fadeOutAll / noteInput (void: always ok)
    m.pitchBend(getNum(r.m, "x", 0.0), when);
    done = true;
  } else if (k == "fade") {
    m.fadeOutAll(getNum(r.m, "seconds", 6.0), when);
    done = true;
  } else if (k == "input") {
    m.noteInput(when);
    done = true;
  } else {
    return fail(e, r, "bad-request", "play: unknown e '" + k + "'");
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
  else if (w == "param") {  // INTERFACE-CHANGE(CORE2B): engine.getParam; {path, value} (value absent = undefined)
    const char *path = getStr(r.m, "path");
    const ParamRead pr = readParam(m, path ? path : "");
    if (!pr.known) return fail(e, r, "unknown-param", std::string("Unknown parameter \"") + (path ? path : "") + "\"");
    JsonOut j;
    j.begin().kv("path", path);
    if (pr.defined) j.kvRaw("value", pr.json);
    res = j.end().take();
  }
  reply(e, r, res, "get " + w);
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
  reply(e, r, res, "click " + a);
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
    // CORE2A (PARITY UI row 1): answered when its decodes are done, from the control loop's pump() (the frozen
    // Model::preload pumps in a loop until then, which held up every tick and `play` for 0.5-3 s per cold song).
    // Offline the decodes run inline and the reply goes out before this returns, as before.
    if (auto *cs = dynamic_cast<samples::CacheServiceImpl *>(m.service<CacheService>())) {
      const Req q{nullptr, r.hasId, r.id, r.op};  // r.m dies with this message
      cs->preloadAsync(patches, pin ? pin : "auto", [&e, q](std::string out) { reply(e, q, out, "cache preload"); });
      return;
    }
    res = m.preload(patches, pin ? pin : "auto");
  } else if (a == "estimate") {
    res = m.estimatePreloadMB(patches);
  } else if (a == "retainReverb") {
    if (!needService(e, r, ReverbService::kName)) return;
    res = std::string("{\"ok\":") + (m.retainReverb(patches) ? "true" : "false") + "}";
  } else {
    return fail(e, r, "bad-request", "cache: unknown action " + a);
  }
  reply(e, r, res, "cache " + a);
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
  if (yyjson_val *v = yyjson_obj_get(r.m, "polyphony"); v && yyjson_is_num(v)) {  // T00c D1 (schema: 32|64|128)
    m.setPolyphony(static_cast<unsigned>(yyjson_get_num(v)));
    j.kv("polyphony", m.polyphony());
  }
  if (yyjson_val *v = yyjson_obj_get(r.m, "voiceLimit"); v && !yyjson_is_null(v)) {  // D4 (schema: auto|128..|0)
    m.setVoiceLimit(yyjson_is_str(v) ? Model::kVoiceLimitAuto : static_cast<int>(yyjson_get_num(v)));
    m.voiceLimitJson(j);
  }
  if (yyjson_val *v = yyjson_obj_get(r.m, "droneFreeze"); v && yyjson_is_bool(v)) {  // D5 (T16): default true
    bool now = false;
    if (drone::setDroneFreeze(m, yyjson_get_bool(v), &now)) j.kvBool("droneFreeze", now);
  }
  // INTERFACE-CHANGE(UIB): settings.dynamicRange (T12 O1; audio.js setDynamicRange): Model clamps to 1..3 (rounded to
  // 0.01; non-finite -> 1), stores it for samplers attached later and echoes the range in force
  if (yyjson_val *v = yyjson_obj_get(r.m, "dynamicRange"); v && yyjson_is_num(v))
    j.kv("dynamicRange", m.setDynamicRange(yyjson_get_num(v)));
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
  reply(e, r, res, "rec " + a);
}

void opMidi(Engine &e, const Req &r) {
  if (!needService(e, r, MidiService::kName)) return;
  reply(e, r, e.model().midiOp(r.m), "midi");
}

}  // namespace

void Bridge::dispatch(const Req &r) {
  if (r.op == "hello") {
    helloDone_ = helloDone_ || getNum(r.m, "protocol", 0) == RIG_BRIDGE_PROTOCOL;
    return opHello(e_, r);
  }
  if (r.op == "audio")
    opAudio(e_, *this, r);
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
  else if (r.op == "__throw" && (e_.config().flags & RIG_FLAG_TEST_API))
    throw std::runtime_error("test");
  else
    fail(e_, r, "unknown-op", "unknown op '" + r.op + "'");
}

bool Bridge::handle(const char *json, std::size_t len) {
  yyjson_doc *doc = yyjson_read(json, len, 0);
  if (!doc) return false;
  Bridge *const saved = g_current;
  g_current = this;
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
    const bridge::OpSpec *spec = bridge::findOp(r.op.c_str());
    if (r.op != "hello" && !helloDone_) return fail(e_, r, "protocol", "hello must be the first message");
    const bool testThrow = r.op == "__throw" && (e_.config().flags & RIG_FLAG_TEST_API);  // `internal` test hook
    if (!spec && !testThrow) return fail(e_, r, "unknown-op", "unknown op '" + r.op + "'");
    std::string err;
    if (spec && !bridge::validate(*spec, m, &err)) return fail(e_, r, "bad-request", err);
    try {
      dispatch(r);
    } catch (const std::exception &x) {  // a handler bug must not kill the control thread: `internal`
      fail(e_, r, "internal", "op '" + r.op + "' failed: " + x.what());
    } catch (...) {
      fail(e_, r, "internal", "op '" + r.op + "' failed");
    }
  };
  if (yyjson_is_arr(root)) {
    std::size_t i, n;
    yyjson_val *it;
    yyjson_arr_foreach(root, i, n, it) one(it);
  } else if (yyjson_is_obj(root)) {
    one(root);
  } else {
    yyjson_doc_free(doc);
    g_current = saved;
    return false;
  }
  yyjson_doc_free(doc);
  g_current = saved;
  return true;
}

}  // namespace rig
