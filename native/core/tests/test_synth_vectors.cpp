// T11: the native SynthInstrument against app/js/engine/synth.js rendered in the golden Chromium
// (tools/golden/vectors/dump-synth.mjs -> data/synth.txt): legato, bend, every patch param, morph, the 16-voice steal,
// allOff, fadeOutVoice, the hidden drone-osc, shared LFOs across a voice gap, the steal of released voices and 48 kHz
// (T11 review). Each JS call is replayed as the graph would deliver its command: at
// the start of the quantum that contains its frame. Exact tier (max |diff| <= 2e-4), allocation trap on.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "inst/synth.h"
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

std::vector<Case> loadCases() {
  std::vector<Case> cs;
  const char *alt = std::getenv("T11_VECTORS");  // debugging aid: replay another dump-synth.mjs output instead
  std::ifstream f(alt ? std::string(alt) : std::string(RIG_REPO_DIR) + "/tools/golden/vectors/data/synth.txt");
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

}  // namespace

TEST_SUITE("synth-vectors") {
  TEST_CASE("synth.js reference renders (dump-synth.mjs) at the exact tier") {
    const std::vector<Case> cases = loadCases();
    REQUIRE(cases.size() >= (std::getenv("T11_VECTORS") ? 1u : 15u));
    for (const Case &cs : cases) {
      CAPTURE(cs.name);
      yyjson_doc *doc = yyjson_read(cs.spec.data(), cs.spec.size(), 0);
      REQUIRE(doc);
      yyjson_val *sp = yyjson_doc_get_root(doc);
      const std::string patch = yyjson_get_str(yyjson_obj_get(sp, "patch"));
      const double sr = num(yyjson_obj_get(sp, "sr"));
      const auto total = static_cast<std::size_t>(std::llround(num(yyjson_obj_get(sp, "sec")) * sr));
      yyjson_val *win = yyjson_obj_get(sp, "win");
      const auto w0 = static_cast<std::size_t>(num(yyjson_arr_get(win, 0)));
      const auto w1 = static_cast<std::size_t>(num(yyjson_arr_get(win, 1)));
      char *pj = yyjson_val_write(yyjson_obj_get(sp, "params"), 0, nullptr);
      const rig::inst::PatchDef *pd = rig::inst::findPatch(patch);
      REQUIRE(pd);
      CHECK(num(yyjson_obj_get(sp, "trimDb")) == doctest::Approx(pd->trimDb));
      auto *inst = new rig::inst::SynthInstrument(*pd, sr, 1, cs.name, pj ? pj : "{}", 0);
      std::free(pj);
      t11::Driver d(inst, sr);
      std::vector<std::vector<float>> out(2);
      auto renderTo = [&](std::size_t frame) {  // render whole quanta until `frame` lies in the next one
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
          const int k = rig::inst::paramIndex(*pd, yyjson_get_str(a));
          REQUIRE(k >= 0);
          c.aux = static_cast<std::uint32_t>(k);
          c.f.a = num(b);
          c.f.b = t;
        } else if (op == "morph") {
          c.op = rig::opOf(rig::inst::SynthOp::Morph);
          c.f.a = num(a);
          c.f.b = t;
        } else if (op == "allOff") {
          c.op = rig::Op::AllNotesOff;
        } else if (op == "fade") {
          c.op = rig::Op::ReleaseVoice;
          c.aux = inst->voiceIdOf(static_cast<int>(num(a)));
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
          if (e > 2e-4 && k < firstBad) firstBad = k;
          maxDiff = std::max(maxDiff, e);
          peak = std::max(peak, double(std::fabs(ref)));
        }
      }
      if (const char *dump = std::getenv("T11_DUMP")) {  // debugging aid: native + reference windows as raw f32
        std::FILE *fo = std::fopen((std::string(dump) + "/" + cs.name + ".f32").c_str(), "wb");
        if (fo) {
          for (int c = 0; c < 2; ++c) std::fwrite(out[c].data() + w0, sizeof(float), len, fo);
          std::fwrite(bytes.data(), 1, bytes.size(), fo);
          std::fclose(fo);
        }
      }
      MESSAGE(cs.name << ": max |native - Chromium| = " << maxDiff << ", peak " << peak
                      << (firstBad < len ? ", first > 2e-4 at " + std::to_string(double(w0 + firstBad) / sr) + " s"
                                         : std::string()));
      CHECK(peak > 0.01);
      CHECK(maxDiff <= 2e-4);
      CHECK(d.rtAllocs == 0);
    }
  }
}
