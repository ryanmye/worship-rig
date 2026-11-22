// Held-chord readout (T14): ports of app/js/shared/chords.js chordName (templates, tie-break order) and the
// spelling helpers of app/js/shared/music.js (spellingPreference, pcName). Pure functions, control thread.
#include <algorithm>
#include <array>
#include <vector>

#include "model/perform.h"

namespace rig {
namespace {

struct Quality {
  const char *quality;
  std::vector<int> intervals;
  const char *display;
  bool omit5;
};

const std::vector<Quality> &qualities() {
  static const std::vector<Quality> q = {
      {"maj", {0, 4, 7}, "", false},           {"min", {0, 3, 7}, "m", false},
      {"sus2", {0, 2, 7}, "2", false},         {"sus4", {0, 5, 7}, "sus4", false},
      {"5", {0, 7}, "5", false},               {"7", {0, 4, 7, 10}, "7", true},
      {"maj7", {0, 4, 7, 11}, "maj7", true},   {"min7", {0, 3, 7, 10}, "m7", true},
      {"dim", {0, 3, 6}, "dim", false},        {"aug", {0, 4, 8}, "aug", false},
      {"add9", {0, 2, 4, 7}, "add9", false},   {"6", {0, 4, 7, 9}, "6", false},
      {"min6", {0, 3, 7, 9}, "m6", false},     {"9", {0, 2, 4, 7, 10}, "9", true},
      {"maj9", {0, 2, 4, 7, 11}, "maj9", true}, {"min9", {0, 2, 3, 7, 10}, "m9", true},
      {"7sus4", {0, 5, 7, 10}, "7sus4", false}, {"dim7", {0, 3, 6, 9}, "dim7", false},
      {"m7b5", {0, 3, 6, 10}, "m7b5", false},
  };
  return q;
}

struct Pattern {
  const Quality *q;
  int order, mask, nonTriad;
  bool omit5;
};

const std::vector<Pattern> &patterns() {
  static const std::vector<Pattern> p = [] {
    std::vector<Pattern> out;
    const auto &Q = qualities();
    for (std::size_t i = 0; i < Q.size(); ++i) {
      int mask = 0;
      for (int iv : Q[i].intervals) mask |= 1 << iv;
      const int nonTriad = std::max(0, static_cast<int>(Q[i].intervals.size()) - 3);
      out.push_back({&Q[i], static_cast<int>(i), mask, nonTriad, false});
      if (Q[i].omit5) out.push_back({&Q[i], static_cast<int>(i), mask & ~(1 << 7), nonTriad, true});
    }
    return out;
  }();
  return p;
}

int mod12(int n) {
  return ((n % 12) + 12) % 12;
}

const char *pcName(int pc, bool sharp) {
  static const char *const kFlat[12] = {"C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"};
  static const char *const kSharp[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
  return (sharp ? kSharp : kFlat)[mod12(pc)];
}

}  // namespace

bool spellingSharp(int pc, bool minor) {
  // keys whose chord spelling uses sharps: G D A E B F# major; Em Bm F#m C#m G#m minor
  static const std::array<int, 6> kMajor = {7, 2, 9, 4, 11, 6};
  static const std::array<int, 5> kMinor = {4, 11, 6, 1, 8};
  const int p = mod12(pc);
  return minor ? std::find(kMinor.begin(), kMinor.end(), p) != kMinor.end()
               : std::find(kMajor.begin(), kMajor.end(), p) != kMajor.end();
}

bool chordName(const std::vector<int> &pcs, int bassPc, bool sharp, ChordInfo &out) {
  std::vector<int> list;
  for (int pc : pcs) list.push_back(mod12(pc));
  const int bass = bassPc >= 0 ? mod12(bassPc) : -1;
  if (bass >= 0 && std::find(list.begin(), list.end(), bass) == list.end()) list.insert(list.begin(), bass);
  std::vector<int> distinct;
  for (int pc : list)
    if (std::find(distinct.begin(), distinct.end(), pc) == distinct.end()) distinct.push_back(pc);
  if (distinct.empty()) return false;
  const int preferredRoot = bass >= 0 ? bass : list[0];
  if (distinct.size() == 1) {
    out = ChordInfo{pcName(distinct[0], sharp), distinct[0], "note", bass, false};
    return true;
  }
  const Pattern *best = nullptr;
  int bestRoot = 0;
  std::array<int, 4> bestRank{};
  for (int root : distinct) {
    int mask = 0;
    for (int pc : distinct) mask |= 1 << ((pc - root + 12) % 12);
    for (const Pattern &p : patterns()) {
      if (p.mask != mask) continue;
      const std::array<int, 4> rank = {root == preferredRoot ? 0 : 1, p.omit5 ? 1 : 0, p.nonTriad, p.order};
      if (!best || rank < bestRank) {  // lexicographic (chords.js lexLess)
        best = &p;
        bestRoot = root;
        bestRank = rank;
      }
    }
  }
  if (!best) return false;
  std::string name = std::string(pcName(bestRoot, sharp)) + best->q->display;
  if (bass >= 0 && bass != bestRoot) name += std::string("/") + pcName(bass, sharp);
  out = ChordInfo{name, bestRoot, best->q->quality, bass, best->omit5};
  return true;
}

}  // namespace rig
