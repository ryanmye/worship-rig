// Minimal JSON text builder for replies and events (control thread only; allocates).
#pragma once
#include <cmath>
#include <cstdio>
#include <string>
#include <string_view>

namespace rig {

class JsonOut {
 public:
  JsonOut &raw(std::string_view s) {
    s_.append(s);
    return *this;
  }
  JsonOut &str(std::string_view v) {
    s_ += '"';
    for (char c : v) {
      switch (c) {
        case '"':
          s_ += "\\\"";
          break;
        case '\\':
          s_ += "\\\\";
          break;
        case '\n':
          s_ += "\\n";
          break;
        case '\r':
          s_ += "\\r";
          break;
        case '\t':
          s_ += "\\t";
          break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) {
            char b[8];
            std::snprintf(b, sizeof b, "\\u%04x", c);
            s_ += b;
          } else {
            s_ += c;
          }
      }
    }
    s_ += '"';
    return *this;
  }
  JsonOut &num(double v) {
    if (!std::isfinite(v)) return raw("null");
    char b[40];
    if (v == std::floor(v) && std::fabs(v) < 1e15)
      std::snprintf(b, sizeof b, "%.0f", v);
    else
      std::snprintf(b, sizeof b, "%.17g", v);
    return raw(b);
  }
  JsonOut &boolean(bool v) { return raw(v ? "true" : "false"); }
  JsonOut &key(std::string_view k) {
    comma();
    str(k);
    s_ += ':';
    needComma_ = false;
    return *this;
  }
  JsonOut &begin() {
    comma();
    s_ += '{';
    needComma_ = false;
    return *this;
  }
  JsonOut &end() {
    s_ += '}';
    needComma_ = true;
    return *this;
  }
  JsonOut &beginArray() {
    comma();
    s_ += '[';
    needComma_ = false;
    return *this;
  }
  JsonOut &endArray() {
    s_ += ']';
    needComma_ = true;
    return *this;
  }
  // key/value helpers
  JsonOut &kv(std::string_view k, double v) {
    key(k);
    num(v);
    needComma_ = true;
    return *this;
  }
  JsonOut &kv(std::string_view k, std::string_view v) {
    key(k);
    str(v);
    needComma_ = true;
    return *this;
  }
  JsonOut &kvBool(std::string_view k, bool v) {
    key(k);
    boolean(v);
    needComma_ = true;
    return *this;
  }
  JsonOut &kvRaw(std::string_view k, std::string_view v) {
    key(k);
    raw(v);
    needComma_ = true;
    return *this;
  }
  /** Array element helpers. */
  JsonOut &elem(double v) {
    comma();
    num(v);
    needComma_ = true;
    return *this;
  }
  JsonOut &elemStr(std::string_view v) {
    comma();
    str(v);
    needComma_ = true;
    return *this;
  }
  JsonOut &elemBool(bool v) {
    comma();
    boolean(v);
    needComma_ = true;
    return *this;
  }
  std::string take() { return std::move(s_); }
  const std::string &view() const { return s_; }

 private:
  void comma() {
    if (needComma_) s_ += ',';
    needComma_ = false;
  }
  std::string s_;
  bool needComma_ = false;
};

}  // namespace rig
