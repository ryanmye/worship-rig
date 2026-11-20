// rig-probe command line (probe.h, native/docs/MAC_CHECK.md). Writes the JSON report to --out (or stdout) and
// progress lines to stderr. Exit 0 = a report was written (it may still list errors), 1 = no report, 2 = usage.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "probe.h"

namespace {

void usage() {
  std::fputs(
      "usage: rig-probe [options]   (the output is muted: the core renders, the device gets zeros)\n"
      "  --out FILE            write the JSON report here (default stdout)\n"
      "  --backend NAME        auto | null | coreaudio | alsa | pulse (default auto)\n"
      "  --repo DIR            repository root (default: the one this binary was built from)\n"
      "  --buffers LIST        buffer sizes to measure, e.g. 64,128,256,512 (default); 'none' skips them\n"
      "  --seconds S           measured seconds per buffer size (default 10)\n"
      "  --kinds LIST          load sweep kinds: synth,sampler (default); 'none' skips the sweep\n"
      "  --synth ID            synth patch for the sweep (default warm-pad)\n"
      "  --sampler ID          bundled sampler instrument (default upright-piano)\n"
      "  --notes LIST          held notes per slot per sweep step (default 0,1,2,4,6,8,12,16,24,32,48,64,96,128)\n"
      "  --step-seconds S      measured seconds per sweep step (default 1)\n"
      "  --settle S            seconds after a device open / chord before measuring (default 0.5)\n"
      "  --step-settle S       seconds after a sweep step's note-ons before measuring (default 0.4)\n"
      "  --quick               --seconds 3 --step-seconds 0.5 (about a minute)\n"
      "  --quiet               no progress lines\n",
      stderr);
}

std::vector<std::string> split(const std::string &s) {
  std::vector<std::string> v;
  std::size_t at = 0;
  while (at <= s.size()) {
    const std::size_t c = s.find(',', at);
    const std::string part = s.substr(at, c == std::string::npos ? std::string::npos : c - at);
    if (!part.empty()) v.push_back(part);
    if (c == std::string::npos) break;
    at = c + 1;
  }
  return v;
}

bool toU32List(const std::string &s, std::vector<std::uint32_t> *out) {
  out->clear();
  if (s == "none") return true;
  for (const auto &p : split(s)) {
    char *end = nullptr;
    const unsigned long n = std::strtoul(p.c_str(), &end, 10);
    if (!end || *end || n > 4096) return false;
    out->push_back(static_cast<std::uint32_t>(n));
  }
  return !out->empty();
}

bool toSec(const std::string &s, double *out) {
  char *end = nullptr;
  const double d = std::strtod(s.c_str(), &end);
  if (!end || *end || !(d >= 0) || d > 600) return false;
  *out = d;
  return true;
}

}  // namespace

int main(int argc, char **argv) {
  devhost::ProbeOptions o;
  o.repoDir = DEVHOST_REPO_DIR;
  std::string outPath;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto val = [&]() -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "rig-probe: %s needs a value\n", a.c_str());
        std::exit(2);
      }
      return argv[++i];
    };
    auto bad = [&](const std::string &v) {
      std::fprintf(stderr, "rig-probe: bad value for %s: '%s'\n", a.c_str(), v.c_str());
      std::exit(2);
    };
    if (a == "--out") {
      outPath = val();
    } else if (a == "--backend") {
      o.backend = val();
    } else if (a == "--repo") {
      o.repoDir = val();
    } else if (a == "--buffers") {
      const std::string v = val();
      if (!toU32List(v, &o.buffers)) bad(v);
      for (const auto b : o.buffers) {
        if (b != 64 && b != 128 && b != 256 && b != 512) bad(v);  // DECISIONS D2's choices
      }
    } else if (a == "--seconds") {
      const std::string v = val();
      if (!toSec(v, &o.bufferSeconds)) bad(v);
    } else if (a == "--kinds") {
      const std::string v = val();
      o.kinds = v == "none" ? std::vector<std::string>{} : split(v);
      for (const auto &k : o.kinds) {
        if (k != "synth" && k != "sampler") bad(v);
      }
    } else if (a == "--synth") {
      o.synthId = val();
    } else if (a == "--sampler") {
      o.samplerId = val();
    } else if (a == "--notes") {
      const std::string v = val();
      if (!toU32List(v, &o.notesPerSlot) || o.notesPerSlot.empty()) bad(v);
    } else if (a == "--step-seconds") {
      const std::string v = val();
      if (!toSec(v, &o.stepSeconds)) bad(v);
    } else if (a == "--settle") {
      const std::string v = val();
      if (!toSec(v, &o.settleSeconds)) bad(v);
    } else if (a == "--step-settle") {
      const std::string v = val();
      if (!toSec(v, &o.stepSettleSeconds)) bad(v);
    } else if (a == "--quick") {
      o.bufferSeconds = 3;
      o.stepSeconds = 0.5;
    } else if (a == "--quiet") {
      o.verbose = false;
    } else if (a == "-h" || a == "--help") {
      usage();
      return 0;
    } else {
      std::fprintf(stderr, "rig-probe: unknown option %s\n", a.c_str());
      usage();
      return 2;
    }
  }
  std::string json, err;
  if (!devhost::runProbe(o, &json, &err)) {
    std::fprintf(stderr, "rig-probe: %s\n", err.c_str());
    return 1;
  }
  json += "\n";
  if (outPath.empty()) {
    std::fwrite(json.data(), 1, json.size(), stdout);
    return 0;
  }
  std::FILE *f = std::fopen(outPath.c_str(), "w");
  bool ok = f && std::fwrite(json.data(), 1, json.size(), f) == json.size();
  if (f) ok = std::fclose(f) == 0 && ok;
  if (!ok) {
    std::fprintf(stderr, "rig-probe: cannot write %s\n", outPath.c_str());
    return 1;
  }
  return 0;
}
