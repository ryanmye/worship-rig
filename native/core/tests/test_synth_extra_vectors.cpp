// T15: the native SynthExtraInstrument / OrganInstrument against app/js/engine/synth-extra.js / organ.js rendered in
// the golden Chromium (tools/golden/vectors/dump-synth-extra.mjs -> data/synth-extra.txt, dump-organ.mjs ->
// data/organ.txt): legato, bend, every IMPL apply param, morph, the steal fade, allOff, fadeOutVoice, the rotary
// ramps, the 2x overdrive, 48 kHz. Each JS call is replayed as the graph would deliver its command: at the start of
// the quantum that contains its frame. Exact tier (max |diff| <= tol, default 2e-4), allocation trap on.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "inst/organ.h"
#include "inst/synth.h"
#include "inst/synth_extra.h"
#include "test_synth_util.h"
#include "yyjson.h"

namespace {

std::vector<std::uint8_t> b64decode(const std::string &s) {
  static const std::string tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<std::uint8_t> out;
  out.reserve(s.size() * 3 / 4);
  unsigned buf = 0;
  int bits = 0;
  for (char ch : s) {
    if (ch == '=') break;
    const std::size_t v = tbl.find(ch);
    if (v == std::string::npos) continue;
    buf = (buf << 6) | static_cast<unsigned>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((buf >> bits) & 0xff));
    }
  }
  return out;
}

struct Case {
  std::string name, spec, out;
};

std::vector<Case> loadCases(const char *file) {
  std::vector<Case> cs;
  std::ifstream f(std::string(RIG_REPO_DIR) + "/tools/golden/vectors/data/" + file);
  std::string line;
  Case c;
  while (std::getline(f, line)) {
    if (line.rfind("case ", 0) == 0) c = Case{line.substr(5), {}, {}};
    else if (line.rfind("spec ", 0) == 0) c.spec = line.substr(5);
    else if (line.rfind("out ", 0) == 0) c.out = line.substr(4);
    else if (line == "end") cs.push_back(c);
  }
  return cs;
}

double num(yyjson_val *v) {
  return yyjson_is_num(v) ? yyjson_get_num(v) : 0.0;
}

int indexOf(const rig::inst::ParamDef *defs, std::size_t n, const char *key) {
  for (std::size_t i = 0; i < n; ++i)
    if (std::string(defs[i].key) == key) return static_cast<int>(i);
  return -1;
}

void runCases(const char *file, std::size_t minCases) {
  using namespace rig::inst;
  const std::vector<Case> cases = loadCases(file);
  REQUIRE(cases.size() >= minCases);
  for (const Case &cs : cases) {
    CAPTURE(cs.name);
    yyjson_doc *doc = yyjson_read(cs.spec.data(), cs.spec.size(), 0);
    REQUIRE(doc);
    yyjson_val *sp = yyjson_doc_get_root(doc);
    const std::string kind = yyjson_get_str(yyjson_obj_get(sp, "kind"));
    const std::string patch = yyjson_get_str(yyjson_obj_get(sp, "patch"));
    const double sr = num(yyjson_obj_get(sp, "sr"));
    const double tol = num(yyjson_obj_get(sp, "tol"));
    const auto total = static_cast<std::size_t>(std::llround(num(yyjson_obj_get(sp, "sec")) * sr));
    yyjson_val *win = yyjson_obj_get(sp, "win");
    const auto w0 = static_cast<std::size_t>(num(yyjson_arr_get(win, 0)));
    const auto w1 = static_cast<std::size_t>(num(yyjson_arr_get(win, 1)));
    char *pj = yyjson_val_write(yyjson_obj_get(sp, "params"), 0, nullptr);
    rig::Instrument *inst = nullptr;
    const ParamDef *defs = nullptr;
    std::size_t nDefs = 0;
    std::uint16_t morphOp = 0;
    if (kind == "organ") {
      const OrganPresetDef *pd = findOrganPreset(patch);
      REQUIRE(pd);
      CHECK(num(yyjson_obj_get(sp, "trimDb")) == doctest::Approx(pd->trimDb));
      inst = new OrganInstrument(*pd, sr, 1, cs.name, pj ? pj : "{}", 0);
      defs = pd->params;
      nDefs = pd->nParams;
      morphOp = static_cast<std::uint16_t>(OrganOp::Morph);
    } else {
      const XPatchDef *pd = findXPatch(patch);
      REQUIRE(pd);
      CHECK(num(yyjson_obj_get(sp, "trimDb")) == doctest::Approx(pd->trimDb));
      inst = new SynthExtraInstrument(*pd, sr, 1, cs.name, pj ? pj : "{}", 0);
      defs = pd->params;
      nDefs = pd->nParams;
      morphOp = static_cast<std::uint16_t>(SynthOp::Morph);
    }
    std::free(pj);
    t11::Driver d(inst, sr);
    std::vector<std::vector<float>> out(2);
    auto renderTo = [&](std::size_t frame) {
      while (static_cast<std::size_t>(d.frame) + rig::kQ <= frame) {
        const auto q = d.run(rig::kQ);
        for (int c = 0; c < 2; ++c) out[c].insert(out[c].end(), q[c].begin(), q[c].end());
      }
    };
    if (const double cap = num(yyjson_obj_get(sp, "cap")); cap > 0) {
      rig::Command c{};
      c.op = rig::Op::VoiceCap;
      c.aux = static_cast<std::uint32_t>(cap);
      d.apply(c);
    }
    std::size_t i, n;
    yyjson_val *ev;
    yyjson_arr_foreach(yyjson_obj_get(sp, "ev"), i, n, ev) {
      const double t = num(yyjson_arr_get(ev, 0));
      const std::string op = yyjson_get_str(yyjson_arr_get(ev, 1));
      yyjson_val *a = yyjson_arr_get(ev, 2), *b = yyjson_arr_get(ev, 3);
      const std::int64_t frame = std::llround(t * sr);
      renderTo(static_cast<std::size_t>(frame));
      rig::Command c{};
      c.frame = frame;
      if (op == "on") {
        c.op = rig::Op::NoteOn;
        c.aux = static_cast<std::uint32_t>(num(a)) | (static_cast<std::uint32_t>(num(b)) << 8);
      } else if (op == "off") {
        c.op = rig::Op::NoteOff;
        c.aux = static_cast<std::uint32_t>(num(a));
      } else if (op == "legato") {
        c.op = rig::Op::LegatoTo;
        c.aux = static_cast<std::uint32_t>(num(a)) | (static_cast<std::uint32_t>(num(b)) << 8);
      } else if (op == "bend") {
        c.op = rig::Op::Bend;
        c.f.a = num(a);
      } else if (op == "param") {
        c.op = rig::Op::InstParam;
        const int k = indexOf(defs, nDefs, yyjson_get_str(a));
        REQUIRE(k >= 0);
        c.aux = static_cast<std::uint32_t>(k);
        if (yyjson_is_str(b)) {  // the rotary enum travels as its index
          const std::string v = yyjson_get_str(b);
          c.f.a = v == "slow" ? 0 : v == "fast" ? 1 : 2;
        } else {
          c.f.a = num(b);
        }
        c.f.b = t;
      } else if (op == "morph") {
        c.op = static_cast<rig::Op>(morphOp);
        c.f.a = num(a);
        c.f.b = t;
      } else if (op == "allOff") {
        c.op = rig::Op::AllNotesOff;
      } else if (op == "fade") {
        c.op = rig::Op::FadeNote;  // O-W3-1: fadeOutVoice of the (held) voice of this note
        c.aux = static_cast<std::uint32_t>(num(a));
        c.f.a = num(b);
      } else {
        FAIL("unknown op " << op);
      }
      d.apply(c);
    }
    yyjson_doc_free(doc);
    renderTo(total + rig::kQ);
    const std::vector<std::uint8_t> bytes = b64decode(cs.out);
    const std::size_t len = w1 - w0;
    REQUIRE(bytes.size() == 2 * len * sizeof(float));
    double maxDiff = 0, peak = 0;
    std::size_t firstBad = len;
    for (int c = 0; c < 2; ++c) {
      for (std::size_t k = 0; k < len; ++k) {
        float ref;
        std::memcpy(&ref, bytes.data() + (c * len + k) * sizeof(float), sizeof(float));
        const double e = std::fabs(double(out[c][w0 + k]) - double(ref));
        if (e > tol && k < firstBad) firstBad = k;
        maxDiff = std::max(maxDiff, e);
        peak = std::max(peak, double(std::fabs(ref)));
      }
    }
    MESSAGE(cs.name << ": max |native - Chromium| = " << maxDiff << ", peak " << peak
                    << (firstBad < len ? ", first > tol at " + std::to_string(double(w0 + firstBad) / sr) + " s"
                                       : std::string()));
    CHECK(peak > 0.01);
    CHECK(maxDiff <= tol);
    CHECK(d.rtAllocs == 0);
  }
}

}  // namespace

TEST_SUITE("synth-extra-vectors") {
  TEST_CASE("synth-extra.js reference renders (dump-synth-extra.mjs) at the exact tier") {
    runCases("synth-extra.txt", 11);
  }
  TEST_CASE("organ.js reference renders (dump-organ.mjs) at the exact tier") {
    runCases("organ.txt", 4);
  }
}
