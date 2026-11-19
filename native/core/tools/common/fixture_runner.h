// Replays a golden fixture (native/golden/manifest.json entry or a mini-fixture file) through the C API and returns
// the rendered tap. Mirrors the order of operations of tools/golden/page.js renderFixture (golden README).
#pragma once
#include <string>
#include <vector>

namespace rig::tools {

struct Fixture {
  std::string id;
  std::string json;            // the fixture object as JSON text
  std::string classification;  // from the manifest entry, "" for mini-fixtures
};

struct RunResult {
  bool ok = false;
  std::string error;
  double sampleRate = 44100;
  std::vector<std::vector<float>> channels;
  std::vector<std::string> skipped;  // features the current core does not implement (reported once each)
  std::vector<std::string> replies;  // raw reply/event JSON from the engine (for debugging)
};

/** Fixtures of a manifest ({fixtures:[{id, fixture:{...}}]}) or a mini-fixture file ({fixtures:[{id, setup, ...}]}). */
bool loadFixtures(const std::string &path, std::vector<Fixture> &out, std::string *err);

/** `goldenDir` is where stimuli/<name>.wav lives (native/golden). */
RunResult runFixture(const Fixture &f, const std::string &goldenDir, double sampleRate);

}  // namespace rig::tools
