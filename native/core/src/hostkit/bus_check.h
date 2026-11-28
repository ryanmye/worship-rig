// Bus v1 message checks (remote lane, D45): app/js/shared/bus.js stateError / commandError over a parsed value, for
// rig_bus.h and the remote service (which checks states before it reads them). See rig_bus.h for the contract.
#pragma once
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include "js_json.h"

namespace rig::hostkit {

/** bus.js stateError(m): nullopt when valid, else the first problem in bus.js's words. */
std::optional<std::string> busStateError(const JVal &m);

/** bus.js commandError(m): nullopt when valid, else the first problem in bus.js's words. */
std::optional<std::string> busCommandError(const JVal &m);

/**
 * Cap + JSON.parse + the check. On success `out` (if given) receives the parsed value.
 * `maxUnits`: RIG_BUS_STATE_MAX or RIG_BUS_COMMAND_MAX.
 */
std::optional<std::string> busCheckText(std::string_view bytes, std::size_t maxUnits, bool isState, JVal *out = nullptr);

/** Number of code points as JS `[...s].length` counts them (a lone surrogate counts as one). */
std::size_t jsCodePointCount(std::string_view wtf8);

}  // namespace rig::hostkit
