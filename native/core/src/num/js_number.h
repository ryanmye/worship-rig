// JS Number::toString(10) (ECMA-262 §6.1.6.1.20), i.e. `String(n)` and `${n}` in template literals: shortest
// round-trip digits (std::to_chars, as V8's DoubleToCString shortest mode) laid out with the JS rules (plain decimal
// for 1e-7 < |n| < 1e21, else d.ddde±x). Used for seed strings and cache keys (`${seed}|ir|${bucket}|${dampQ}|${sr}`).
#pragma once
#include <cstddef>
#include <string>

namespace rig::js {

/** Writes String(x) into buf (no terminator), returns the length; buf needs kNumberToStringMax bytes. RT-safe. */
inline constexpr std::size_t kNumberToStringMax = 32;
std::size_t numberToString(double x, char *buf);
/** Convenience (allocates). */
std::string numberToString(double x);

}  // namespace rig::js
