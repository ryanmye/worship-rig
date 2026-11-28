// JSON.parse / JSON.stringify with V8's semantics (js_json.h).
#include "js_json.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <unordered_map>

#include "js_text.h"
#include "yyjson.h"

namespace rig::hostkit {

const JVal *JVal::get(std::string_view key) const {
  if (type != Obj) return nullptr;
  for (const auto &kv : obj) {
    if (kv.first == key) return &kv.second;
  }
  return nullptr;
}

namespace {

/** "0".."4294967294" in canonical form: a JS array index, which property order puts first (ascending). */
bool arrayIndex(const std::string &k, std::uint32_t *out) {
  if (k.empty() || k.size() > 10) return false;
  if (k.size() > 1 && k[0] == '0') return false;
  std::uint64_t v = 0;
  for (char c : k) {
    if (c < '0' || c > '9') return false;
    v = v * 10 + static_cast<std::uint64_t>(c - '0');
  }
  if (v > 4294967294ull) return false;
  *out = static_cast<std::uint32_t>(v);
  return true;
}

/** An object under construction: JS [[Set]] semantics for repeated keys. */
struct ObjBuilder {
  JVal v;
  std::unique_ptr<std::unordered_map<std::string, std::size_t>> index;  // built past 8 keys

  void put(std::string &&key, JVal &&val) {
    if (!index && v.obj.size() >= 8) {
      index = std::make_unique<std::unordered_map<std::string, std::size_t>>();
      for (std::size_t i = 0; i < v.obj.size(); ++i) index->emplace(v.obj[i].first, i);
    }
    if (index) {
      auto it = index->find(key);
      if (it != index->end()) {
        v.obj[it->second].second = std::move(val);
        return;
      }
      index->emplace(key, v.obj.size());
    } else {
      for (auto &kv : v.obj) {
        if (kv.first == key) {
          kv.second = std::move(val);
          return;
        }
      }
    }
    v.obj.push_back(JMember{std::move(key), std::move(val)});
  }

  JVal finish() {
    bool any = false;
    for (const auto &kv : v.obj) {
      std::uint32_t n;
      if (arrayIndex(kv.first, &n)) {
        any = true;
        break;
      }
    }
    if (any) {  // array-index keys first, ascending; the others keep their insertion order
      std::vector<std::pair<std::uint32_t, std::size_t>> idx;
      std::vector<JMember> out;
      for (std::size_t i = 0; i < v.obj.size(); ++i) {
        std::uint32_t n;
        if (arrayIndex(v.obj[i].first, &n)) idx.emplace_back(n, i);
      }
      std::sort(idx.begin(), idx.end());
      out.reserve(v.obj.size());
      std::vector<bool> taken(v.obj.size(), false);
      for (const auto &p : idx) {
        out.push_back(std::move(v.obj[p.second]));
        taken[p.second] = true;
      }
      for (std::size_t i = 0; i < v.obj.size(); ++i) {
        if (!taken[i]) out.push_back(std::move(v.obj[i]));
      }
      v.obj = std::move(out);
    }
    return std::move(v);
  }
};

struct Frame {
  bool isObj = false;
  ObjBuilder ob;  // isObj
  JVal arr;       // !isObj
  std::string key;
};

class Parser {
 public:
  Parser(std::string_view s, int maxDepth) : s_(s), maxDepth_(maxDepth) {
    yyjson_alc_pool_init(&alc_, pool_, sizeof pool_);
  }

  ParseResult run() {
    ParseResult r;
    if (!parse(r.value)) {
      r.error = err_;
      return r;
    }
    r.ok = true;
    r.tooDeep = tooDeep_;
    return r;
  }

 private:
  std::string_view s_;
  std::size_t i_ = 0;
  int maxDepth_;
  bool tooDeep_ = false;
  std::ptrdiff_t skipFrom_ = -1;  // >= 0: inside a container opened at this depth, too deep to build (a null)
  std::string err_;
  std::vector<char> kinds_;    // '{' / '[' for every open container (the grammar)
  std::vector<Frame> frames_;  // the containers being built
  yyjson_alc alc_{};
  alignas(16) char pool_[1024];

  bool fail(const std::string &what) {
    err_ = what;
    return false;
  }
  bool failEnd() { return fail("Unexpected end of JSON input"); }
  /** V8's positioned messages: "<what> in JSON at position <p> (line <l> column <c>)", in UTF-16 units. */
  bool failAt(const char *what, const char *in = " in JSON") {
    const std::u16string u = utf16(s_.substr(0, i_));
    std::size_t line = 1, last = 0;  // V8 CalculateFileLocation: \r, \n and \r\n end a line
    for (std::size_t k = 0; k < u.size(); ++k) {
      if (u[k] == '\r' && k + 1 < u.size() && u[k + 1] == '\n') ++k;
      if (u[k] == '\r' || u[k] == '\n') {
        ++line;
        last = k + 1;
      }
    }
    return fail(std::string(what) + in + " at position " + std::to_string(u.size()) + " (line " + std::to_string(line) +
                " column " + std::to_string(u.size() - last + 1) + ")");
  }
  /** V8's unexpected-token message: the UTF-16 unit at the cursor and up to 10 units of context each side. */
  bool failToken() {
    if (i_ >= s_.size()) return failEnd();
    const char c = s_[i_];  // V8 names the token the character starts (one_char_json_tokens)
    if (c == '"') return failAt("Unexpected string");
    if (c == '-' || (c >= '0' && c <= '9')) return failAt("Unexpected number");
    if (s_ == "NaN" || s_ == "Infinity" || s_ == "undefined" || s_ == "[object Object]") {
      return fail("\"" + std::string(s_) + "\" is not valid JSON");  // V8 IsSpecialString
    }
    const std::u16string u = utf16(s_);
    const std::size_t pos = utf16(s_.substr(0, i_)).size();
    const std::string tok = wtf8(u.substr(pos, 1));
    constexpr std::size_t kCtx = 10;
    std::string head = "Unexpected token '" + tok + "', ";
    if (u.size() < 2 * kCtx + 1) return fail(head + "\"" + std::string(s_) + "\" is not valid JSON");
    if (pos < kCtx) return fail(head + "\"" + wtf8(u.substr(0, pos + kCtx)) + "\"... is not valid JSON");
    if (pos < u.size() - kCtx) {
      return fail(head + "...\"" + wtf8(u.substr(pos - kCtx, 2 * kCtx)) + "\"... is not valid JSON");
    }
    return fail(head + "...\"" + wtf8(u.substr(pos - kCtx)) + "\" is not valid JSON");
  }
  static std::u16string utf16(std::string_view w) {
    std::u16string u;
    for (std::size_t k = 0; k < w.size();) {
      const std::uint32_t cp = nextCodePoint(w, k);
      if (cp >= 0x10000) {
        u.push_back(static_cast<char16_t>(0xD800 + ((cp - 0x10000) >> 10)));
        u.push_back(static_cast<char16_t>(0xDC00 + ((cp - 0x10000) & 0x3FF)));
      } else {
        u.push_back(static_cast<char16_t>(cp));
      }
    }
    return u;
  }
  static std::string wtf8(const std::u16string &u) {
    std::string out;
    for (std::size_t k = 0; k < u.size(); ++k) {
      std::uint32_t c = u[k];
      if (c >= 0xD800 && c <= 0xDBFF && k + 1 < u.size() && u[k + 1] >= 0xDC00 && u[k + 1] <= 0xDFFF) {
        c = 0x10000 + ((c - 0xD800) << 10) + (u[k + 1] - 0xDC00u);
        ++k;
      }
      appendCodePoint(out, c);
    }
    return out;
  }
  void ws() {
    while (i_ < s_.size()) {
      const char c = s_[i_];
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
      ++i_;
    }
  }
  bool building() const { return skipFrom_ < 0; }

  static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }
  bool hex4(std::size_t at, std::uint32_t *out) const {
    if (at + 4 > s_.size()) return false;
    std::uint32_t v = 0;
    for (std::size_t k = 0; k < 4; ++k) {
      const int h = hex(s_[at + k]);
      if (h < 0) return false;
      v = v * 16 + static_cast<std::uint32_t>(h);
    }
    *out = v;
    return true;
  }

  /** A string at s_[i_] == '"'. */
  bool str(std::string *out) {
    ++i_;
    for (;;) {
      if (i_ >= s_.size()) return failAt("Unterminated string");
      const unsigned char c = static_cast<unsigned char>(s_[i_]);
      if (c == '"') {
        ++i_;
        return true;
      }
      if (c < 0x20) return failAt("Bad control character in string literal");
      if (c != '\\') {
        const std::size_t b = i_;
        while (i_ < s_.size() && s_[i_] != '"' && s_[i_] != '\\' && static_cast<unsigned char>(s_[i_]) >= 0x20) ++i_;
        if (out) out->append(s_.substr(b, i_ - b));
        continue;
      }
      if (i_ + 1 >= s_.size()) return failEnd();
      const char e = s_[i_ + 1];
      char lit = 0;
      switch (e) {
        case '"':
          lit = '"';
          break;
        case '\\':
          lit = '\\';
          break;
        case '/':
          lit = '/';
          break;
        case 'b':
          lit = '\b';
          break;
        case 'f':
          lit = '\f';
          break;
        case 'n':
          lit = '\n';
          break;
        case 'r':
          lit = '\r';
          break;
        case 't':
          lit = '\t';
          break;
        case 'u':
          break;
        default: {
          ++i_;
          std::size_t j = i_;  // V8: an escaped character past Latin-1 is an unexpected token, not a bad escape
          if (nextCodePoint(s_, j) > 0xFF) return failToken();
          return failAt("Bad escaped character");
        }
      }
      if (lit) {
        if (out) out->push_back(lit);
        i_ += 2;
        continue;
      }
      std::uint32_t u;
      if (!hex4(i_ + 2, &u)) {  // V8 points at the first character that is not a hex digit (or the end)
        i_ += 2;
        while (i_ < s_.size() && hex(s_[i_]) >= 0) ++i_;
        return failAt("Bad Unicode escape");
      }
      i_ += 6;
      if (u >= 0xD800 && u <= 0xDBFF && i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
        std::uint32_t lo;
        if (hex4(i_ + 2, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {  // a pair: one code point
          i_ += 6;
          if (out) appendCodePoint(*out, 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00));
          continue;
        }
      }
      if (out) appendCodePoint(*out, u);  // a lone surrogate stays (WTF-8)
    }
  }

  bool num(double *out) {
    const std::size_t b = i_;
    bool simple = true;
    if (s_[i_] == '-') ++i_;
    if (i_ >= s_.size()) return failAt("No number after minus sign");
    if (s_[i_] == '0') {
      ++i_;
      if (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') return failAt("Unexpected number");
    } else if (s_[i_] >= '1' && s_[i_] <= '9') {
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
    } else {
      return failAt("No number after minus sign");
    }
    if (i_ < s_.size() && s_[i_] == '.') {
      simple = false;
      ++i_;
      if (i_ >= s_.size() || s_[i_] < '0' || s_[i_] > '9') return failAt("Unterminated fractional number");
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
    }
    if (i_ < s_.size() && (s_[i_] == 'e' || s_[i_] == 'E')) {
      simple = false;
      ++i_;
      if (i_ < s_.size() && (s_[i_] == '+' || s_[i_] == '-')) ++i_;
      if (i_ >= s_.size() || s_[i_] < '0' || s_[i_] > '9') return failAt("Exponent part is missing a number");
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
    }
    const std::string_view tok = s_.substr(b, i_ - b);
    const bool neg = tok[0] == '-';
    if (simple && tok.size() - (neg ? 1 : 0) <= 15) {  // exact in a double
      double v = 0;
      for (char c : tok.substr(neg ? 1 : 0)) v = v * 10 + (c - '0');
      *out = neg ? -v : v;
      return true;
    }
    // yyjson's reader is correctly rounded; the grammar is checked above, so a failure here is an overflow
    yyjson_read_err e;
    yyjson_doc *d = yyjson_read_opts(const_cast<char *>(tok.data()), tok.size(), 0, &alc_, &e);
    if (!d && e.code == YYJSON_READ_ERROR_MEMORY_ALLOCATION) {  // a long token: past the stack pool
      d = yyjson_read_opts(const_cast<char *>(tok.data()), tok.size(), 0, nullptr, &e);
    }
    if (!d && e.code == YYJSON_READ_ERROR_MEMORY_ALLOCATION) return fail("out of memory");
    if (!d) {
      *out = neg ? -std::numeric_limits<double>::infinity() : std::numeric_limits<double>::infinity();
      return true;
    }
    yyjson_val *v = yyjson_doc_get_root(d);
    if (yyjson_is_uint(v)) {
      *out = static_cast<double>(yyjson_get_uint(v));
    } else if (yyjson_is_sint(v)) {
      *out = static_cast<double>(yyjson_get_sint(v));
    } else {
      *out = yyjson_get_real(v);
    }
    if (neg && *out == 0) *out = -0.0;
    yyjson_doc_free(d);
    return true;
  }

  bool literal(const char *word, std::size_t n) {
    for (std::size_t k = 0; k < n; ++k, ++i_) {
      if (i_ >= s_.size() || s_[i_] != word[k]) return failToken();  // the end of input: "Unexpected end"
    }
    return true;
  }

  /** Attach a finished value to the open container (or make it the root). */
  void attach(JVal &&v, JVal &root) {
    if (!building()) return;
    if (frames_.empty()) {
      root = std::move(v);
      return;
    }
    Frame &f = frames_.back();
    if (f.isObj) {
      f.ob.put(std::move(f.key), std::move(v));
      f.key.clear();
    } else {
      f.arr.arr.push_back(std::move(v));
    }
  }

  bool key() {
    std::string k;
    if (!str(building() ? &k : nullptr)) return false;
    if (building()) frames_.back().key = std::move(k);
    ws();
    if (i_ >= s_.size() || s_[i_] != ':') {
      return failAt("Expected ':' after property name");
    }
    ++i_;
    return true;
  }

  void open(bool obj) {
    if (building() && static_cast<int>(kinds_.size()) >= maxDepth_) {  // deeperThan: a container at depth >= max
      tooDeep_ = true;
      skipFrom_ = static_cast<std::ptrdiff_t>(kinds_.size());
    }
    kinds_.push_back(obj ? '{' : '[');
    if (building()) {
      frames_.emplace_back();
      frames_.back().isObj = obj;
      if (!obj) frames_.back().arr.type = JVal::Arr;
      if (obj) frames_.back().ob.v.type = JVal::Obj;
    }
  }

  /** Close the innermost container: its value (a null in place of a container too deep to build). */
  JVal close() {
    kinds_.pop_back();
    if (!building()) {
      if (static_cast<std::ptrdiff_t>(kinds_.size()) == skipFrom_) skipFrom_ = -1;
      return JVal{};
    }
    Frame f = std::move(frames_.back());
    frames_.pop_back();
    return f.isObj ? f.ob.finish() : std::move(f.arr);
  }

  bool parse(JVal &root) {
    ws();
    for (;;) {
      // ---- a value
      ws();
      if (i_ >= s_.size()) return failEnd();
      JVal v;
      const char c = s_[i_];
      if (c == '{' || c == '[') {
        ++i_;
        open(c == '{');
        ws();
        const char end = c == '{' ? '}' : ']';
        if (i_ < s_.size() && s_[i_] == end) {
          ++i_;
          v = close();
        } else {
          if (c == '{') {
            if (i_ >= s_.size() || s_[i_] != '"') return failAt("Expected property name or '}'");
            if (!key()) return false;
          }
          continue;  // the first member's value
        }
      } else if (c == '"') {
        v.type = JVal::Str;
        if (!str(building() ? &v.str : nullptr)) return false;
      } else if (c == '-' || (c >= '0' && c <= '9')) {
        v.type = JVal::Num;
        if (!num(&v.num)) return false;
      } else if (c == 't') {
        if (!literal("true", 4)) return false;
        v.type = JVal::Bool;
        v.b = true;
      } else if (c == 'f') {
        if (!literal("false", 5)) return false;
        v.type = JVal::Bool;
      } else if (c == 'n') {
        if (!literal("null", 4)) return false;
      } else {
        return failToken();
      }
      // ---- after a value: attach it, then a separator or the end of its container(s)
      for (;;) {
        attach(std::move(v), root);
        ws();
        if (kinds_.empty()) {
          if (i_ < s_.size()) return failAt("Unexpected non-whitespace character after JSON", "");
          return true;
        }
        const bool obj = kinds_.back() == '{';
        const char d = i_ < s_.size() ? s_[i_] : '\0';
        if (d == ',') {
          ++i_;
          if (obj) {
            ws();
            if (i_ >= s_.size() || s_[i_] != '"') return failAt("Expected double-quoted property name");
            if (!key()) return false;
          }
          break;  // the next value
        }
        if (d == (obj ? '}' : ']')) {
          ++i_;
          v = close();
          continue;
        }
        return failAt(obj ? "Expected ',' or '}' after property value" : "Expected ',' or ']' after array element");
      }
    }
  }
};

}  // namespace

ParseResult jsonParse(std::string_view text, int maxDepth) {
  return Parser(text, maxDepth).run();
}

std::string jsNumberToString(double d) {
  if (std::isnan(d)) return "NaN";
  if (d == 0) return "0";
  if (std::isinf(d)) return d < 0 ? "-Infinity" : "Infinity";
  std::string out;
  if (d < 0) {
    out.push_back('-');
    d = -d;
  }
  char buf[64];
  const auto r = std::to_chars(buf, buf + sizeof buf, d, std::chars_format::scientific);  // shortest round trip
  const std::string_view sci(buf, static_cast<std::size_t>(r.ptr - buf));
  const std::size_t e = sci.find('e');
  std::string digits;
  for (char c : sci.substr(0, e)) {
    if (c != '.') digits.push_back(c);
  }
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  int exp10 = 0;
  std::from_chars(sci.data() + e + (sci[e + 1] == '+' ? 2 : 1), sci.data() + sci.size(), exp10);
  const int k = static_cast<int>(digits.size());
  const int n = exp10 + 1;  // value = 0.digits * 10^n
  if (k <= n && n <= 21) {
    out += digits;
    out.append(static_cast<std::size_t>(n - k), '0');
  } else if (0 < n && n <= 21) {
    out += digits.substr(0, static_cast<std::size_t>(n));
    out.push_back('.');
    out += digits.substr(static_cast<std::size_t>(n));
  } else if (-6 < n && n <= 0) {
    out += "0.";
    out.append(static_cast<std::size_t>(-n), '0');
    out += digits;
  } else {
    out.push_back(digits[0]);
    if (k > 1) {
      out.push_back('.');
      out += digits.substr(1);
    }
    out.push_back('e');
    out.push_back(n - 1 < 0 ? '-' : '+');
    out += std::to_string(n - 1 < 0 ? 1 - n : n - 1);
  }
  return out;
}

void jsonQuote(std::string_view s, std::string &out) {
  static const char *hexd = "0123456789abcdef";
  out.push_back('"');
  for (std::size_t i = 0; i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    if (c >= 0x20 && c != '"' && c != '\\' && c != 0xED) {
      out.push_back(static_cast<char>(c));
      ++i;
      continue;
    }
    if (c == 0xED) {  // U+D000..U+DFFF: a surrogate (only lone ones exist in WTF-8) is escaped
      std::size_t j = i;
      const std::uint32_t cp = nextCodePoint(s, j);
      if (cp >= 0xD800 && cp <= 0xDFFF) {
        out += "\\u";
        for (int sh = 12; sh >= 0; sh -= 4) out.push_back(hexd[(cp >> sh) & 0xF]);
      } else {
        out.append(s.substr(i, j - i));
      }
      i = j;
      continue;
    }
    ++i;
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += "\\u00";
        out.push_back(hexd[c >> 4]);
        out.push_back(hexd[c & 0xF]);
    }
  }
  out.push_back('"');
}

void jsonStringify(const JVal &v, std::string &out) {
  switch (v.type) {
    case JVal::Null:
      out += "null";
      return;
    case JVal::Bool:
      out += v.b ? "true" : "false";
      return;
    case JVal::Num:
      out += std::isfinite(v.num) ? jsNumberToString(v.num) : "null";
      return;
    case JVal::Str:
      jsonQuote(v.str, out);
      return;
    case JVal::Arr:
      out.push_back('[');
      for (std::size_t i = 0; i < v.arr.size(); ++i) {
        if (i) out.push_back(',');
        jsonStringify(v.arr[i], out);
      }
      out.push_back(']');
      return;
    case JVal::Obj:
      out.push_back('{');
      for (std::size_t i = 0; i < v.obj.size(); ++i) {
        if (i) out.push_back(',');
        jsonQuote(v.obj[i].first, out);
        out.push_back(':');
        jsonStringify(v.obj[i].second, out);
      }
      out.push_back('}');
      return;
  }
}

}  // namespace rig::hostkit
