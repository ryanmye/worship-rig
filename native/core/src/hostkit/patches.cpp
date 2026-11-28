// Patch-pack scanner (patches.h): server.js:433-705, line for line where it matters. POSIX file calls only (macOS,
// iPadOS, Linux); every message is server.js's text, Node's fs error texts included ("ENOENT: no such file or
// directory, realpath '<path>'": libuv's uv_strerror table).
#include "patches.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <optional>

#include "js_json.h"
#include "js_text.h"
#include "sha1.h"

namespace rig::hostkit {

namespace {

// ---- paths (node:path, POSIX) -------------------------------------------------------------------------------------

std::string normalizeString(const std::string &p, bool allowAboveRoot) {
  std::vector<std::string> segs;
  std::size_t i = 0;
  while (i <= p.size()) {
    std::size_t j = p.find('/', i);
    if (j == std::string::npos) j = p.size();
    const std::string seg = p.substr(i, j - i);
    if (seg.empty() || seg == ".") {
      // skip
    } else if (seg == "..") {
      if (!segs.empty() && segs.back() != "..") {
        segs.pop_back();
      } else if (allowAboveRoot) {
        segs.push_back(seg);
      }
    } else {
      segs.push_back(seg);
    }
    i = j + 1;
  }
  std::string out;
  for (std::size_t k = 0; k < segs.size(); ++k) {
    if (k) out.push_back('/');
    out += segs[k];
  }
  return out;
}

std::string jsPathNormalize(const std::string &p) {
  if (p.empty()) return ".";
  const bool abs = p[0] == '/';
  const bool trailing = p.back() == '/';
  std::string s = normalizeString(p, !abs);
  if (s.empty()) return abs ? "/" : trailing ? "./" : ".";
  if (trailing) s.push_back('/');
  return abs ? "/" + s : s;
}

std::string join3(const std::string &a, const std::string &b, const std::string &c) {
  return jsPathJoin(jsPathJoin(a, b), c);
}

/** server.js within(): `real` is `rootReal` or inside it. */
bool within(const std::string &rootReal, const std::string &real) {
  if (real == rootReal) return true;
  const std::string pre = !rootReal.empty() && rootReal.back() == '/' ? rootReal : rootReal + "/";
  return real.compare(0, pre.size(), pre) == 0;
}

// ---- fs calls with Node's error texts ------------------------------------------------------------------------------

struct FsError {
  std::string message;
  bool enoent = false;
};

struct UvErr {
  int code;
  const char *name, *text;
};
// libuv uv-common.c UV_ERRNO_MAP (the texts Node's fs errors carry)
const UvErr kUvErrors[] = {
    {EACCES, "EACCES", "permission denied"},
    {EAGAIN, "EAGAIN", "resource temporarily unavailable"},
    {EBADF, "EBADF", "bad file descriptor"},
    {EBUSY, "EBUSY", "resource busy or locked"},
    {EFAULT, "EFAULT", "bad address in system call argument"},
    {EFBIG, "EFBIG", "file too large"},
    {EINTR, "EINTR", "interrupted system call"},
    {EINVAL, "EINVAL", "invalid argument"},
    {EIO, "EIO", "i/o error"},
    {EISDIR, "EISDIR", "illegal operation on a directory"},
    {ELOOP, "ELOOP", "too many symbolic links encountered"},
    {EMFILE, "EMFILE", "too many open files"},
    {ENAMETOOLONG, "ENAMETOOLONG", "name too long"},
    {ENFILE, "ENFILE", "file table overflow"},
    {ENODEV, "ENODEV", "no such device"},
    {ENOENT, "ENOENT", "no such file or directory"},
    {ENOMEM, "ENOMEM", "not enough memory"},
    {ENOTDIR, "ENOTDIR", "not a directory"},
    {ENXIO, "ENXIO", "no such device or address"},
    {EOVERFLOW, "EOVERFLOW", "value too large for defined data type"},
    {EPERM, "EPERM", "operation not permitted"},
    {ETIMEDOUT, "ETIMEDOUT", "connection timed out"},
};

FsError fsError(int e, const char *syscall, const std::string *path) {
  FsError f;
  f.enoent = e == ENOENT;
  const char *name = "UNKNOWN", *text = "unknown error";
  for (const UvErr &u : kUvErrors) {
    if (u.code == e) {
      name = u.name;
      text = u.text;
    }
  }
  f.message = std::string(name) + ": " + text + ", " + syscall;
  if (path) f.message += " '" + *path + "'";
  return f;
}

bool fsRealpath(const std::string &p, std::string *out, FsError *err) {
  char *r = ::realpath(p.c_str(), nullptr);
  if (!r) {
    if (err) *err = fsError(errno, "realpath", &p);
    return false;
  }
  *out = r;
  std::free(r);
  return true;
}

bool fsStat(const std::string &p, struct stat *st, FsError *err) {
  if (::stat(p.c_str(), st) != 0) {
    if (err) *err = fsError(errno, "stat", &p);
    return false;
  }
  return true;
}

/** fsp.readFile(p, 'utf8'): the bytes, decoded as Node does. O_NONBLOCK: a FIFO reads as empty instead of blocking. */
bool fsReadText(const std::string &p, std::string *out, FsError *err) {
  const int fd = ::open(p.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) {
    if (err) *err = fsError(errno, "open", &p);
    return false;
  }
  std::string bytes;
  char buf[65536];
  for (;;) {
    const ssize_t n = ::read(fd, buf, sizeof buf);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) break;
      const int e = errno;
      ::close(fd);
      if (err) *err = fsError(e, "read", nullptr);
      return false;
    }
    if (n == 0) break;
    bytes.append(buf, static_cast<std::size_t>(n));
    if (bytes.size() > static_cast<std::size_t>(2 * kTotalMaxBytes)) break;  // a device: stop (the caps are far below)
  }
  ::close(fd);
  *out = decodeUtf8(bytes);
  return true;
}

struct Dirent {
  std::string name;  // decoded (Node's readdir gives UTF-8 strings)
  bool isDir = false, isFile = false, isLink = false;
};

/** fsp.readdir(dir, {withFileTypes: true}): libuv's scandir order (strcmp of the raw names), '.' and '..' left out. */
bool fsReaddir(const std::string &dir, std::vector<Dirent> *out) {
  DIR *d = ::opendir(dir.c_str());
  if (!d) return false;
  std::vector<std::pair<std::string, unsigned char>> raw;
  while (struct dirent *e = ::readdir(d)) {
    if (std::strcmp(e->d_name, ".") == 0 || std::strcmp(e->d_name, "..") == 0) continue;
    raw.emplace_back(e->d_name, e->d_type);
  }
  ::closedir(d);
  std::sort(raw.begin(), raw.end(),
            [](const auto &a, const auto &b) { return std::strcmp(a.first.c_str(), b.first.c_str()) < 0; });
  for (auto &r : raw) {
    Dirent x;
    unsigned char t = r.second;
    if (t == DT_UNKNOWN) {  // Node lstat()s entries the file system did not type
      struct stat st;
      const std::string p = dir + "/" + r.first;
      if (::lstat(p.c_str(), &st) == 0) {
        t = S_ISDIR(st.st_mode) ? DT_DIR : S_ISREG(st.st_mode) ? DT_REG : S_ISLNK(st.st_mode) ? DT_LNK : DT_UNKNOWN;
      }
    }
    x.isDir = t == DT_DIR;
    x.isFile = t == DT_REG;
    x.isLink = t == DT_LNK;
    x.name = decodeUtf8(r.first);
    out->push_back(std::move(x));
  }
  return true;
}

/** `entries.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))` (stable). */
template <class T, class Key>
void localeSort(std::vector<T> &v, Key key) {
  std::stable_sort(v.begin(), v.end(), [&](const T &a, const T &b) { return jsLocaleCompare(key(a), key(b)) < 0; });
}

double mtimeMs(const struct stat &st) {
#if defined(__APPLE__)
  const double sec = static_cast<double>(st.st_mtimespec.tv_sec), nsec = static_cast<double>(st.st_mtimespec.tv_nsec);
#else
  const double sec = static_cast<double>(st.st_mtim.tv_sec), nsec = static_cast<double>(st.st_mtim.tv_nsec);
#endif
  return sec * 1e3 + nsec / 1e6;  // Node's msFromTimeSpec
}

double jsRound(double x) {  // Math.round
  const double f = std::floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

// ---- the scan -----------------------------------------------------------------------------------------------------

struct PackDir {
  std::string slug, dir, root;
  std::optional<std::string> skip;
};

/** server.js listPackDirs */
std::vector<PackDir> listPackDirs(const std::vector<std::string> &roots, std::vector<std::string> &errors) {
  std::vector<PackDir> out;
  std::unordered_set<std::string> slugs;
  for (const std::string &root : roots) {
    std::string rootReal;
    struct stat st;
    std::vector<Dirent> entries;
    if (!fsRealpath(root, &rootReal, nullptr) || !fsStat(rootReal, &st, nullptr) || !S_ISDIR(st.st_mode)) continue;
    if (!fsReaddir(rootReal, &entries)) continue;
    localeSort(entries, [](const Dirent &e) -> const std::string & { return e.name; });
    for (const Dirent &e : entries) {
      if (slugs.size() >= kUserPacksMax) break;
      if (e.name.rfind('.', 0) == 0 || !(e.isDir || e.isLink)) continue;
      std::string dir;
      struct stat ds;
      if (!fsRealpath(jsPathJoin(rootReal, e.name), &dir, nullptr) || !fsStat(dir, &ds, nullptr) ||
          !S_ISDIR(ds.st_mode)) {
        continue;
      }
      if (!within(rootReal, dir)) {
        errors.push_back(jsPathJoin(root, e.name) + ": is a link to a folder outside My Samples (" + dir +
                         "); skipped");
        continue;
      }
      if (slugs.count(e.name)) {
        PackDir p{e.name, dir, rootReal, std::nullopt};
        p.skip = jsPathJoin(root, e.name) + ": a pack named \"" + e.name +
                 "\" was already found in an earlier folder; skipped";
        out.push_back(std::move(p));
        continue;
      }
      slugs.insert(e.name);
      out.push_back(PackDir{e.name, dir, rootReal, std::nullopt});
    }
  }
  return out;
}

bool endsWithJsonI(const std::string &n) {  // /\.json$/i
  if (n.size() < 5) return false;
  std::string t = n.substr(n.size() - 5);
  for (char &c : t) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
  return t == ".json";
}

/** server.js packSongFiles */
std::vector<std::string> packSongFiles(const std::string &dir) {
  std::vector<Dirent> entries;
  if (!fsReaddir(jsPathJoin(dir, "songs"), &entries)) return {};
  std::vector<std::string> out;
  for (const Dirent &e : entries) {
    if (e.name.rfind('.', 0) != 0 && endsWithJsonI(e.name) && (e.isFile || e.isLink)) out.push_back(e.name);
  }
  localeSort(out, [](const std::string &s) -> const std::string & { return s; });
  return out;
}

struct PackMeta {
  std::string mode = "auto";
  std::optional<std::string> name;
};

/** server.js readPackJson */
PackMeta readPackJson(const std::string &dir, const std::string &label, std::vector<std::string> &errors) {
  const std::string f = jsPathJoin(dir, "pack.json");
  auto bad = [&](const std::string &msg) {
    errors.push_back(label + "/pack.json: " + msg + "; read as \"auto\"");
    return PackMeta{};
  };
  struct stat st;
  FsError err;
  if (!fsStat(f, &st, &err)) return err.enoent ? PackMeta{} : bad(err.message);
  if (st.st_size > kPackJsonMaxBytes) return bad("pack.json is too large");
  std::string text;
  if (!fsReadText(f, &text, &err)) return err.enoent ? PackMeta{} : bad(err.message);
  const ParseResult j = jsonParse(text, kMaxDepth);
  if (!j.ok) return bad(j.error);
  if (!j.value.isPlainObj()) return bad("pack.json must be an object such as {\"mode\": \"bank\"}");
  PackMeta out;
  if (const JVal *m = j.value.get("mode")) {
    if (m->type == JVal::Str && (m->str == "auto" || m->str == "bank")) {
      out.mode = m->str;
    } else {
      errors.push_back(label + "/pack.json: \"mode\" must be \"auto\" or \"bank\"; read as \"auto\"");
    }
  }
  if (const JVal *n = j.value.get("name"); n && n->type == JVal::Str) {
    const std::string t = jsTrim(n->str);
    if (!t.empty()) out.name = jsSliceStart(t, 120);
  }
  return out;
}

struct Entry {
  const JVal *song = nullptr;  // `rest` is this object without its "id" and "bank" keys
  std::optional<double> schema;
  const JVal *bank = nullptr;  // a plain object, or null
};

/** server.js checkPatchEntry: the entry, or why it was skipped. */
std::optional<std::string> checkPatchEntry(const JVal &raw, Entry *e) {
  if (!raw.isPlainObj()) return std::string("not a song object");
  const JVal *song = nullptr;
  const JVal *bank = nullptr;
  bool bankSet = false;
  const JVal *kind = raw.get("kind");
  const bool kindIs = [&](const char *k) { return kind && kind->type == JVal::Str && kind->str == k; }("song");
  if (kindIs) {
    song = raw.get("song");
    const JVal *s = raw.get("schema");
    if (s && s->type == JVal::Num && std::isfinite(s->num)) e->schema = s->num;
    bank = raw.get("bank");
    bankSet = bank != nullptr;
  } else if ((kind && kind->type == JVal::Str && kind->str == "library") || raw.get("songs")) {
    return std::string("a whole library, not a song (export single songs, or put songs in an array)");
  } else {
    song = &raw;
  }
  const JVal *patch = song && song->isPlainObj() ? song->get("patch") : nullptr;
  if (!song || !song->isPlainObj() || !patch || !patch->isPlainObj()) {
    return std::string("no song in it (expected \"kind\": \"song\" and a \"song\" with a \"patch\")");
  }
  if (const JVal *slots = patch->get("slots")) {
    const long long n = slots->type == JVal::Arr ? static_cast<long long>(slots->arr.size()) : -1;
    if (n < 1 || n > static_cast<long long>(kMaxSlots)) {
      return "\"patch.slots\" must be a list of 1 to " + std::to_string(kMaxSlots) + " slots";
    }
  }
  if (const JVal *name = song->get("name"); name && name->type != JVal::Str)
    return std::string("\"name\" must be text");
  if (!bankSet) bank = song->get("bank");  // `if (bank === undefined) bank = ownBank`
  e->song = song;
  e->bank = bank && bank->isPlainObj() ? bank : nullptr;
  return std::nullopt;
}

/** JSON.stringify(rest) for `const { id, bank, ...rest } = song`. */
void stringifyRest(const JVal &song, std::string &out) {
  out.push_back('{');
  bool first = true;
  for (const auto &kv : song.obj) {
    if (kv.first == "id" || kv.first == "bank") continue;
    if (!first) out.push_back(',');
    first = false;
    jsonQuote(kv.first, out);
    out.push_back(':');
    jsonStringify(kv.second, out);
  }
  out.push_back('}');
}

/** JS truthiness of a JSON value. */
bool truthy(const JVal *v) {
  if (!v) return false;
  switch (v->type) {
    case JVal::Null:
      return false;
    case JVal::Bool:
      return v->b;
    case JVal::Num:
      return v->num != 0 && !std::isnan(v->num);
    case JVal::Str:
      return !v->str.empty();
    default:
      return true;
  }
}

/** server.js userRefsOf (on `rest`, which has the same `patch`). Property reads on a primitive give undefined. */
std::vector<std::string> userRefsOf(const JVal &song) {
  std::vector<std::string> out;
  const JVal *patch = song.get("patch");
  const JVal *slots = truthy(patch) ? patch->get("slots") : nullptr;
  if (!slots || slots->type != JVal::Arr) return out;
  for (const JVal &s : slots->arr) {
    if (!truthy(&s)) continue;
    const JVal *inst = s.get("instrument");
    if (!truthy(inst)) continue;
    const JVal *ref = inst->get("id");
    if (ref && ref->type == JVal::Str && ref->str.rfind("user:", 0) == 0) out.push_back(ref->str);
  }
  return out;
}

struct Pack {
  std::string slug, mode;
  std::optional<std::string> name;
  std::size_t songs = 0, files = 0;
};

std::string quoted(const std::string &s) {
  std::string o;
  jsonQuote(s, o);
  return o;
}

}  // namespace

std::string jsPathJoin(const std::string &a, const std::string &b) {
  std::string j;
  if (!a.empty()) j = a;
  if (!b.empty()) j = j.empty() ? b : j + "/" + b;
  return j.empty() ? "." : jsPathNormalize(j);
}

std::string jsPathResolve(const std::string &p) {
  std::string path = p;
  if (path.empty() || path[0] != '/') {
    char buf[PATH_MAX];
    const char *cwd = ::getcwd(buf, sizeof buf);
    path = std::string(cwd ? cwd : "/") + "/" + path;
  }
  return "/" + normalizeString(path, false);
}

std::string scanUserPatchesJson(const std::vector<std::string> &roots, const ScanOptions &o) {
  std::vector<std::string> errors;
  std::vector<std::string> patches;  // each one already JSON
  std::vector<Pack> packs;
  long long total = 0;
  for (const PackDir &p : listPackDirs(roots, errors)) {
    const std::vector<std::string> files = packSongFiles(p.dir);
    if (files.empty()) continue;
    if (p.skip) {
      errors.push_back(*p.skip);
      continue;
    }
    if (p.slug.find(':') != std::string::npos) {
      errors.push_back(p.slug + ": a pack folder name must not contain \":\"; skipped");
      continue;
    }
    if (jsLength(p.slug) > kSlugMax) {
      errors.push_back(jsSliceStart(p.slug, 40) + "\xE2\x80\xA6: a pack folder name must be at most " +
                       std::to_string(kSlugMax) + " characters; skipped");
      continue;
    }
    const PackMeta meta = readPackJson(p.dir, p.slug, errors);
    Pack pack{p.slug, meta.mode, meta.name, 0, 0};
    if (files.size() > kFilesMax) {
      errors.push_back(p.slug + "/songs: more than " + std::to_string(kFilesMax) + " files; only the first " +
                       std::to_string(kFilesMax) + " are read");
    }
    for (std::size_t fi = 0; fi < files.size() && fi < kFilesMax; ++fi) {
      const std::string &file = files[fi];
      const std::string label = p.slug + "/songs/" + file;
      if (jsLength(file) > kFileNameMax) {
        errors.push_back(label + ": the file name must be at most " + std::to_string(kFileNameMax) +
                         " characters; skipped");
        continue;
      }
      if (patches.size() >= kSongsMax) {
        errors.push_back(label + ": more than " + std::to_string(kSongsMax) + " pack songs in all; skipped");
        break;
      }
      const std::string abs = join3(p.dir, "songs", file);
      std::string real, text;
      struct stat st;
      FsError err;
      std::optional<std::string> why;
      if (!fsRealpath(abs, &real, &err)) {
        why = err.message;
      } else if (!within(p.dir, real)) {
        why = "is a link to a file outside the pack";
      } else if (!fsStat(real, &st, &err)) {
        why = err.message;
      } else if (!S_ISREG(st.st_mode)) {
        continue;
      } else if (st.st_size > kFileMaxBytes) {
        why = "is larger than " + std::to_string(kFileMaxBytes / 1048576) + " MB";
      } else if (total + st.st_size > kTotalMaxBytes) {
        why = "the pack songs are too large in all";
      } else {
        total += st.st_size;
        if (!fsReadText(real, &text, &err)) why = err.message;
      }
      ParseResult json;
      if (!why) {
        json = jsonParse(text, kMaxDepth);
        if (!json.ok) why = "not valid JSON (" + json.error + ")";
      }
      if (why) {
        errors.push_back(label + ": " + *why + "; skipped");
        continue;
      }
      if (json.tooDeep) {
        errors.push_back(label + ": nested too deeply; skipped");
        continue;
      }
      const bool isArr = json.value.type == JVal::Arr;
      std::vector<const JVal *> list;
      if (isArr) {
        for (const JVal &v : json.value.arr) list.push_back(&v);
      } else {
        list.push_back(&json.value);
      }
      if (isArr && list.empty()) errors.push_back(label + ": the song list is empty");
      if (list.size() > kSongsPerFileMax) {
        errors.push_back(label + ": more than " + std::to_string(kSongsPerFileMax) + " songs; only the first " +
                         std::to_string(kSongsPerFileMax) + " are read");
      }
      const double mtime = jsRound(mtimeMs(st));
      std::size_t used = 0;
      for (std::size_t i = 0; i < list.size() && i < kSongsPerFileMax; ++i) {
        const std::string where = isArr ? label + " #" + std::to_string(i) : label;
        if (patches.size() >= kSongsMax) break;
        Entry e;
        if (auto bad = checkPatchEntry(*list[i], &e)) {
          errors.push_back(where + ": " + *bad + "; skipped");
          continue;
        }
        if (o.checkUserIds) {
          for (const std::string &ref : userRefsOf(*e.song)) {
            if (o.userIds.count(ref)) continue;
            errors.push_back(where + ": uses \"" + ref + "\", which no My Samples pack has; it will not sound");
          }
        }
        std::string songJson, bankJson;
        stringifyRest(*e.song, songJson);
        if (e.bank) jsonStringify(*e.bank, bankJson);
        const std::string schemaJson = e.schema ? jsNumberToString(*e.schema) : std::string();
        const std::string body =
            "[" + (e.schema ? schemaJson : "null") + "," + songJson + "," + (e.bank ? bankJson : "null") + "]";
        const std::string hash = sha1Hex(body).substr(0, 16);
        const std::string packId = p.slug + ":" + file + (isArr ? "#" + std::to_string(i) : "");
        std::string out = "{\"packId\":" + quoted(packId) + ",\"pack\":" + quoted(p.slug) +
                          ",\"file\":" + quoted(file) + ",\"n\":" + (isArr ? std::to_string(i) : "null") +
                          ",\"mtime\":" + jsNumberToString(mtime) + ",\"hash\":" + quoted(hash) +
                          ",\"mode\":" + quoted(meta.mode) + ",\"song\":" + songJson;
        if (e.schema) out += ",\"schema\":" + schemaJson;
        if (e.bank) out += ",\"bank\":" + bankJson;
        out.push_back('}');
        patches.push_back(std::move(out));
        used += 1;
      }
      pack.files += 1;
      pack.songs += used;
    }
    packs.push_back(std::move(pack));
  }
  std::string out = "{\"patches\":[";
  for (std::size_t i = 0; i < patches.size(); ++i) {
    if (i) out.push_back(',');
    out += patches[i];
  }
  out += "],\"packs\":[";
  for (std::size_t i = 0; i < packs.size(); ++i) {
    const Pack &k = packs[i];
    if (i) out.push_back(',');
    out += "{\"slug\":" + quoted(k.slug) + ",\"mode\":" + quoted(k.mode) + ",\"songs\":" + std::to_string(k.songs) +
           ",\"files\":" + std::to_string(k.files);
    if (k.name) out += ",\"name\":" + quoted(*k.name);
    out.push_back('}');
  }
  out += "],\"errors\":[";
  for (std::size_t i = 0; i < errors.size(); ++i) {
    if (i) out.push_back(',');
    jsonQuote(errors[i], out);
  }
  out += "]}";
  return out;
}

bool hasUserPatches(const std::vector<std::string> &roots) {
  std::vector<std::string> ignored;
  for (const PackDir &p : listPackDirs(roots, ignored)) {
    if (!p.skip && !packSongFiles(p.dir).empty()) return true;
  }
  return false;
}

}  // namespace rig::hostkit
