// The C surface of rig_hostkit (include/rig/rig_hostkit.h).
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "js_json.h"
#include "patches.h"
#include "rig/rig_hostkit.h"

namespace {

using namespace rig::hostkit;

/** The string entries of a JSON array (anything else is ignored). */
std::vector<std::string> stringList(const char *json, bool *isNull) {
  std::vector<std::string> out;
  if (isNull) *isNull = true;
  if (!json) return out;
  const ParseResult r = jsonParse(json, 4);
  if (!r.ok || r.value.type != JVal::Arr) return out;
  if (isNull) *isNull = false;
  for (const JVal &v : r.value.arr) {
    if (v.type == JVal::Str && !v.str.empty()) out.push_back(v.str);
  }
  return out;
}

std::vector<std::string> roots(const char *json) {
  std::vector<std::string> out;
  for (const std::string &r : stringList(json, nullptr)) out.push_back(jsPathResolve(r));
  return out;
}

ScanOptions options(const char *userIds) {
  ScanOptions o;
  bool isNull = true;
  const std::vector<std::string> ids = stringList(userIds, &isNull);
  o.checkUserIds = !isNull;
  o.userIds.insert(ids.begin(), ids.end());
  return o;
}

char *dup(const std::string &s) {
  char *p = static_cast<char *>(std::malloc(s.size() + 1));
  if (p) std::memcpy(p, s.c_str(), s.size() + 1);
  return p;
}

}  // namespace

extern "C" {

char *rig_hostkit_scan_patches(const char *roots_json, const char *user_ids_json) {
  try {
    return dup(scanUserPatchesJson(roots(roots_json), options(user_ids_json)));
  } catch (...) {  // bad_alloc: the C surface never throws
    return nullptr;
  }
}

char *rig_hostkit_user_patches_json(const char *roots_json, const char *user_ids_json) {
  try {
    const std::string scan = scanUserPatchesJson(roots(roots_json), options(user_ids_json));
    // server.js: {app, kind, enabled, ...scanUserPatches()}: the scan's `{` becomes the tail of this object
    return dup(R"({"app":"worship-rig","kind":"user-patches","enabled":true,)" + scan.substr(1));
  } catch (...) {
    return nullptr;
  }
}

int rig_hostkit_has_patches(const char *roots_json) {
  try {
    return hasUserPatches(roots(roots_json)) ? 1 : 0;
  } catch (...) {
    return 0;
  }
}

void rig_hostkit_free(char *s) {
  std::free(s);
}

}  // extern "C"
