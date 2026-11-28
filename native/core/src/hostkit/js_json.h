// JSON.parse / JSON.stringify as V8 does them, for the patch-pack scanner (lane N1). The pack hash is sha1 of
// `JSON.stringify([schema, song, bank])` over what `JSON.parse` read, so hostkit reproduces both exactly:
//   - the ECMA-404 grammar JSON.parse accepts (no BOM, no comments, no trailing commas, lone "\udXXX" escapes ok);
//   - JS object semantics: a repeated key keeps its first position and its last value; array-index keys
//     ("0".."4294967294", canonical) come first in ascending order, then the other keys in insertion order;
//   - numbers are doubles (correctly rounded, through yyjson's reader; out of range = +-Infinity), written as
//     Number.prototype.toString does (shortest round trip, 1e+21, 1e-7, -0 as 0, non-finite as null);
//   - strings: control characters as \b \t \n \f \r or \u00xx, lone surrogates as \udxxx (well-formed stringify).
// yyjson alone is not enough: it rejects lone surrogate escapes and keeps raw number text (DECISIONS: N1 report).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace rig::hostkit {

struct JMember;

/** A JSON value with JS semantics. Strings are WTF-8 (js_text.h). */
struct JVal {
  enum Type : std::uint8_t { Null, Bool, Num, Str, Arr, Obj };
  Type type = Null;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<JVal> arr;
  std::vector<JMember> obj;  // in JS property order (a vector of an incomplete type: fine since C++17)

  bool isPlainObj() const { return type == Obj; }
  /** Own property, or nullptr (JS `undefined`). */
  const JVal *get(std::string_view key) const;
};

/** One property of an object. */
struct JMember {
  std::string first;
  JVal second;
};

struct ParseResult {
  bool ok = false;
  bool tooDeep = false;  // valid JSON nested deeper than `maxDepth` (server.js deeperThan): such containers are
                         // null in `value`, the rest is built
  JVal value;
  std::string error;  // SyntaxError text (V8's wording for the common cases; the position always)
};

/**
 * JSON.parse of `text` (already decoded: WTF-8 without invalid bytes, decodeUtf8). Containers nested more than
 * `maxDepth` levels below the root (deeperThan(v, maxDepth)) set `tooDeep`; the rest of the text is still checked
 * (iteratively: any depth is fine). JVal and jsonStringify recurse, so the built tree is bounded by `maxDepth`.
 */
ParseResult jsonParse(std::string_view text, int maxDepth = 512);

/** JSON.stringify(v) appended to `out`. */
void jsonStringify(const JVal &v, std::string &out);
/** JSON.stringify of a string. */
void jsonQuote(std::string_view s, std::string &out);
/** Number.prototype.toString() (JSON.stringify writes "null" for a non-finite number instead). */
std::string jsNumberToString(double d);

}  // namespace rig::hostkit
