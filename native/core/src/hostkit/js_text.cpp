// JavaScript string semantics on UTF-8 (js_text.h).
#include "js_text.h"

#include <algorithm>
#include <vector>

namespace rig::hostkit {

namespace {

struct CollExp {
  std::uint32_t cp;
  std::uint32_t to[3];
};
struct CollDigits {
  std::uint32_t first, last, value;
};
#include "collation_table.inc"

constexpr std::size_t kRunCount = sizeof kRuns / sizeof kRuns[0] / 2;

/** Primary rank of one code point (0 = ignorable); code points outside the table sort after it, by code point. */
std::uint32_t rankOf(std::uint32_t cp) {
  std::size_t lo = 0, hi = kRunCount;
  while (lo < hi) {  // first run whose start is > cp
    const std::size_t mid = (lo + hi) / 2;
    if ((kRuns[2 * mid] >> 11) <= cp) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0) {
    const std::uint32_t w0 = kRuns[2 * (lo - 1)], w1 = kRuns[2 * (lo - 1) + 1];
    const std::uint32_t first = w0 >> 11, last = first + (w0 & 0x7ff);
    if (cp <= last) return (w1 & 0x7fffffffu) + ((w1 >> 31) ? cp - first : 0);
  }
  return kMaxRank + 1 + cp;
}

const CollExp *expansionOf(std::uint32_t cp) {
  const CollExp *end = kExpansions + sizeof kExpansions / sizeof kExpansions[0];
  const CollExp *it =
      std::lower_bound(kExpansions, end, cp, [](const CollExp &e, std::uint32_t c) { return e.cp < c; });
  return it != end && it->cp == cp ? it : nullptr;
}

int digitOf(std::uint32_t cp) {
  for (const CollDigits &d : kDigits) {
    if (cp >= d.first && cp <= d.last) return static_cast<int>(d.value + (cp - d.first));
  }
  return -1;
}

/** One primary collation element: a rank, or a number (its decimal digits without leading zeros). */
struct Elem {
  std::uint32_t rank = 0;
  bool number = false;
  std::string digits;
};

void pushRank(std::vector<Elem> &out, std::uint32_t r) {
  if (r == 0) return;
  if (r >= kDigitRank && r <= kDigitRank + 9) {  // a non-Nd code point that ICU weighs as a digit: a one-digit number
    Elem e;
    e.number = true;
    if (r != kDigitRank) e.digits.push_back(static_cast<char>('0' + (r - kDigitRank)));
    out.push_back(std::move(e));
    return;
  }
  Elem e;
  e.rank = r;
  out.push_back(std::move(e));
}

std::vector<Elem> elements(std::string_view s) {
  std::vector<Elem> out;
  std::size_t i = 0;
  while (i < s.size()) {
    const std::uint32_t cp = nextCodePoint(s, i);
    const int d = digitOf(cp);
    if (d >= 0) {  // numeric: true: a run of digits is one number
      Elem e;
      e.number = true;
      if (d != 0) e.digits.push_back(static_cast<char>('0' + d));
      while (i < s.size()) {
        std::size_t j = i;
        const int dn = digitOf(nextCodePoint(s, j));
        if (dn < 0) break;
        i = j;
        if (dn != 0 || !e.digits.empty()) e.digits.push_back(static_cast<char>('0' + dn));
      }
      out.push_back(std::move(e));
      continue;
    }
    if (cp >= 0xAC00 && cp <= 0xD7A3) {  // Hangul syllable: ICU weighs its jamo
      const std::uint32_t si = cp - 0xAC00;
      pushRank(out, rankOf(0x1100 + si / 588));
      pushRank(out, rankOf(0x1161 + (si % 588) / 28));
      if (si % 28) pushRank(out, rankOf(0x11A7 + si % 28));
      continue;
    }
    if (const CollExp *x = expansionOf(cp)) {
      for (std::uint32_t c : x->to) {
        if (c) pushRank(out, rankOf(c));
      }
      continue;
    }
    pushRank(out, rankOf(cp));
  }
  return out;
}

int cmpElem(const Elem &a, const Elem &b) {
  if (a.number && b.number) {
    if (a.digits.size() != b.digits.size()) return a.digits.size() < b.digits.size() ? -1 : 1;
    const int c = a.digits.compare(b.digits);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  }
  // numbers sit where the digits sort (kDigitRank): before letters, after punctuation and symbols
  const std::uint32_t ra = a.number ? kDigitRank : a.rank;
  const std::uint32_t rb = b.number ? kDigitRank : b.rank;
  if (ra != rb) return ra < rb ? -1 : 1;
  return 0;
}

bool isJsSpace(std::uint32_t c) {
  switch (c) {
    case 0x09:
    case 0x0A:
    case 0x0B:
    case 0x0C:
    case 0x0D:
    case 0x20:
    case 0xA0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202F:
    case 0x205F:
    case 0x3000:
    case 0xFEFF:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200A;
  }
}

}  // namespace

std::string decodeUtf8(std::string_view in) {
  std::string out;
  out.reserve(in.size());
  std::uint32_t cp = 0;
  int needed = 0, seen = 0;
  unsigned lower = 0x80, upper = 0xBF;
  std::size_t start = 0;  // first byte of the sequence in progress
  for (std::size_t i = 0; i < in.size(); ++i) {
    const unsigned b = static_cast<unsigned char>(in[i]);
    if (needed == 0) {
      if (b <= 0x7F) {
        out.push_back(static_cast<char>(b));
      } else if (b >= 0xC2 && b <= 0xDF) {
        needed = 1;
        cp = b & 0x1F;
      } else if (b >= 0xE0 && b <= 0xEF) {
        if (b == 0xE0) lower = 0xA0;
        if (b == 0xED) upper = 0x9F;
        needed = 2;
        cp = b & 0xF;
      } else if (b >= 0xF0 && b <= 0xF4) {
        if (b == 0xF0) lower = 0x90;
        if (b == 0xF4) upper = 0x8F;
        needed = 3;
        cp = b & 0x7;
      } else {
        appendCodePoint(out, 0xFFFD);
      }
      start = i;
      continue;
    }
    if (b < lower || b > upper) {  // the maximal subpart so far is one U+FFFD; this byte starts over
      cp = 0;
      needed = seen = 0;
      lower = 0x80;
      upper = 0xBF;
      appendCodePoint(out, 0xFFFD);
      --i;
      continue;
    }
    lower = 0x80;
    upper = 0xBF;
    cp = (cp << 6) | (b & 0x3F);
    if (++seen == needed) {
      out.append(in.substr(start, i - start + 1));  // valid: copy the bytes as they are
      cp = 0;
      needed = seen = 0;
    }
  }
  if (needed) appendCodePoint(out, 0xFFFD);
  return out;
}

std::uint32_t nextCodePoint(std::string_view s, std::size_t &i) {
  const unsigned b0 = static_cast<unsigned char>(s[i]);
  int n = b0 < 0x80 ? 0 : b0 >= 0xF0 ? 3 : b0 >= 0xE0 ? 2 : b0 >= 0xC0 ? 1 : 0;
  std::uint32_t cp = n == 0 ? b0 : n == 1 ? (b0 & 0x1F) : n == 2 ? (b0 & 0x0F) : (b0 & 0x07);
  ++i;
  for (; n > 0 && i < s.size(); --n, ++i) cp = (cp << 6) | (static_cast<unsigned char>(s[i]) & 0x3F);
  return cp;
}

void appendCodePoint(std::string &out, std::uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

std::size_t jsLength(std::string_view s) {
  std::size_t n = 0;
  for (std::size_t i = 0; i < s.size();) n += nextCodePoint(s, i) >= 0x10000 ? 2 : 1;
  return n;
}

std::string jsSliceStart(std::string_view s, std::size_t n) {
  std::string out;
  std::size_t units = 0;
  for (std::size_t i = 0; i < s.size() && units < n;) {
    const std::size_t at = i;
    const std::uint32_t cp = nextCodePoint(s, i);
    if (cp >= 0x10000) {
      if (units + 2 > n) {  // cut inside the pair: keep its high surrogate
        appendCodePoint(out, 0xD800 + ((cp - 0x10000) >> 10));
        return out;
      }
      units += 2;
    } else {
      units += 1;
    }
    out.append(s.substr(at, i - at));
  }
  return out;
}

std::string jsTrim(std::string_view s) {
  std::size_t b = 0, e = s.size();
  while (b < e) {
    std::size_t j = b;
    if (!isJsSpace(nextCodePoint(s, j))) break;
    b = j;
  }
  while (e > b) {
    std::size_t k = e - 1;  // back up to the start of the last code point
    while (k > b && (static_cast<unsigned char>(s[k]) & 0xC0) == 0x80) --k;
    std::size_t j = k;
    if (!isJsSpace(nextCodePoint(s, j))) break;
    e = k;
  }
  return std::string(s.substr(b, e - b));
}

int jsLocaleCompare(std::string_view a, std::string_view b) {
  const std::vector<Elem> ea = elements(a), eb = elements(b);
  const std::size_t n = std::min(ea.size(), eb.size());
  for (std::size_t i = 0; i < n; ++i) {
    const int c = cmpElem(ea[i], eb[i]);
    if (c) return c;
  }
  return ea.size() == eb.size() ? 0 : ea.size() < eb.size() ? -1 : 1;
}

}  // namespace rig::hostkit
