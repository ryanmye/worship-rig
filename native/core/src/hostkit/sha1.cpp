// SHA-1 (sha1.h): a plain implementation of FIPS 180-4 section 6.1.
#include "sha1.h"

#include <cstdint>

namespace rig::hostkit {

namespace {

inline std::uint32_t rol(std::uint32_t x, int n) {
  return (x << n) | (x >> (32 - n));
}

void block(std::uint32_t h[5], const unsigned char *p) {
  std::uint32_t w[80];
  for (int t = 0; t < 16; ++t) {
    w[t] = (std::uint32_t{p[4 * t]} << 24) | (std::uint32_t{p[4 * t + 1]} << 16) | (std::uint32_t{p[4 * t + 2]} << 8) |
           std::uint32_t{p[4 * t + 3]};
  }
  for (int t = 16; t < 80; ++t) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
  std::uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (int t = 0; t < 80; ++t) {
    std::uint32_t f, k;
    if (t < 20) {
      f = (b & c) | (~b & d);
      k = 0x5A827999u;
    } else if (t < 40) {
      f = b ^ c ^ d;
      k = 0x6ED9EBA1u;
    } else if (t < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8F1BBCDCu;
    } else {
      f = b ^ c ^ d;
      k = 0xCA62C1D6u;
    }
    const std::uint32_t tmp = rol(a, 5) + f + e + k + w[t];
    e = d;
    d = c;
    c = rol(b, 30);
    b = a;
    a = tmp;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
}

}  // namespace

std::string sha1Hex(std::string_view data) {
  std::uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
  const auto *p = reinterpret_cast<const unsigned char *>(data.data());
  std::size_t n = data.size();
  std::size_t off = 0;
  for (; n - off >= 64; off += 64) block(h, p + off);
  unsigned char tail[128] = {};
  const std::size_t rest = n - off;
  for (std::size_t i = 0; i < rest; ++i) tail[i] = p[off + i];
  tail[rest] = 0x80;
  const std::size_t len = rest + 9 <= 64 ? 64 : 128;
  const std::uint64_t bits = static_cast<std::uint64_t>(n) * 8;
  for (int i = 0; i < 8; ++i) tail[len - 1 - static_cast<std::size_t>(i)] = static_cast<unsigned char>(bits >> (8 * i));
  block(h, tail);
  if (len == 128) block(h, tail + 64);
  static const char *hexd = "0123456789abcdef";
  std::string out;
  out.reserve(40);
  for (std::uint32_t v : h) {
    for (int sh = 28; sh >= 0; sh -= 4) out.push_back(hexd[(v >> sh) & 0xF]);
  }
  return out;
}

}  // namespace rig::hostkit
