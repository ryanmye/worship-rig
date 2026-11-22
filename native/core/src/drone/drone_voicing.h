// Pure pieces of the drone (T16): drone.js staticVoicing / followVoicing / Drone.loopRegion / _fileFor,
// shared/keydetect.js detectKeyFromName and the music.js helpers they use. Control thread (allocates).
#pragma once
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rig::drone {

/** music.js mod12: ((round(n) % 12) + 12) % 12. */
int mod12(double n);
inline int relativeMajor(int pc) { return (mod12(pc) + 3) % 12; }
inline int relativeMinor(int pc) { return (mod12(pc) + 9) % 12; }
/** music.js keyName: 'C', 'Db', ... / 'Cm', 'C#m', ... */
const char *keyName(int pc, bool minor);

/** staticVoicing(pc, brightness): root in G2..F#3, [root, root+7, root+12] (+ root+14 when brightness > .6). */
std::vector<int> staticVoicing(int pc, double brightness);

struct FollowVoicing {
  int bass = 0;
  int upper[3] = {0, 0, 0};
};
/** followVoicing(held, prevUpper): nullopt when held has fewer than 2 pitch classes. `prevUpper` empty or 3 notes. */
std::optional<FollowVoicing> followVoicing(const std::vector<int> &held, const std::vector<int> &prevUpper);

/** Drone.loopRegion(dur): loop = the whole file (dur <= 12 s), else [ls, le) with an xf-second crossfade. */
struct LoopRegion {
  bool loop = false;
  double ls = 0, le = 0, xf = 0;
};
LoopRegion loopRegion(double dur);

struct DetectedKey {
  int pc = 0;
  bool minor = false;
  int confidence = 0;
};
/** keydetect.js tokenize(name). */
std::vector<std::string> tokenizeName(std::string_view name);
/** keydetect.js detectKeyFromName(name) (UTF-8 names; '♯' / '♭' accepted as in JS). */
std::optional<DetectedKey> detectKeyFromName(std::string_view name);

}  // namespace rig::drone
