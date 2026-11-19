// Shared helpers of the T06 sample tests (tests/samples_*): locating the Chromium decode dumps and metrics.
#pragma once
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "io/wav.h"
#include "samples/decode.h"
#include "samples/process_sample.h"
#include "samples/resampler.h"
#include "yyjson.h"

namespace samplestest {

inline std::string repoDir() { return RIG_REPO_DIR; }
inline std::string dumpDir() { return repoDir() + "/tools/golden/decode-dump/data"; }
inline std::string appDir() { return repoDir() + "/app"; }

/** Parsed decode-dump manifest (tools/golden/decode-dump/dump.mjs); doc is null when the dump was not generated. */
struct Dump {
  yyjson_doc *doc = nullptr;
  yyjson_val *files = nullptr;
  Dump() {
    doc = yyjson_read_file((dumpDir() + "/manifest.json").c_str(), 0, nullptr, nullptr);
    if (doc) files = yyjson_obj_get(yyjson_doc_get_root(doc), "files");
  }
  ~Dump() { yyjson_doc_free(doc); }
  Dump(const Dump &) = delete;
  Dump &operator=(const Dump &) = delete;
  bool ok() const { return files != nullptr; }
};

inline const char *str(yyjson_val *o, const char *k) { return yyjson_get_str(yyjson_obj_get(o, k)); }
inline double num(yyjson_val *o, const char *k, double d = 0) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return v && yyjson_is_num(v) ? yyjson_get_num(v) : d;
}

inline rig::samples::DecodeOpts optsOf(yyjson_val *o) {
  rig::samples::DecodeOpts d;
  if (!o || !yyjson_is_obj(o)) return d;
  d.maxSec = num(o, "maxSec", 0);
  yyjson_val *m = yyjson_obj_get(o, "maxMonoLossDb");
  if (m && yyjson_is_num(m)) {
    d.hasMaxMonoLoss = true;
    d.maxMonoLossDb = yyjson_get_num(m);
  }
  return d;
}

/** Native decode of a bundled sample resampled to `sr` (what the engine stores before processSample). */
inline bool decodeAt(const std::string &path, double sr, rig::samples::Pcm &out) {
  auto r = rig::samples::decodeFile(path, nullptr);
  if (!r.ok()) return false;
  out.channels = r.pcm.channels;
  out.sampleRate = sr;
  for (int c = 0; c < r.pcm.channels; ++c) rig::samples::resampleChannel(r.pcm.ch[c], r.pcm.sampleRate, sr, out.ch[c]);
  return true;
}

inline bool readDump(const std::string &rel, rig::io::WavData &w) {
  std::string err;
  return rig::io::readWav(dumpDir() + "/" + rel, w, &err);
}

}  // namespace samplestest
