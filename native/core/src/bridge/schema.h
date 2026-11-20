// BRIDGE v1 argument schema (T08): the 14 ops of native/contract/engine-api.json `messages.ops`, one row per argument,
// checked before dispatch (wrong type / missing required field / unknown enum value -> `bad-request`). Unknown fields
// are ignored (contract 6.2). `unit.bridge-conformance` parses engine-api.json and fails when this table and the
// contract disagree (an argument added, removed, made optional or retyped there), then generates one request per
// argument and error case from the contract and checks the replies.
#pragma once
#include <cstddef>
#include <string>

struct yyjson_val;

namespace rig::bridge {

enum class ArgType {
  Any,
  Int,           // integral number
  Number,        // any number
  NumberOrNull,  // tempo: null = none
  NumberOrString,  // latency: 'interactive' | seconds
  String,
  Bool,
  Object,
  Array,
  Enum  // string out of ArgSpec::values ("a|b|c")
};

struct ArgSpec {
  const char *name;
  ArgType type;
  bool required;
  const char *values = nullptr;  // Enum: "a|b|c"; Int: optional allowed set "16|24"
  /** Required by the contract but tolerated when absent (callers that predate validation): hello.app. */
  bool lenient = false;
};

struct OpSpec {
  const char *op;
  const ArgSpec *args;
  std::size_t nargs;
};

/** Per-variant requirements that the contract states in prose (6.4), not in the arg types: e.g. `play on` needs
 *  n and vel. `key` = the discriminating field ("e", "action", "what"), `value` its value, `need` = "n|vel". */
struct VariantSpec {
  const char *op, *key, *value, *need;
};

const OpSpec *findOp(const char *op);
const OpSpec *ops(std::size_t *count);
const VariantSpec *variants(std::size_t *count);
const char *typeName(ArgType t);

/** Validate a message object against its op's spec. False with a message (for `bad-request`). */
bool validate(const OpSpec &spec, yyjson_val *msg, std::string *err);

}  // namespace rig::bridge
