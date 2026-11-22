// Ports of drone.js staticVoicing / followVoicing / loopRegion and shared/keydetect.js (T16).
#include "drone/drone_voicing.h"

#include <algorithm>
#include <climits>
#include <cmath>
#include <set>

#include "model/perform.h"  // chordName (shared/chords.js, T14)

namespace rig::drone {

int mod12(double n) {
  const double r = std::round(n);  // Math.round of an integer-valued note: exact
  const long long k = static_cast<long long>(r);
  return static_cast<int>(((k % 12) + 12) % 12);
}

const char *keyName(int pc, bool minor) {
  static const char *const kMajor[12] = {"C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"};
  static const char *const kMinor[12] = {"Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"};
  return minor ? kMinor[mod12(pc)] : kMajor[mod12(pc)];
}

std::vector<int> staticVoicing(int pc, double brightness) {
  const int root = 43 + mod12(pc - 7);
  std::vector<int> notes{root, root + 7, root + 12};
  if (brightness > 0.6) notes.push_back(root + 14);
  return notes;
}

std::optional<FollowVoicing> followVoicing(const std::vector<int> &held, const std::vector<int> &prevUpper) {
  std::vector<int> sorted = held;
  std::sort(sorted.begin(), sorted.end());
  std::vector<int> pcs;  // [...new Set(sorted.map(mod12))]: first occurrence order
  for (int n : sorted) {
    const int p = mod12(n);
    if (std::find(pcs.begin(), pcs.end(), p) == pcs.end()) pcs.push_back(p);
  }
  if (pcs.size() < 2) return std::nullopt;
  const int bassPc = mod12(sorted[0]);
  ChordInfo ch;
  const int root = chordName(pcs, bassPc, false, ch) ? ch.root : bassPc;
  auto prio = [&](int pc) {
    const int iv = mod12(pc - root);
    if (iv == 3 || iv == 4 || iv == 5) return 0;   // 3rd (sus4 stands in for it)
    if (iv == 10 || iv == 11 || iv == 9) return 1;  // 7th (6th stands in)
    if (iv == 7 || iv == 6 || iv == 8) return 2;    // 5th
    if (iv == 2 || iv == 1) return 3;               // 9th
    return 4;                                       // root
  };
  std::vector<int> ranked = pcs;
  std::stable_sort(ranked.begin(), ranked.end(), [&](int a, int b) {
    const int d = prio(a) - prio(b);
    return d != 0 ? d < 0 : a < b;
  });
  std::vector<int> chosen(ranked.begin(), ranked.begin() + static_cast<long>(std::min<std::size_t>(3, ranked.size())));
  std::vector<std::vector<int>> multisets;
  if (chosen.size() >= 3) {
    multisets.push_back(chosen);
  } else {
    for (int d : chosen) {
      std::vector<int> m = chosen;
      m.push_back(d);
      multisets.push_back(m);
    }
  }
  const int bass = 36 + bassPc;
  std::vector<int> prev = prevUpper.size() == 3 ? prevUpper : std::vector<int>{55, 60, 64};
  std::sort(prev.begin(), prev.end());
  auto opts = [](int pc) {
    std::vector<int> o;
    for (int m = 48; m <= 72; ++m)
      if (mod12(m) == pc) o.push_back(m);
    return o;
  };
  bool have = false;
  FollowVoicing best;
  double bestCost = INFINITY;
  for (const auto &ms : multisets) {
    const auto o0 = opts(ms[0]), o1 = opts(ms[1]), o2 = opts(ms[2]);
    for (int a : o0)
      for (int b : o1)
        for (int c : o2) {
          int up[3] = {a, b, c};
          std::sort(up, up + 3);
          if (up[0] == up[1] || up[1] == up[2]) continue;  // no unisons
          double cost = 0;
          for (int i = 0; i < 3; ++i) cost += std::abs(up[i] - prev[static_cast<std::size_t>(i)]);
          const int all[4] = {bass, up[0], up[1], up[2]};
          for (int i = 0; i < 3; ++i)
            if (all[i] < 48 && all[i + 1] - all[i] < 3) cost += 6;
          std::set<int> d;
          for (int x : all) d.insert(mod12(x));
          cost += 3 * (4 - static_cast<double>(d.size()));
          const int sum = up[0] + up[1] + up[2];
          if (cost < bestCost || (cost == bestCost && have && sum < best.upper[0] + best.upper[1] + best.upper[2])) {
            bestCost = cost;
            best.bass = bass;
            std::copy(up, up + 3, best.upper);
            have = true;
          }
        }
  }
  if (!have) return std::nullopt;
  return best;
}

LoopRegion loopRegion(double dur) {
  const double xf = 4;
  LoopRegion r;
  if (!(dur > 3 * xf)) {
    r.loop = true;
    return r;
  }
  r.ls = std::min(8.0, dur * 0.25);
  r.le = dur - std::min(12.0, dur * 0.25);
  r.xf = std::min(xf, (r.le - r.ls) / 3);
  return r;
}

// ---- keydetect.js -------------------------------------------------------------------------------------------------

namespace {

int letterPc(char c) {
  switch (c) {
    case 'C': return 0;
    case 'D': return 2;
    case 'E': return 4;
    case 'F': return 5;
    case 'G': return 7;
    case 'A': return 9;
    case 'B': return 11;
    default: return 0;
  }
}

std::string lower(std::string s) {
  for (char &c : s)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return s;
}

int accidentalOffset(const std::string &acc) {
  if (acc.empty()) return 0;
  const std::string a = lower(acc);
  if (a == "#" || a == "\xE2\x99\xAF" || a == "sharp") return 1;
  return -1;  // b ♭ flat
}

bool isMinorQuality(const std::string &q) {
  return q == "m" || q == "m7" || lower(q).rfind("min", 0) == 0;
}

bool ieq(const std::string &a, const char *b) {
  return lower(a) == b;
}

/** The JS regex /^([A-G])(#|♯|b|♭|sharp|flat)?(maj7|...|m|M)?$/ with its backtracking order: the first accidental
 *  (then none) and quality (then none) that make the whole token match. */
bool singleMatch(const std::string &t, char &letter, std::string &acc, std::string &quality) {
  static const char *const kAcc[] = {"#", "\xE2\x99\xAF", "b", "\xE2\x99\xAD", "sharp", "flat", ""};
  static const char *const kQual[] = {"maj7", "Maj7", "M7",  "min7", "m7",  "minor", "Minor", "major",
                                      "Major", "min", "Min", "maj",  "Maj", "m",     "M",     ""};
  if (t.empty() || t[0] < 'A' || t[0] > 'G') return false;
  const std::string rest = t.substr(1);
  for (const char *a : kAcc) {
    const std::string as(a);
    if (rest.compare(0, as.size(), as) != 0) continue;
    const std::string r2 = rest.substr(as.size());
    for (const char *q : kQual)
      if (r2 == q) {
        letter = t[0];
        acc = as;
        quality = q;
        return true;
      }
  }
  return false;
}

/** /^([A-G])(#|♯|b|♭)?(-?\d)$/ */
bool octaveMatch(const std::string &t, char &letter, std::string &acc) {
  static const char *const kAcc[] = {"#", "\xE2\x99\xAF", "b", "\xE2\x99\xAD", ""};
  if (t.empty() || t[0] < 'A' || t[0] > 'G') return false;
  const std::string rest = t.substr(1);
  for (const char *a : kAcc) {
    const std::string as(a);
    if (rest.compare(0, as.size(), as) != 0) continue;
    std::string r2 = rest.substr(as.size());
    if (!r2.empty() && r2[0] == '-') r2 = r2.substr(1);
    if (r2.size() == 1 && r2[0] >= '0' && r2[0] <= '9') {
      letter = t[0];
      acc = as;
      return true;
    }
  }
  return false;
}

struct KeyExpr {
  int pc = 0;
  bool minor = false, explicit_ = false, bare = false;
  std::size_t len = 1;
  char letter = 'C';
};

std::optional<KeyExpr> parseKeyExpr(const std::vector<std::string> &tok, std::size_t i) {
  if (i >= tok.size()) return std::nullopt;
  char letter = 'C';
  std::string acc, quality;
  if (!singleMatch(tok[i], letter, acc, quality)) return std::nullopt;
  std::size_t len = 1;
  if (acc.empty() && i + len < tok.size() && (ieq(tok[i + len], "flat") || ieq(tok[i + len], "sharp"))) {
    acc = tok[i + len];
    ++len;
  }
  if (quality.empty() && i + len < tok.size() &&
      (ieq(tok[i + len], "minor") || ieq(tok[i + len], "min") || ieq(tok[i + len], "major") ||
       ieq(tok[i + len], "maj"))) {
    quality = tok[i + len];
    ++len;
  }
  KeyExpr k;
  k.letter = letter;
  k.pc = (((letterPc(k.letter) + accidentalOffset(acc)) % 12) + 12) % 12;
  k.explicit_ = !acc.empty() || !quality.empty();
  k.minor = !quality.empty() && isMinorQuality(quality);
  k.bare = !k.explicit_;
  k.len = len;
  return k;
}

}  // namespace

std::vector<std::string> tokenizeName(std::string_view name) {
  std::string base(name);
  const std::size_t slash = base.find_last_of("\\/");
  if (slash != std::string::npos) base = base.substr(slash + 1);
  // .replace(/\.[A-Za-z0-9]{1,5}$/, '')
  const std::size_t dot = base.find_last_of('.');
  if (dot != std::string::npos) {
    const std::size_t n = base.size() - dot - 1;
    bool alnum = n >= 1 && n <= 5;
    for (std::size_t i = dot + 1; alnum && i < base.size(); ++i) {
      const char c = base[i];
      alnum = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    }
    if (alnum) base.resize(dot);
  }
  std::vector<std::string> out;
  std::string cur;
  auto sep = [](char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v' || c == '_' || c == '-' ||
           c == '(' || c == ')' || c == '.' || c == ',' || c == '[' || c == ']';
  };
  for (char c : base) {
    if (sep(c)) {
      if (!cur.empty()) out.push_back(cur);
      cur.clear();
    } else {
      cur += c;
    }
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}

std::optional<DetectedKey> detectKeyFromName(std::string_view name) {
  const std::vector<std::string> tok = tokenizeName(name);
  struct Cand {
    int pc;
    bool minor;
    int score;
    std::size_t pos;
    bool bareA;
  };
  std::vector<Cand> cands, octave;
  for (std::size_t i = 0; i < tok.size();) {
    const std::string lw = lower(tok[i]);
    if (lw == "key" && i + 1 < tok.size() && lower(tok[i + 1]) == "of") {
      if (auto k = parseKeyExpr(tok, i + 2)) {
        cands.push_back({k->pc, k->minor, 3, i, false});
        i += 2 + k->len;
        continue;
      }
    }
    if (lw == "in") {
      if (auto k = parseKeyExpr(tok, i + 1)) {
        cands.push_back({k->pc, k->minor, 3, i, false});
        i += 1 + k->len;
        continue;
      }
    }
    if (auto k = parseKeyExpr(tok, i)) {
      cands.push_back({k->pc, k->minor, k->explicit_ ? 2 : 1, i, k->bare && k->letter == 'A'});
      i += k->len;
      continue;
    }
    char letter = 'C';
    std::string acc;
    if (octaveMatch(tok[i], letter, acc))
      octave.push_back({(((letterPc(letter) + accidentalOffset(acc)) % 12) + 12) % 12, false, 1, i, false});
    ++i;
  }
  long lastPos = -1;
  for (const Cand &c : cands) lastPos = std::max(lastPos, static_cast<long>(c.pos));
  for (const Cand &c : octave) lastPos = std::max(lastPos, static_cast<long>(c.pos));
  std::vector<Cand> counted;
  for (const Cand &c : cands)
    if (!(c.bareA && static_cast<long>(c.pos) != lastPos)) counted.push_back(c);
  const std::vector<Cand> &pool = counted.empty() ? octave : counted;
  if (pool.empty()) return std::nullopt;
  int best = INT_MIN;
  for (const Cand &c : pool) best = std::max(best, c.score);
  const Cand *first = nullptr;
  for (const Cand &c : pool) {
    if (c.score != best) continue;
    if (!first) first = &c;
    else if (c.pc != first->pc || c.minor != first->minor) return std::nullopt;
  }
  return DetectedKey{first->pc, first->minor, best};
}

}  // namespace rig::drone
