// SHA-1 (FIPS 180-4), for the patch-pack hash server.js computes with node:crypto (lane N1). Not for security.
#pragma once
#include <string>
#include <string_view>

namespace rig::hostkit {

/** Lower-case hex SHA-1 of `data` (40 characters). */
std::string sha1Hex(std::string_view data);

}  // namespace rig::hostkit
