// hashSeed (shared/prng.js): FNV-1a over the string's UTF-16 code units, `Math.imul(h, 0x01000193)`, `>>> 0`.
// The std::string_view overload treats each byte as one code unit, which equals JS for ASCII (every engine seed
// string is ASCII: numbers, '|', ids). The rest of the PRNG is in num/prng.h.
#pragma once
#include <cstdint>
#include <string_view>

namespace rig {

inline std::uint32_t hashSeed(std::string_view s) {
  std::uint32_t h = 0x811c9dc5u;
  for (unsigned char c : s) {
    h ^= c;
    h *= 0x01000193u;
  }
  return h;
}

/** Exact JS semantics for any string (UTF-16 code units, as charCodeAt returns them). */
inline std::uint32_t hashSeed(std::u16string_view s) {
  std::uint32_t h = 0x811c9dc5u;
  for (char16_t c : s) {
    h ^= static_cast<std::uint32_t>(c);
    h *= 0x01000193u;
  }
  return h;
}

}  // namespace rig
