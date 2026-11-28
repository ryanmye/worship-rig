// The patch-pack scanner: a port of server.js scanUserPatches / hasUserPatches and their helpers (listPackDirs,
// packSongFiles, readPackJson, checkPatchEntry, userRefsOf, deeperThan, within), lane N1. Same caps, messages,
// order and output, error texts included (V8's SyntaxError wording, libuv's fs error texts); rig_hostkit.h is its C
// surface. Divergences (the N1 report; test/unit/hostkit/parity.test.mjs measures the rest byte for byte): a FIFO or
// device named pack.json reads as empty (server.js would block on it); names are ordered by a model of ICU (js_text.h
// jsLocaleCompare: exact on realistic names, a few inversions on exotic code points); a file that grows between its
// stat and its read is read up to 16 MB (server.js reads all of it). n1-skeptic F1: this comment said the SyntaxError
// texts were not reproduced; they are (commit 54b7883).
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
