// hashSeed (FNV-1a, shared/prng.js) over ASCII/UTF-8 bytes; all engine seeds are ASCII. T01 owns the rest of num/.
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

}  // namespace rig
