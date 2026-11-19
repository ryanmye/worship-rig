// rig_render / rig-golden: replay golden fixtures through the C API and write float32 WAVs.
//   rig_render --manifest native/golden/manifest.json --out DIR [--only id1,id2] [--list]
//   rig_render --fixture-file mini.json --out DIR
// Compare with: node tools/golden/compare.mjs <id> DIR/<id>.wav   (or: compare.mjs DIR for every fixture)
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../common/fixture_runner.h"
#include "io/wav.h"

int main(int argc, char **argv) {
  std::string manifest, out = ".", golden, only;
  double sr = 0;
  bool list = false;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto val = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--manifest" || a == "--fixture-file")
      manifest = val();
    else if (a == "--out")
      out = val();
    else if (a == "--golden-dir")
      golden = val();
    else if (a == "--only")
      only = val();
    else if (a == "--sr")
      sr = std::atof(val().c_str());
    else if (a == "--list")
      list = true;
    else {
      std::fprintf(stderr, "usage: %s --manifest FILE --out DIR [--only a,b] [--golden-dir DIR] [--sr N] [--list]\n",
                   argv[0]);
      return 2;
    }
  }
  if (manifest.empty()) {
    std::fprintf(stderr, "--manifest or --fixture-file required\n");
    return 2;
  }
  if (golden.empty())
    golden = manifest.substr(0, manifest.find_last_of('/') == std::string::npos ? 0 : manifest.find_last_of('/'));
  if (golden.empty()) golden = ".";
  std::vector<rig::tools::Fixture> fixtures;
  std::string err;
  if (!rig::tools::loadFixtures(manifest, fixtures, &err)) {
    std::fprintf(stderr, "%s\n", err.c_str());
    return 2;
  }
  auto wanted = [&](const std::string &id) {
    if (only.empty()) return true;
    std::string rest = only;
    while (!rest.empty()) {
      const size_t c = rest.find(',');
      if (rest.substr(0, c) == id) return true;
      rest = c == std::string::npos ? "" : rest.substr(c + 1);
    }
    return false;
  };
  int failures = 0;
  for (const auto &f : fixtures) {
    if (!wanted(f.id)) continue;
    if (list) {
      std::printf("%s\t%s\n", f.id.c_str(), f.classification.c_str());
      continue;
    }
    const auto t0 = std::chrono::steady_clock::now();
    const auto r = rig::tools::runFixture(f, golden, sr > 0 ? sr : 44100.0);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    if (!r.ok) {
      std::printf("%-28s ERROR %s\n", f.id.c_str(), r.error.c_str());
      ++failures;
      continue;
    }
    const std::string path = out + "/" + f.id + ".wav";
    if (!rig::io::writeWavF32(path, r.channels, r.sampleRate, &err)) {
      std::printf("%-28s ERROR %s\n", f.id.c_str(), err.c_str());
      ++failures;
      continue;
    }
    std::string sk;
    for (const auto &s : r.skipped) sk += (sk.empty() ? "" : ", ") + s;
    std::printf("%-28s wrote %s (%zu frames, %.0f ms)%s%s\n", f.id.c_str(), path.c_str(), r.channels[0].size(), ms,
                sk.empty() ? "" : "  UNIMPLEMENTED: ", sk.c_str());
  }
  return failures ? 1 : 0;
}
