#include "samples/manifest.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "yyjson.h"

namespace rig::samples {
namespace {

double clampd(double x, double lo, double hi) { return std::min(hi, std::max(lo, x)); }
int jsRoundInt(double x) { return static_cast<int>(std::floor(x + 0.5)); }

const yyjson_val *get(const yyjson_val *o, const char *k) {
  return o && yyjson_is_obj(const_cast<yyjson_val *>(o)) ? yyjson_obj_get(const_cast<yyjson_val *>(o), k) : nullptr;
}
bool isArr(const yyjson_val *v) { return v && yyjson_is_arr(const_cast<yyjson_val *>(v)); }
bool isObj(const yyjson_val *v) { return v && yyjson_is_obj(const_cast<yyjson_val *>(v)); }

/** JS Number(x) for a JSON value; NaN when not convertible. */
double toNumber(const yyjson_val *v) {
  auto *p = const_cast<yyjson_val *>(v);
  if (!v) return NAN;
  if (yyjson_is_num(p)) return yyjson_get_num(p);
  if (yyjson_is_bool(p)) return yyjson_get_bool(p) ? 1 : 0;
  if (yyjson_is_null(p)) return 0;
  if (yyjson_is_str(p)) {
    const char *s = yyjson_get_str(p);
    while (*s == ' ') ++s;
    if (!*s) return 0;
    char *end = nullptr;
    const double d = std::strtod(s, &end);
    while (end && *end == ' ') ++end;
    return end && !*end ? d : NAN;
  }
  return NAN;
}
bool nullish(const yyjson_val *v) { return !v || yyjson_is_null(const_cast<yyjson_val *>(v)); }
bool truthyStr(const yyjson_val *v) {
  auto *p = const_cast<yyjson_val *>(v);
  return v && yyjson_is_str(p) && yyjson_get_len(p) > 0;
}
std::string strOr(const yyjson_val *v, const std::string &d = {}) {
  auto *p = const_cast<yyjson_val *>(v);
  return v && yyjson_is_str(p) ? std::string(yyjson_get_str(p), yyjson_get_len(p)) : d;
}

std::string dirOf(const std::string &path) {
  const std::size_t i = path.find_last_of('/');
  return i == std::string::npos ? std::string(".") : (i == 0 ? "/" : path.substr(0, i));
}

/** URL-style join: absolute `rel` replaces the base; "." and ".." segments are resolved. */
std::string joinPath(const std::string &base, const std::string &rel) {
  std::string full = !rel.empty() && rel[0] == '/' ? rel : base + "/" + rel;
  std::vector<std::string> parts;
  std::size_t i = 0;
  const bool abs = !full.empty() && full[0] == '/';
  while (i <= full.size()) {
    std::size_t j = full.find('/', i);
    if (j == std::string::npos) j = full.size();
    std::string seg = full.substr(i, j - i);
    if (seg == "..") {
      if (!parts.empty() && parts.back() != "..") parts.pop_back();
      else if (!abs) parts.push_back(seg);
    } else if (!seg.empty() && seg != ".") {
      parts.push_back(seg);
    }
    i = j + 1;
  }
  std::string out = abs ? "/" : "";
  for (std::size_t k = 0; k < parts.size(); ++k) out += (k ? "/" : "") + parts[k];
  return out;
}

const char *categoryGroup(const std::string &cat) {
  static const std::pair<const char *, const char *> kMap[] = {
      {"piano", "Piano"},          {"ep", "Electric Piano"},   {"electric piano", "Electric Piano"},
      {"electric-piano", "Electric Piano"}, {"keys", "Electric Piano"}, {"mallet", "Mallets & Bells"},
      {"mallets", "Mallets & Bells"}, {"bells", "Mallets & Bells"}, {"bell", "Mallets & Bells"},
      {"guitar", "Guitar"},        {"bass", "Bass"},           {"organ", "Organ"}};
  for (const auto &m : kMap)
    if (cat == m.first) return m.second;
  return nullptr;
}

std::string lower(std::string s) {
  for (char &c : s) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
  return s;
}

bool toMidi(const yyjson_val *n, int &midi) {
  auto *p = const_cast<yyjson_val *>(n);
  if (yyjson_is_num(p)) {
    const double d = yyjson_get_num(p);
    if (std::isfinite(d)) {
      midi = static_cast<int>(clampd(std::floor(d + 0.5), 0, 127));
      return true;
    }
  }
  if (yyjson_is_str(p)) return parseNoteName(std::string_view(yyjson_get_str(p), yyjson_get_len(p)), midi);
  return false;
}

}  // namespace

bool parseNoteName(std::string_view name, int &midi) {
  while (!name.empty() && (name.front() == ' ' || name.front() == '\t')) name.remove_prefix(1);
  while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) name.remove_suffix(1);
  if (name.size() < 2) return false;
  const char l = static_cast<char>(name[0] >= 'a' && name[0] <= 'g' ? name[0] - 32 : name[0]);
  int pc;
  switch (l) {
    case 'C': pc = 0; break;
    case 'D': pc = 2; break;
    case 'E': pc = 4; break;
    case 'F': pc = 5; break;
    case 'G': pc = 7; break;
    case 'A': pc = 9; break;
    case 'B': pc = 11; break;
    default: return false;
  }
  std::size_t i = 1;
  if (name[i] == '#') {
    ++pc;
    ++i;
  } else if (name[i] == 'b') {
    --pc;
    ++i;
  } else if (name.size() >= i + 3 && static_cast<unsigned char>(name[i]) == 0xE2 &&
             static_cast<unsigned char>(name[i + 1]) == 0x99) {  // U+266F sharp / U+266D flat
    if (static_cast<unsigned char>(name[i + 2]) == 0xAF) pc += 1;
    else if (static_cast<unsigned char>(name[i + 2]) == 0xAD) pc -= 1;
    else return false;
    i += 3;
  }
  if (i >= name.size()) return false;
  bool neg = false;
  if (name[i] == '-') {
    neg = true;
    ++i;
  }
  if (i >= name.size()) return false;
  int oct = 0;
  for (; i < name.size(); ++i) {
    if (name[i] < '0' || name[i] > '9') return false;
    oct = oct * 10 + (name[i] - '0');
    if (oct > 1000) return false;
  }
  if (neg) oct = -oct;
  const int m = (oct + 1) * 12 + pc;
  if (m < 0 || m > 127) return false;
  midi = m;
  return true;
}

std::vector<SamplerDef> normalizeManifest(const yyjson_val *json, const std::string &manifestPath,
                                          const NormalizeOptions &o) {
  std::vector<SamplerDef> out;
  // entries as (id key from an object map or empty, object)
  std::vector<std::pair<std::string, const yyjson_val *>> list;
  const yyjson_val *top = isArr(json) ? json : get(json, "instruments");
  if (isArr(top)) {
    std::size_t i, n;
    yyjson_val *v;
    yyjson_arr_foreach(const_cast<yyjson_val *>(top), i, n, v) list.emplace_back(std::string(), v);
  } else if (isObj(top)) {
    std::size_t i, n;
    yyjson_val *k, *v;
    yyjson_obj_foreach(const_cast<yyjson_val *>(top), i, n, k, v) list.emplace_back(yyjson_get_str(k), v);
  } else {
    return out;
  }
  const std::string base = dirOf(manifestPath);
  for (const auto &[mapId, inst] : list) {
    if (!isObj(inst)) continue;
    std::string id = mapId;
    if (const std::string s = strOr(get(inst, "id")); !s.empty()) id = s;  // an explicit id wins over the map key
    const yyjson_val *layersV = get(inst, "layers");
    if (id.empty() || !isArr(layersV)) continue;
    std::string ext = strOr(get(inst, "ext"));
    if (ext.empty()) ext = strOr(get(inst, "format"));
    if (ext.empty()) ext = "mp3";
    SamplerDef d;
    std::size_t li, ln;
    yyjson_val *L;
    yyjson_arr_foreach(const_cast<yyjson_val *>(layersV), li, ln, L) {
      if (!isObj(L)) continue;
      const yyjson_val *vel = get(L, "vel");
      if (!isArr(vel)) vel = get(L, "velocity");
      Layer layer;
      if (isArr(vel)) {
        layer.lo = static_cast<int>(std::isnan(toNumber(yyjson_arr_get(const_cast<yyjson_val *>(vel), 0)))
                                        ? 0 : toNumber(yyjson_arr_get(const_cast<yyjson_val *>(vel), 0)));
        const yyjson_val *hi = yyjson_arr_get(const_cast<yyjson_val *>(vel), 1);
        layer.hi = static_cast<int>(nullish(hi) ? 127 : toNumber(hi));
      }
      std::string dir = strOr(get(L, "dir"));
      if (!get(L, "dir") || nullish(get(L, "dir"))) dir = !nullish(get(inst, "dir")) ? strOr(get(inst, "dir")) : id;
      const std::string lext = truthyStr(get(L, "ext")) ? strOr(get(L, "ext")) : ext;
      auto add = [&](const yyjson_val *note, const std::string &rel) {
        int midi;
        if (!toMidi(note, midi)) return;
        layer.samples.push_back({midi, joinPath(base, rel)});
      };
      const yyjson_val *files = get(L, "files");
      if (isObj(files)) {
        std::size_t i, n;
        yyjson_val *k, *v;
        yyjson_obj_foreach(const_cast<yyjson_val *>(files), i, n, k, v) {
          int midi;
          if (parseNoteName(yyjson_get_str(k), midi)) layer.samples.push_back({midi, joinPath(base, strOr(v))});
        }
      } else {
        const yyjson_val *notes = get(L, "notes");
        if (!isArr(notes)) notes = get(inst, "notes");
        if (isArr(notes)) {
          std::size_t i, n;
          yyjson_val *v;
          yyjson_arr_foreach(const_cast<yyjson_val *>(notes), i, n, v) {
            std::string name = yyjson_is_str(v) ? std::string(yyjson_get_str(v), yyjson_get_len(v))
                                                : std::to_string(static_cast<long long>(yyjson_get_num(v)));
            add(v, dir + "/" + name + "." + lext);
          }
        }
      }
      std::stable_sort(layer.samples.begin(), layer.samples.end(),
                       [](const SampleRef &a, const SampleRef &b) { return a.midi < b.midi; });
      if (!layer.samples.empty()) d.layers.push_back(std::move(layer));
    }
    if (d.layers.empty()) continue;
    std::stable_sort(d.layers.begin(), d.layers.end(), [](const Layer &a, const Layer &b) { return a.lo < b.lo; });
    const std::string cat = lower(strOr(get(inst, "category")));
    const double relV = toNumber(get(inst, "release"));
    const double relRaw = std::isfinite(relV) && relV > 0 && !nullish(get(inst, "release")) ? relV : o.defaultRelease;
    d.release = clampd(relRaw, kReleaseMin, kReleaseMax);
    const yyjson_val *gt = get(inst, "gainTrim");
    const double trimRaw = gt && yyjson_is_num(const_cast<yyjson_val *>(gt)) ? yyjson_get_num(const_cast<yyjson_val *>(gt)) : 0;
    d.gainTrimDb = clampd(trimRaw, -kGainTrimMaxDb, kGainTrimMaxDb);
    if (o.warn && d.release != relRaw)
      o.warn("Sample manifest: " + id + " release " + std::to_string(relRaw) + " s clamped to " +
             std::to_string(d.release) + " s.");
    if (o.warn && d.gainTrimDb != trimRaw)
      o.warn("Sample manifest: " + id + " gainTrim " + std::to_string(trimRaw) + " dB clamped to " +
             std::to_string(d.gainTrimDb) + " dB.");
    d.undampedFrom = !o.secondary && cat == "piano" ? kPianoUndampedFrom : -1;
    if (const yyjson_val *uf = get(inst, "undampedFrom")) {
      const double u = toNumber(uf);
      const bool off = nullish(uf) || (yyjson_is_bool(const_cast<yyjson_val *>(uf)) &&
                                       !yyjson_get_bool(const_cast<yyjson_val *>(uf))) || !std::isfinite(u);
      d.undampedFrom = off ? -1 : static_cast<int>(clampd(jsRoundInt(u), 0, 128));
    }
    const bool longCat = cat == "piano" || cat == "ep" || cat == "electric piano" || cat == "electric-piano" ||
                         cat == "keys";
    double maxSec = !o.secondary && longCat ? kKeysMaxSec : 0;
    if (const yyjson_val *ms = get(inst, "maxSec")) {
      const double m = toNumber(ms);
      const bool off = nullish(ms) || (yyjson_is_bool(const_cast<yyjson_val *>(ms)) &&
                                       !yyjson_get_bool(const_cast<yyjson_val *>(ms))) || !(m > 0);
      maxSec = off ? 0 : clampd(m, kMaxSecMin, kMaxSecMax);
    }
    d.maxSec = maxSec;
    if (const yyjson_val *ml = get(inst, "maxMonoLossDb"); !nullish(ml)) {
      const double loss = toNumber(ml);
      if (std::isfinite(loss)) {
        d.decodeOpts.hasMaxMonoLoss = true;
        d.decodeOpts.maxMonoLossDb = loss;
        d.hasDecodeOpts = true;
      }
    }
    if (maxSec > 0) {
      d.decodeOpts.maxSec = maxSec;
      d.hasDecodeOpts = true;
    }
    const double wd = toNumber(get(inst, "widthDefault"));
    d.widthDefault = !nullish(get(inst, "widthDefault")) && std::isfinite(wd) ? clampd(wd, 0, 1.5) : 1;
    d.id = o.idPrefix + id;
    d.name = truthyStr(get(inst, "name")) ? strOr(get(inst, "name")) : id;
    std::string grp = strOr(get(inst, "group"));
    const auto b = grp.find_first_not_of(" \t\r\n");
    grp = b == std::string::npos ? std::string() : grp.substr(b, grp.find_last_not_of(" \t\r\n") - b + 1);
    if (!grp.empty()) d.group = grp;
    else if (!o.group.empty()) d.group = o.group;
    else if (const char *g = categoryGroup(cat)) d.group = g;
    else d.group = "Piano";
    d.license = strOr(get(inst, "license"));
    d.attribution = strOr(get(inst, "attribution"));
    out.push_back(std::move(d));
  }
  return out;
}

bool loadGainTrims(const std::string &path, GainTrims &trims, std::string *err) {
  trims = GainTrims{};
  yyjson_read_err e;
  yyjson_doc *doc = yyjson_read_file(path.c_str(), 0, nullptr, &e);
  if (!doc) {
    if (err) *err = e.msg ? e.msg : "unreadable";
    return false;
  }
  const yyjson_val *root = yyjson_doc_get_root(doc);
  auto clean = [&](const char *key, std::map<std::string, double> &dst) {
    const yyjson_val *o = get(root, key);
    if (!isObj(o)) return;
    std::size_t i, n;
    yyjson_val *k, *v;
    yyjson_obj_foreach(const_cast<yyjson_val *>(o), i, n, k, v) {
      const double d = toNumber(v);
      if (std::isfinite(d)) dst[yyjson_get_str(k)] = d;
    }
  };
  clean("synth", trims.synth);
  clean("organ", trims.organ);
  const double dt = toNumber(get(root, "droneTrim"));
  trims.droneTrim = std::isfinite(dt) ? dt : 0;
  yyjson_doc_free(doc);
  return true;
}

void SampleRegistry::loadFactory(const std::string &appDir, const Warn &warn) {
  const std::string path = appDir + "/samples/manifest.json";
  yyjson_read_err e;
  yyjson_doc *doc = yyjson_read_file(path.c_str(), 0, nullptr, &e);
  if (!doc) {
    if (warn) warn("Sample manifest unavailable (" + path + "): " + (e.msg ? e.msg : "unreadable") +
                   ". Sampled instruments disabled.");
  } else {
    NormalizeOptions no;
    no.warn = warn;
    for (auto &d : normalizeManifest(yyjson_doc_get_root(doc), path, no)) {
      const std::string id = d.id;
      defs_.emplace(id, std::move(d));  // first wins
    }
    yyjson_doc_free(doc);
  }
  std::string err;
  if (!loadGainTrims(appDir + "/js/engine/gain-trims.json", trims_, &err) && warn)
    warn("gain-trims.json unavailable (" + err + "); instruments play untrimmed.");
}

std::size_t SampleRegistry::userCount() const {
  std::size_t n = 0;
  for (const auto &kv : defs_) n += kv.first.rfind("user:", 0) == 0;
  return n;
}

const SamplerDef *SampleRegistry::find(std::string_view id) const {
  auto it = defs_.find(id);
  return it == defs_.end() ? nullptr : &it->second;
}

SampleRegistry::UserResult SampleRegistry::reloadUser(const std::string &path, const Warn &warn,
                                                      std::vector<std::string> &dropped) {
  auto collect = [&](const SamplerDef &d) {
    for (const Layer &L : d.layers)
      for (const SampleRef &s : L.samples) dropped.push_back(s.url);
  };
  std::vector<std::string> oldIds;
  for (const auto &kv : defs_)
    if (kv.first.rfind("user:", 0) == 0) oldIds.push_back(kv.first);
  yyjson_doc *doc = nullptr;
  if (!path.empty()) {
    if (std::FILE *f = std::fopen(path.c_str(), "rb")) {
      std::fclose(f);
      yyjson_read_err e;
      doc = yyjson_read_file(path.c_str(), 0, nullptr, &e);
      if (!doc) {
        if (warn) warn(std::string("My Samples reload failed (") + (e.msg ? e.msg : "unreadable") + "); keeping the " +
                       std::to_string(oldIds.size()) + " instrument(s) already loaded.");
        return UserResult::Failed;
      }
    }
  }
  for (const auto &id : oldIds) {
    collect(defs_[id]);
    defs_.erase(id);
  }
  if (!doc) return UserResult::NotServed;
  NormalizeOptions no;
  no.idPrefix = "user:";
  no.group = "My Samples";
  no.defaultRelease = kUserReleaseDefault;
  no.secondary = true;
  no.warn = warn;
  for (auto &d : normalizeManifest(yyjson_doc_get_root(doc), path, no)) {
    if (defs_.count(d.id)) continue;
    collect(d);
    const std::string id = d.id;
    defs_.emplace(id, std::move(d));
  }
  yyjson_doc_free(doc);
  return UserResult::Loaded;
}

}  // namespace rig::samples
