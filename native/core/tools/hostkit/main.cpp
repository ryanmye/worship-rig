// rig-hostkit: the hostkit library from the command line, for test/unit/hostkit/parity.test.mjs (lane N1).
//   rig-hostkit scan '<roots json>' ['<user ids json>']    rig_hostkit_scan_patches, printed as is (no newline)
//   rig-hostkit user-patches '<roots json>' ['<ids>']      rig_hostkit_user_patches_json
//   rig-hostkit has '<roots json>'                         true | false
//   rig-hostkit json < cases                               JSON.parse + JSON.stringify of each input line
//   rig-hostkit text < cases                               decode, length, slice(0, 40), trim of each line
//   rig-hostkit collate < cases                            the lines sorted with localeCompare (numeric, base)
// Case lines are hex-encoded bytes (any bytes: invalid UTF-8 too); answers are one line each:
//   json:    `ok <deep 0|1> <hex of JSON.stringify(JSON.parse(text))>` or `err <hex of the SyntaxError text>`
//   text:    `<hex decoded> <length> <hex slice> <hex trim>`
//   collate: the sorted input lines (hex), stable
//   rig-hostkit bus-state < cases / bus-command < cases    rig_bus_check_state / _command (remote lane, D45):
//            `ok` or `err <hex of the reason>` per line
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "js_json.h"
#include "js_text.h"
#include "rig/rig_bus.h"
#include "rig/rig_hostkit.h"

namespace {

using namespace rig::hostkit;

std::string unhex(const std::string &h) {
  std::string out;
  for (std::size_t i = 0; i + 1 < h.size(); i += 2) {
    out.push_back(static_cast<char>(std::stoi(h.substr(i, 2), nullptr, 16)));
  }
  return out;
}

std::string hex(const std::string &s) {
  static const char *d = "0123456789abcdef";
  std::string out;
  for (unsigned char c : s) {
    out.push_back(d[c >> 4]);
    out.push_back(d[c & 15]);
  }
  return out;
}

int usage() {
  std::fprintf(stderr, "usage: rig-hostkit scan|user-patches|has <roots json> [<user ids json>] | json|text|collate|bus-state|bus-command\n");
  return 2;
}

int print(char *s) {
  if (!s) return 1;
  std::fwrite(s, 1, std::strlen(s), stdout);
  rig_hostkit_free(s);
  return 0;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 2) return usage();
  const std::string cmd = argv[1];
  const char *ids = argc > 3 ? argv[3] : nullptr;
  if (cmd == "scan" && argc >= 3) return print(rig_hostkit_scan_patches(argv[2], ids));
  if (cmd == "user-patches" && argc >= 3) return print(rig_hostkit_user_patches_json(argv[2], ids));
  if (cmd == "has" && argc >= 3) {
    std::fputs(rig_hostkit_has_patches(argv[2]) ? "true" : "false", stdout);
    return 0;
  }
  std::vector<std::string> lines;
  for (std::string l; std::getline(std::cin, l);) lines.push_back(l);
  if (cmd == "json") {
    for (const std::string &l : lines) {
      // the scanner's depth (64) is what the corpus checks; the CLI builds at most 64 levels too
      const ParseResult r = jsonParse(decodeUtf8(unhex(l)), 64);
      if (!r.ok) {
        std::cout << "err " << hex(r.error) << '\n';
        continue;
      }
      std::string out;
      jsonStringify(r.value, out);
      std::cout << "ok " << (r.tooDeep ? 1 : 0) << ' ' << hex(out) << '\n';
    }
    return 0;
  }
  if (cmd == "text") {
    for (const std::string &l : lines) {
      const std::string s = decodeUtf8(unhex(l));
      std::cout << hex(s) << ' ' << jsLength(s) << ' ' << hex(jsSliceStart(s, 40)) << ' ' << hex(jsTrim(s)) << '\n';
    }
    return 0;
  }
  if (cmd == "bus-state" || cmd == "bus-command") {
    for (const std::string &l : lines) {
      const std::string b = unhex(l);
      char *e = nullptr;
      const int rc = cmd == "bus-state" ? rig_bus_check_state(b.data(), b.size(), &e)
                                        : rig_bus_check_command(b.data(), b.size(), &e);
      if (rc < 0) {
        std::cout << "internal\n";
      } else if (rc == 1) {
        std::cout << "err " << hex(e) << '\n';
        rig_hostkit_free(e);
      } else {
        std::cout << "ok\n";
      }
    }
    return 0;
  }
  if (cmd == "collate") {
    std::vector<std::pair<std::string, std::string>> v;  // decoded, original line
    for (const std::string &l : lines) v.emplace_back(decodeUtf8(unhex(l)), l);
    std::stable_sort(v.begin(), v.end(),
                     [](const auto &a, const auto &b) { return jsLocaleCompare(a.first, b.first) < 0; });
    for (const auto &p : v) std::cout << p.second << '\n';
    return 0;
  }
  return usage();
}
