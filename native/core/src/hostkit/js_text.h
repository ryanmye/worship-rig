// JavaScript string semantics on UTF-8 bytes, for the patch-pack scanner (lane N1). server.js works on JS strings
// (UTF-16); hostkit keeps WTF-8 (UTF-8 that may also hold a lone surrogate as its 3-byte form, which only a JSON
// "\udXXX" escape or a UTF-16 slice can produce) and reproduces what the scanner uses: Node's UTF-8 decoding,
// `.length`, `.slice(0, n)`, `.trim()`, and `localeCompare(b, undefined, {numeric: true, sensitivity: 'base'})`.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace rig::hostkit {

/** Node's `buffer.toString('utf8')` (WHATWG decode): each maximal invalid subpart becomes U+FFFD; a BOM is kept. */
std::string decodeUtf8(std::string_view bytes);

/** Next code point of WTF-8 text at `i` (advances `i`); surrogates come back as themselves. */
std::uint32_t nextCodePoint(std::string_view s, std::size_t &i);

/** Append a code point (surrogates included) as WTF-8. */
void appendCodePoint(std::string &out, std::uint32_t cp);

/** `s.length` (UTF-16 code units). */
std::size_t jsLength(std::string_view s);

/** `s.slice(0, n)`: may cut a surrogate pair, leaving a lone high surrogate (as JS does). */
std::string jsSliceStart(std::string_view s, std::size_t n);

/** `s.trim()` (ECMAScript WhiteSpace and LineTerminator, U+FEFF included). */
std::string jsTrim(std::string_view s);

/**
 * `a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'})` in Node's ICU root collation, modelled at the
 * primary level by a generated table (collation_table.inc, tools/hostkit/gen-collation.mjs): -1, 0 or 1.
 */
int jsLocaleCompare(std::string_view a, std::string_view b);

}  // namespace rig::hostkit
