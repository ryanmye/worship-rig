// Bus v1 message checks (remote lane, D45): a line-for-line port of app/js/shared/bus.js stateError / commandError.
// Keep the order of the checks and the reason strings identical to bus.js (bus-parity.test.mjs compares them).
#include "bus_check.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

#include "js_text.h"
#include "rig/rig_bus.h"

namespace rig::hostkit {
namespace {

constexpr int kBusVersion = 1;
constexpr std::size_t kSceneNameMax = 40;  // bus.js SCENE_NAME_MAX (= shared/scenes.js, D25)

const char *const kCommandTypes[] = {
    "hello",     "selectMode", "nextMode",  "prevMode",  "panic",   "fadeOutAll", "master",   "droneToggle",
    "droneKey",  "lowResource", "openMain", "record",    "nextScene", "prevScene", "nextSong", "prevSong",
};
const char *const kAudioStates[] = {"running", "stalled", "suspended", "asleep"};
const char *const kRemoteVia[] = {"remote"};

// JS predicates over a value that may be `undefined` (nullptr)
bool isObj(const JVal *v) { return v && v->type == JVal::Obj; }
bool isNum(const JVal *v) { return v && v->type == JVal::Num && std::isfinite(v->num); }
bool isStr(const JVal *v) { return v && v->type == JVal::Str; }
bool isBool(const JVal *v) { return v && v->type == JVal::Bool; }
bool isNull(const JVal *v) { return v && v->type == JVal::Null; }
bool isNumOrNull(const JVal *v) { return isNull(v) || isNum(v); }
bool isId(const JVal *v) { return isStr(v) && !v->str.empty(); }
bool isInteger(const JVal *v) { return isNum(v) && std::floor(v->num) == v->num; }
bool isIndex(const JVal *v) { return isInteger(v) && v->num >= 0; }
bool numEq(const JVal *v, double d) { return v && v->type == JVal::Num && v->num == d; }  // m.v === 1

template <std::size_t N>
bool strIn(const JVal *v, const char *const (&list)[N]) {
  if (!isStr(v)) return false;
  for (const char *s : list) {
    if (v->str == s) return true;
  }
  return false;
}

bool isMode(const JVal *m) {
  return isObj(m) && isId(m->get("id")) && isStr(m->get("name")) && isStr(m->get("key")) && isIndex(m->get("index"));
}
bool isCurrent(const JVal *c) {
  return isNull(c) || (isObj(c) && isId(c->get("id")) && isStr(c->get("name")) && isStr(c->get("key")));
}

/** JSON.stringify(v) as a template literal shows it; `undefined` for a missing value. */
std::string stringifyForMessage(const JVal *v) {
  if (!v) return "undefined";
  std::string out;
  jsonStringify(*v, out);
  return out;
}

std::string versionMessage() { return "v must be " + std::to_string(kBusVersion); }

}  // namespace

std::size_t jsCodePointCount(std::string_view s) {
  std::size_t n = 0;
  for (std::size_t i = 0; i < s.size();) {
    nextCodePoint(s, i);
    ++n;
  }
  return n;
}

std::optional<std::string> busStateError(const JVal &root) {
  const JVal *m = &root;
  if (!isObj(m)) return std::string("not an object");
  if (!numEq(m->get("v"), kBusVersion)) return versionMessage();
  if (!isCurrent(m->get("current"))) return std::string("current");
  const JVal *modes = m->get("modes");
  if (!(modes && modes->type == JVal::Arr)) return std::string("modes");
  for (const JVal &x : modes->arr) {
    if (!isMode(&x)) return std::string("modes");
  }
  const JVal *master = m->get("master");
  if (!isNum(master) || master->num < 0 || master->num > 2) return std::string("master");
  if (!isNumOrNull(m->get("masterDb"))) return std::string("masterDb");
  if (!isBool(m->get("droneOn"))) return std::string("droneOn");
  if (!isStr(m->get("droneKey"))) return std::string("droneKey");
  if (!strIn(m->get("audio"), kAudioStates)) return std::string("audio");
  if (!isNum(m->get("latencyMs"))) return std::string("latencyMs");
  const JVal *midi = m->get("midi");
  if (!isObj(midi) || !isBool(midi->get("connected"))
      || !(isNull(midi->get("name")) || isStr(midi->get("name")))) {
    return std::string("midi");
  }
  if (!isBool(m->get("lowResource"))) return std::string("lowResource");
  if (!isBool(m->get("recording"))) return std::string("recording");
  if (!isBool(m->get("windowVisible"))) return std::string("windowVisible");
  if (!isNumOrNull(m->get("memoryMB"))) return std::string("memoryMB");
  const JVal *theme = m->get("theme");
  if (theme && !isId(theme)) return std::string("theme");
  const JVal *scene = m->get("scene");
  if (scene) {
    const JVal *count = isObj(scene) ? scene->get("count") : nullptr;
    const JVal *n = isObj(scene) ? scene->get("n") : nullptr;
    const bool ok = isObj(scene) && isInteger(count) && count->num > 0
                    && (isNull(n) || (isIndex(n) && n->num < count->num));
    if (!ok) return std::string("scene");
    const JVal *name = scene->get("name");
    if (name && !(isStr(name) && jsCodePointCount(name->str) <= kSceneNameMax)) return std::string("scene.name");
  }
  const JVal *locked = m->get("locked");
  if (locked && !isBool(locked)) return std::string("locked");
  return std::nullopt;
}

std::optional<std::string> busCommandError(const JVal &root) {
  const JVal *m = &root;
  if (!isObj(m)) return std::string("not an object");
  if (!numEq(m->get("v"), kBusVersion)) return versionMessage();
  const JVal *type = m->get("type");
  if (!strIn(type, kCommandTypes)) return "unknown type " + stringifyForMessage(type);
  const JVal *via = m->get("via");
  if (via && !strIn(via, kRemoteVia)) return std::string("via");
  const std::string &t = type->str;
  if (t == "selectMode") {
    const JVal *id = m->get("id");
    return isStr(id) && !id->str.empty() ? std::nullopt : std::optional<std::string>("selectMode.id");
  }
  if (t == "master") {
    const JVal *v = m->get("value");
    return isNum(v) && v->num >= 0 && v->num <= 2 ? std::nullopt : std::optional<std::string>("master.value (0..2)");
  }
  if (t == "droneKey") {
    const JVal *pc = m->get("pc");
    return isInteger(pc) && pc->num >= 0 && pc->num <= 11 ? std::nullopt
                                                           : std::optional<std::string>("droneKey.pc (0..11)");
  }
  if (t == "droneToggle") {  // D45: optional absolute `on`
    const JVal *on = m->get("on");
    return !on || isBool(on) ? std::nullopt : std::optional<std::string>("droneToggle.on");
  }
  if (t == "lowResource" || t == "record") {
    return isBool(m->get("on")) ? std::nullopt : std::optional<std::string>(t + ".on");
  }
  return std::nullopt;
}

std::optional<std::string> busCheckText(std::string_view bytes, std::size_t maxUnits, bool isState, JVal *out) {
  // a UTF-16 unit takes at most 3 UTF-8 bytes (a 4-byte sequence is 2 units), so more than 4 bytes per allowed unit
  // can never fit: refuse before decoding (looser than needed; the exact check follows)
  if (bytes.size() > maxUnits * 4) {
    return "too large (" + std::to_string(bytes.size()) + " bytes > " + std::to_string(maxUnits) + ")";
  }
  const std::string text = decodeUtf8(bytes);
  const std::size_t units = jsLength(text);
  if (units > maxUnits) return "too large (" + std::to_string(units) + " > " + std::to_string(maxUnits) + ")";
  // bus messages are a few levels deep; anything deeper than 16 is not a bus message (bounds JVal's recursion)
  ParseResult r = jsonParse(text, 16);
  if (!r.ok) return std::string("not JSON");
  if (r.tooDeep) return std::string("too deep");
  auto err = isState ? busStateError(r.value) : busCommandError(r.value);
  if (!err && out) *out = std::move(r.value);
  return err;
}

}  // namespace rig::hostkit

namespace {
/** 0 valid, 1 invalid (*reason set when asked), -1 internal error (allocation): never throws across the C API. */
int check(const char *json, size_t len, bool isState, char **reason) {
  if (reason) *reason = nullptr;
  try {
    std::optional<std::string> err =
        json ? rig::hostkit::busCheckText(std::string_view(json, len), isState ? RIG_BUS_STATE_MAX : RIG_BUS_COMMAND_MAX,
                                          isState)
             : std::optional<std::string>("not JSON");
    if (!err) return 0;
    if (reason) {
      *reason = static_cast<char *>(std::malloc(err->size() + 1));
      if (!*reason) return -1;
      std::memcpy(*reason, err->c_str(), err->size() + 1);
    }
    return 1;
  } catch (...) {
    return -1;
  }
}
}  // namespace

extern "C" int rig_bus_check_state(const char *json, size_t len, char **reason) {
  return check(json, len, true, reason);
}

extern "C" int rig_bus_check_command(const char *json, size_t len, char **reason) {
  return check(json, len, false, reason);
}
