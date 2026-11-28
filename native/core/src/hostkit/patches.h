// The patch-pack scanner: a port of server.js scanUserPatches / hasUserPatches and their helpers (listPackDirs,
// packSongFiles, readPackJson, checkPatchEntry, userRefsOf, deeperThan, within), lane N1. Same caps, messages,
// order and output; rig_hostkit.h is its C surface. Divergences (documented in the N1 report, measured by
// test/unit/hostkit/parity.test.mjs): the text inside "not valid JSON (...)" and a bad pack.json's message are
// hostkit's own wording (V8's SyntaxError texts are not reproduced); a FIFO or device named pack.json reads as empty
// (server.js would block on it); names are ordered by a model of ICU (js_text.h jsLocaleCompare).
#pragma once
#include <string>
#include <unordered_set>
#include <vector>

namespace rig::hostkit {

// server.js:76-88
inline constexpr std::size_t kUserPacksMax = 500;
inline constexpr long long kFileMaxBytes = 1024 * 1024;
inline constexpr std::size_t kFilesMax = 200;
inline constexpr std::size_t kSongsPerFileMax = 100;
inline constexpr std::size_t kSongsMax = 2000;
inline constexpr long long kTotalMaxBytes = 8 * 1024 * 1024;
inline constexpr int kMaxDepth = 64;
inline constexpr std::size_t kMaxSlots = 16;
inline constexpr long long kPackJsonMaxBytes = 64 * 1024;
inline constexpr std::size_t kSlugMax = 200;
inline constexpr std::size_t kFileNameMax = 245;

struct ScanOptions {
  bool checkUserIds = false;                // server.js `userIds` given (not null)
  std::unordered_set<std::string> userIds;  // the `user:<id>` refs My Samples has
};

/** `path.resolve(p)` (POSIX): absolute against the working directory, normalised, no trailing '/'. */
std::string jsPathResolve(const std::string &p);
/** `path.join(a, b)` (POSIX). */
std::string jsPathJoin(const std::string &a, const std::string &b);

/** JSON.stringify(await scanUserPatches(roots, {userIds})) */
std::string scanUserPatchesJson(const std::vector<std::string> &roots, const ScanOptions &o);

/** await hasUserPatches(roots) */
bool hasUserPatches(const std::vector<std::string> &roots);

}  // namespace rig::hostkit
