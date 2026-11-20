// BRIDGE v1 argument schema (T08). Mirrors native/contract/engine-api.json `messages.ops` (checked by
// tests/test_bridge_conformance.cpp).
#include "bridge/schema.h"

#include <cmath>
#include <cstring>
#include <string_view>

#include "yyjson.h"

namespace rig::bridge {
namespace {

using T = ArgType;

constexpr ArgSpec kHello[] = {{"protocol", T::Int, true}, {"app", T::String, true, nullptr, true},
                              {"caps", T::Array, false}};
constexpr ArgSpec kAudio[] = {{"action", T::Enum, true, "start|restart|output|sleep|wake"},
                              {"latency", T::NumberOrString, false},
                              {"deviceId", T::String, false},
                              {"ramp", T::Number, false},
                              {"bufferFrames", T::Int, false, "64|128|256|512"}};  // T00c D2
constexpr ArgSpec kPrepare[] = {{"patch", T::Object, true}};
constexpr ArgSpec kCommit[] = {{"token", T::Int, true}, {"when", T::Number, false}};
constexpr ArgSpec kCache[] = {{"action", T::Enum, true, "preload|estimate|retainReverb"},
                              {"patches", T::Array, true},
                              {"pin", T::Enum, false, "add|replace|none|auto"}};
constexpr ArgSpec kSet[] = {{"path", T::String, false}, {"value", T::Any, false}, {"glide", T::Number, false},
                            {"when", T::Number, false},  {"batch", T::Array, false}};
constexpr ArgSpec kSong[] = {{"transpose", T::Int, false},       {"routing", T::Object, false},
                             {"tempo", T::NumberOrNull, false},  {"timeSig", T::String, false},
                             {"newBar", T::Bool, false},         {"key", T::Object, false},
                             {"when", T::Number, false}};
constexpr ArgSpec kDrone[] = {{"key", T::Object, false},
                              {"config", T::Object, false},
                              {"files", T::Array, false},
                              {"when", T::Number, false}};
constexpr ArgSpec kPlay[] = {{"e", T::Enum, true, "on|off|pedal|wheel|bend|swell|panic|fade|input"},
                             {"n", T::Int, false},
                             {"vel", T::Int, false},
                             {"touch", T::Any, false},
                             {"down", T::Bool, false},
                             {"src", T::Enum, false, "mod|expr|vol|virtual"},
                             {"value", T::Number, false},
                             {"glide", T::Number, false},
                             {"x", T::Number, false},
                             {"start", T::Bool, false},
                             {"seconds", T::Number, false},
                             {"when", T::Number, false}};
constexpr ArgSpec kClick[] = {{"action", T::Enum, true, "start|stop|config"},
                              {"countIn", T::Int, false},
                              {"quietAfter", T::Bool, false},
                              {"level", T::Number, false},
                              {"record", T::Bool, false},
                              {"output", T::Enum, false, "main|aux"},
                              {"when", T::Number, false}};
constexpr ArgSpec kConfig[] = {{"mono", T::Bool, false},        {"lowResource", T::Bool, false},
                               {"eqAudition", T::Object, false}, {"meters", T::Object, false},
                               {"midiClock", T::Object, false},  {"when", T::Number, false},
                               {"polyphony", T::Int, false, "32|64|128"},  // T00c D1
                               {"voiceLimit", T::Enum, false, "auto|128|256|512|0"}};  // D4
constexpr ArgSpec kGet[] = {{"what", T::Enum, true, "instruments|stats|devices|sampleStatus|state"},
                            {"reload", T::Bool, false},
                            {"patches", T::Array, false}};
constexpr ArgSpec kMidi[] = {{"action", T::Enum, true, "listen|route|send"},
                             {"ids", T::Array, false},
                             {"on", T::Bool, false},
                             {"learn", T::Object, false},
                             {"pedalInvert", T::Bool, false},
                             {"velocitySens", T::Any, false},
                             {"touch", T::Object, false},
                             {"jitterFree", T::Bool, false},
                             {"port", T::String, false},
                             {"data", T::Array, false},
                             {"when", T::Number, false}};
constexpr ArgSpec kRec[] = {{"action", T::Enum, true, "start|stop"},
                            {"dir", T::String, false},
                            {"filename", T::String, false},
                            {"bits", T::Int, false, "16|24"}};

#define RIG_OP(name, arr) {name, arr, sizeof(arr) / sizeof(arr[0])}
constexpr OpSpec kOps[] = {RIG_OP("hello", kHello),   RIG_OP("audio", kAudio),   RIG_OP("prepare", kPrepare),
                           RIG_OP("commit", kCommit), RIG_OP("cache", kCache),   RIG_OP("set", kSet),
                           RIG_OP("song", kSong),     RIG_OP("drone", kDrone),   RIG_OP("play", kPlay),
                           RIG_OP("click", kClick),   RIG_OP("config", kConfig), RIG_OP("get", kGet),
                           RIG_OP("midi", kMidi),     RIG_OP("rec", kRec)};
#undef RIG_OP

constexpr VariantSpec kVariants[] = {{"play", "e", "on", "n|vel"},
                                     {"play", "e", "off", "n"},
                                     {"play", "e", "pedal", "down"},
                                     {"play", "e", "wheel", "src|value"},
                                     {"play", "e", "bend", "x"},
                                     {"get", "what", "sampleStatus", "patches"},
                                     {"midi", "action", "listen", "ids"},
                                     {"midi", "action", "send", "port|data"}};

bool inList(std::string_view list, std::string_view v) {
  while (!list.empty()) {
    const std::size_t bar = list.find('|');
    if (list.substr(0, bar) == v) return true;
    if (bar == std::string_view::npos) break;
    list.remove_prefix(bar + 1);
  }
  return false;
}

bool typeOk(const ArgSpec &a, yyjson_val *v) {
  switch (a.type) {
    case T::Any:
      return true;
    case T::Int: {
      if (!yyjson_is_num(v)) return false;
      const double d = yyjson_get_num(v);
      if (!std::isfinite(d) || d != std::floor(d)) return false;
      if (!a.values) return true;
      const std::string s = std::to_string(static_cast<long long>(d));
      return inList(a.values, s);
    }
    case T::Number:
      return yyjson_is_num(v) && std::isfinite(yyjson_get_num(v));
    case T::NumberOrNull:
      return yyjson_is_null(v) || (yyjson_is_num(v) && std::isfinite(yyjson_get_num(v)));
    case T::NumberOrString:
      return yyjson_is_str(v) || (yyjson_is_num(v) && std::isfinite(yyjson_get_num(v)));
    case T::String:
      return yyjson_is_str(v);
    case T::Bool:
      return yyjson_is_bool(v);
    case T::Object:
      return yyjson_is_obj(v);
    case T::Array:
      return yyjson_is_arr(v);
    case T::Enum:  // D4: an integral number also matches a numeric member ("auto|128|...|0")
      if (yyjson_is_num(v)) {
        const double d = yyjson_get_num(v);
        return std::isfinite(d) && d == std::floor(d) && inList(a.values, std::to_string(static_cast<long long>(d)));
      }
      if (!yyjson_is_str(v)) return false;
      if (std::string_view(yyjson_get_str(v)).find_first_not_of("0123456789") == std::string_view::npos)
        return false;  // "128" as a string is not the number 128
      return inList(a.values, yyjson_get_str(v));
  }
  return false;
}

}  // namespace

const char *typeName(ArgType t) {
  switch (t) {
    case T::Any: return "any";
    case T::Int: return "an integer";
    case T::Number: return "a number";
    case T::NumberOrNull: return "a number or null";
    case T::NumberOrString: return "a number or a string";
    case T::String: return "a string";
    case T::Bool: return "a boolean";
    case T::Object: return "an object";
    case T::Array: return "an array";
    case T::Enum: return "one of";
  }
  return "?";
}

const OpSpec *findOp(const char *op) {
  for (const OpSpec &s : kOps)
    if (std::strcmp(s.op, op) == 0) return &s;
  return nullptr;
}

const OpSpec *ops(std::size_t *count) {
  *count = sizeof(kOps) / sizeof(kOps[0]);
  return kOps;
}

const VariantSpec *variants(std::size_t *count) {
  *count = sizeof(kVariants) / sizeof(kVariants[0]);
  return kVariants;
}

bool validate(const OpSpec &spec, yyjson_val *msg, std::string *err) {
  for (std::size_t i = 0; i < spec.nargs; ++i) {
    const ArgSpec &a = spec.args[i];
    yyjson_val *v = yyjson_obj_get(msg, a.name);
    // null = absent for optional fields (`when: null` = now, contract 6.3); tempo: null is a value
    if (!v || (yyjson_is_null(v) && a.type != T::NumberOrNull && !a.required)) {
      if (a.required && !a.lenient) {
        *err = std::string(spec.op) + ": '" + a.name + "' is required";
        return false;
      }
      continue;
    }
    if (!typeOk(a, v)) {
      *err = std::string(spec.op) + ": '" + a.name + "' must be " + typeName(a.type);
      if (a.values) *err += std::string(" ") + a.values;
      return false;
    }
  }
  for (const VariantSpec &vs : kVariants) {
    if (std::strcmp(vs.op, spec.op) != 0) continue;
    yyjson_val *k = yyjson_obj_get(msg, vs.key);
    if (!k || !yyjson_is_str(k) || std::strcmp(yyjson_get_str(k), vs.value) != 0) continue;
    std::string_view need = vs.need;
    while (!need.empty()) {
      const std::size_t bar = need.find('|');
      const std::string f(need.substr(0, bar));
      yyjson_val *v = yyjson_obj_get(msg, f.c_str());
      if (!v || yyjson_is_null(v)) {
        *err = std::string(spec.op) + " " + vs.value + ": '" + f + "' is required";
        return false;
      }
      if (bar == std::string_view::npos) break;
      need.remove_prefix(bar + 1);
    }
  }
  return true;
}

}  // namespace rig::bridge
