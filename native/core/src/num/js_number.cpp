#include "num/js_number.h"

#include <charconv>
#include <cmath>
#include <cstring>

namespace rig::js {

std::size_t numberToString(double x, char *buf) {
  char *o = buf;
  if (std::isnan(x)) {
    std::memcpy(o, "NaN", 3);
    return 3;
  }
  if (x == 0) {  // +0 and -0
    *o = '0';
    return 1;
  }
  if (x < 0) {
    *o++ = '-';
    x = -x;
  }
  if (std::isinf(x)) {
    std::memcpy(o, "Infinity", 8);
    return static_cast<std::size_t>(o - buf) + 8;
  }
  // Shortest round-trip digits in scientific form: d[.ddd]e[+-]xx
  char sci[32];
  const auto res = std::to_chars(sci, sci + sizeof sci, x, std::chars_format::scientific);
  char digits[20];
  int k = 0;  // number of significant digits
  const char *p = sci;
  for (; p < res.ptr && *p != 'e'; ++p)
    if (*p != '.') digits[k++] = *p;
  int e10 = 0;  // exponent of the first digit
  {
    ++p;  // 'e'
    const bool neg = *p == '-';
    ++p;
    for (; p < res.ptr; ++p) e10 = e10 * 10 + (*p - '0');
    if (neg) e10 = -e10;
  }
  const int n = e10 + 1;  // ECMA-262: s × 10^(n−k) = x with k digits
  if (k <= n && n <= 21) {
    std::memcpy(o, digits, static_cast<std::size_t>(k));
    o += k;
    for (int i = 0; i < n - k; ++i) *o++ = '0';
  } else if (0 < n && n <= 21) {
    std::memcpy(o, digits, static_cast<std::size_t>(n));
    o += n;
    *o++ = '.';
    std::memcpy(o, digits + n, static_cast<std::size_t>(k - n));
    o += k - n;
  } else if (-6 < n && n <= 0) {
    *o++ = '0';
    *o++ = '.';
    for (int i = 0; i < -n; ++i) *o++ = '0';
    std::memcpy(o, digits, static_cast<std::size_t>(k));
    o += k;
  } else {
    *o++ = digits[0];
    if (k > 1) {
      *o++ = '.';
      std::memcpy(o, digits + 1, static_cast<std::size_t>(k - 1));
      o += k - 1;
    }
    *o++ = 'e';
    int ex = n - 1;
    *o++ = ex < 0 ? '-' : '+';
    if (ex < 0) ex = -ex;
    char tmp[8];
    int t = 0;
    do {
      tmp[t++] = static_cast<char>('0' + ex % 10);
      ex /= 10;
    } while (ex);
    while (t) *o++ = tmp[--t];
  }
  return static_cast<std::size_t>(o - buf);
}

std::string numberToString(double x) {
  char buf[kNumberToStringMax];
  return std::string(buf, numberToString(x, buf));
}

}  // namespace rig::js
