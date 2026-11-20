// T06: the "cache" service behind the Model: manifests (factory + My Samples), gain trims, estimate / preload /
// sampleStatus, byte accounting against the JS engine for the factory songs (tools/golden/decode-dump/
// cache-vectors.mjs), memory pressure, rate change.
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <unistd.h>

#include "api/registry.h"
#include "doctest.h"
#include "model/model.h"
#include "samples/cache_service.h"
#include "samples_util.h"

using namespace samplestest;
using rig::samples::CacheServiceImpl;

namespace {

class TestSink final : public rig::CommandSink {
 public:
  bool send(rig::Command) override { return true; }
  rig::TimeBase timeBase() const override { return {}; }
  void emit(std::string &&json) override { events.push_back(std::move(json)); }
  void at(double, std::function<void(double)>) override {}
  std::vector<std::string> events;
  bool saw(const char *needle) const {
    for (const auto &e : events)
      if (e.find(needle) != std::string::npos) return true;
    return false;
  }
};

struct Env {
  rig_config cfg;
  TestSink sink;
  std::unique_ptr<rig::Model> model;
  CacheServiceImpl *svc = nullptr;
  explicit Env(const std::string &app = RIG_REPO_DIR "/app", const std::string &user = {}, double sr = 44100) {
    rig::ensureModulesRegistered();
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.sample_rate = sr;
    rig::UnitEnv env;
    env.sampleRate = sr;
    env.config = &cfg;
    model = std::make_unique<rig::Model>(sink, env);
    svc = static_cast<CacheServiceImpl *>(model->service<rig::CacheService>());
    REQUIRE(svc != nullptr);
    rig::EnginePaths p;
    p.appDir = app;
    p.userManifest = user;
    model->setPaths(p);
  }
};

std::string tmpDir(const char *name) {
  auto p = std::filesystem::temp_directory_path() / (std::string("rig_t06_") + std::to_string(::getpid()) + name);
  std::filesystem::remove_all(p);
  std::filesystem::create_directories(p);
  return p.string();
}
void writeText(const std::string &path, const std::string &text) {
  if (std::FILE *f = std::fopen(path.c_str(), "wb")) {
    std::fwrite(text.data(), 1, text.size(), f);
    std::fclose(f);
  }
}
void writeTone(const std::string &path, double hz, double sr = 44100, std::size_t n = 4410) {
  std::vector<std::vector<float>> ch(1, std::vector<float>(n));
  for (std::size_t i = 0; i < n; ++i)
    ch[0][i] = static_cast<float>(0.5 * std::sin(2 * 3.14159265358979323846 * hz * static_cast<double>(i) / sr));
  rig::io::writeWavF32(path, ch, sr);
}
yyjson_doc *parse(const std::string &json) {
  return yyjson_read(json.c_str(), json.size(), 0);
}

}  // namespace

TEST_SUITE("samples_service") {
  TEST_CASE("gainTrimsAndRegistry: factory manifest, manifest gainTrim in dB, gain-trims.json") {
    Env e;
    const auto &reg = e.svc->registry();
    CHECK(reg.size() == 23);
    std::size_t files = 0;
    for (const auto &kv : reg.all())
      for (const auto &L : kv.second.layers) files += L.samples.size();
    CHECK(files == 1999);
    const auto *sal = reg.find("salamander-piano");
    REQUIRE(sal);
    CHECK(sal->group == "Piano");
    CHECK(sal->gainTrimDb == doctest::Approx(9.3));
    CHECK(sal->maxSec == 30);  // piano defaults to the long cap
    CHECK(sal->decodeOpts.hasMaxMonoLoss);
    CHECK(sal->decodeOpts.maxMonoLossDb == 3);
    CHECK(sal->undampedFrom == 90);
    CHECK(sal->layers.size() == 3);
    CHECK(sal->layers[0].lo == 0);
    CHECK(sal->layers[0].hi == 52);
    CHECK(sal->layers[0].samples.front().midi == 21);  // A0
    CHECK(sal->layers[0].samples.front().url == std::string(RIG_REPO_DIR) + "/app/samples/salamander-piano/v4/A0.mp3");
    const auto *rh = reg.find("ep-rhodes");
    REQUIRE(rh);
    CHECK(rh->group == "Electric Piano");
    CHECK(rh->maxSec == 30);
    CHECK(rh->undampedFrom == -1);
    CHECK(rh->release == doctest::Approx(0.12).epsilon(1.0));  // from the manifest (clamped), never the user default
    const auto *vb = reg.find("vibes");
    REQUIRE(vb);
    CHECK(vb->group == "Mallets & Bells");
    CHECK(vb->maxSec == 0);
    CHECK_FALSE(vb->hasDecodeOpts);
    // gain-trims.json agrees with the file
    yyjson_doc *doc = yyjson_read_file(RIG_REPO_DIR "/app/js/engine/gain-trims.json", 0, nullptr, nullptr);
    REQUIRE(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    CHECK(reg.gainTrims().droneTrim == doctest::Approx(yyjson_get_num(yyjson_obj_get(root, "droneTrim"))));
    yyjson_val *synth = yyjson_obj_get(root, "synth");
    CHECK(reg.gainTrims().synth.size() == yyjson_obj_size(synth));
    CHECK(reg.gainTrims().synth.at("warm-pad") == doctest::Approx(yyjson_get_num(yyjson_obj_get(synth, "warm-pad"))));
    CHECK(reg.gainTrims().organ.count("church") == 1);
    yyjson_doc_free(doc);
    // the cache units read through UnitEnv::cache
    CHECK(e.model->env().cache == e.svc->bufferCache());
  }

  TEST_CASE("manifest guards: clamps, forms, note names, user defaults (round2-engine m3)") {
    const std::string json = R"({"instruments":{
      "trim6":{"name":"Trim 6","category":"piano","ext":"wav","gainTrim":6,
        "layers":[{"vel":[0,127],"dir":"d","notes":["C4","c#4",61.4,"Db9"]}]},
      "hot":{"gainTrim":40,"release":5,"maxSec":0.5,"undampedFrom":200,
        "layers":[{"files":{"A4":"x/a.wav","C5":"/abs/c.wav"}}]},
      "off":{"category":"piano","maxSec":null,"undampedFrom":false,"layers":[{"notes":["A4"]}]},
      "nolayers":{"layers":[]}, "bad":{"id":"bad"}}})";
    yyjson_doc *doc = parse(json);
    REQUIRE(doc);
    std::vector<std::string> warns;
    rig::samples::NormalizeOptions o;
    o.warn = [&](const std::string &w) { warns.push_back(w); };
    auto defs = rig::samples::normalizeManifest(yyjson_doc_get_root(doc), "/m/dir/manifest.json", o);
    REQUIRE(defs.size() == 3);  // nolayers / bad skipped
    const auto &t = defs[0];
    CHECK(t.id == "trim6");
    CHECK(t.gainTrimDb == 6);
    CHECK(t.undampedFrom == 90);
    CHECK(t.maxSec == 30);
    // notes: C4 = 60, c#4 = 61, 61.4 rounds to 61, Db9 (= 1 + 12*10 = 121... outside? Db9 = 109+... valid) sorted by
    // midi
    REQUIRE(t.layers[0].samples.size() >= 3);
    CHECK(t.layers[0].samples[0].midi == 60);
    CHECK(t.layers[0].samples[0].url == "/m/dir/d/C4.wav");
    CHECK(t.layers[0].samples[1].midi == 61);
    const auto &h = defs[1];
    CHECK(h.id == "hot");
    CHECK(h.gainTrimDb == 30);
    CHECK(h.release == 1.5);
    CHECK(h.maxSec == 1);  // clamped into [1, 60]
    CHECK(h.undampedFrom == 128);
    CHECK(h.layers[0].samples[0].url == "/m/dir/x/a.wav");
    CHECK(h.layers[0].samples[1].url == "/abs/c.wav");
    CHECK(warns.size() == 2);  // release and gainTrim clamps
    const auto &f = defs[2];
    CHECK(f.maxSec == 0);  // explicit null switches the default off
    CHECK(f.undampedFrom == -1);
    yyjson_doc_free(doc);
    // user manifests (secondary): no piano defaults, group 'My Samples', release 0.15
    doc = parse(R"([{"id":"k","category":"piano","layers":[{"notes":["C4"]}]}])");
    rig::samples::NormalizeOptions u;
    u.idPrefix = "user:";
    u.group = "My Samples";
    u.defaultRelease = rig::samples::kUserReleaseDefault;
    u.secondary = true;
    auto ud = rig::samples::normalizeManifest(yyjson_doc_get_root(doc), "/u/manifest.json", u);
    REQUIRE(ud.size() == 1);
    CHECK(ud[0].id == "user:k");
    CHECK(ud[0].group == "My Samples");
    CHECK(ud[0].release == doctest::Approx(0.15));
    CHECK(ud[0].maxSec == 0);
    CHECK(ud[0].undampedFrom == -1);
    yyjson_doc_free(doc);
    int midi = 0;
    CHECK(rig::samples::parseNoteName(" Bb3 ", midi));
    CHECK(midi == 58);
    CHECK_FALSE(rig::samples::parseNoteName("H4", midi));
    CHECK_FALSE(rig::samples::parseNoteName("G10", midi));  // 127 + 1: outside MIDI range
    CHECK(rig::samples::parseNoteName("G9", midi));
    CHECK(midi == 127);
    CHECK(rig::samples::parseNoteName("C-1", midi));
    CHECK(midi == 0);
  }

  TEST_CASE("userManifests / guards: My Samples reload keeps entries on failure, drops them when not served") {
    const std::string dir = tmpDir("_user");
    writeTone(dir + "/keys_C4.wav", 261.6);
    writeTone(dir + "/keys_A4.wav", 440);
    const std::string manifest = dir + "/manifest.json";
    writeText(
        manifest,
        R"({"instruments":[{"id":"test-keys","name":"Keys",
        "layers":[{"files":{"C4":"keys_C4.wav","A4":"keys_A4.wav"}}]},
      {"id":"harp","widthDefault":0.5,"release":0.3,"layers":[{"notes":["C4"],"dir":"missing"}]}]})");
    Env e(RIG_REPO_DIR "/app", manifest);
    const auto &reg = e.svc->registry();
    CHECK(reg.userCount() == 2);
    const auto *k = reg.find("user:test-keys");
    REQUIRE(k);
    CHECK(k->group == "My Samples");
    CHECK(k->release == doctest::Approx(0.15));
    CHECK(reg.find("user:harp")->widthDefault == 0.5);
    CHECK(reg.find("user:harp")->release == doctest::Approx(0.3));
    CHECK(reg.find("test-keys") == nullptr);  // never collides with factory ids
    // decode one user sample for real; fail the missing one
    auto &c = e.svc->cache();
    const std::string uC4 = k->layers[0].samples[0].url, uHarp = reg.find("user:harp")->layers[0].samples[0].url;
    const rig::SampleBuffer *held = nullptr;
    c.requestJob({uC4, 60, {}}, 1, true, [&](const rig::SampleBuffer *b) { held = b; });
    c.requestJob({uHarp, 60, {}}, 1, false, [&](const rig::SampleBuffer *b) { CHECK(b == nullptr); });
    REQUIRE(held);
    CHECK(c.failed(uHarp));
    CHECK(e.sink.saw("Sample missing or undecodable"));
    // a malformed manifest is a FAILED reload: entries stay, the cache is left alone, a warning goes out
    writeText(manifest, "{ not json");
    CHECK_FALSE(e.svc->reloadManifests());
    CHECK(reg.userCount() == 2);
    CHECK(c.failed(uHarp));
    CHECK(e.sink.saw("My Samples reload failed"));
    // a good manifest again: failure marks of user urls are cleared, referenced buffers stay
    writeText(manifest, R"({"instruments":[{"id":"test-keys","layers":[{"files":{"C4":"keys_C4.wav"}}]}]})");
    CHECK(e.svc->reloadManifests());
    CHECK(reg.userCount() == 1);
    CHECK_FALSE(c.failed(uHarp));
    CHECK(c.has(uC4));  // referenced by a "live instrument"
    // not served any more (file gone): the user entries go; unreferenced buffers drop
    c.release(held, 0);
    std::filesystem::remove(manifest);
    CHECK(e.svc->reloadManifests());
    CHECK(reg.userCount() == 0);
    CHECK_FALSE(c.has(uC4));
    // rig_set_paths re-reads the user manifest
    writeText(manifest, R"({"instruments":[{"id":"again","layers":[{"files":{"C4":"keys_C4.wav"}}]}]})");
    rig::EnginePaths p;
    p.userManifest = manifest;
    e.model->setPaths(p);
    CHECK(reg.find("user:again") != nullptr);
    std::filesystem::remove_all(dir);
  }

  TEST_CASE("byte accounting: estimate equals the JS engine's for the factory songs (JS cache-vectors)") {
    yyjson_doc *doc = yyjson_read_file((dumpDir() + "/cache-vectors.json").c_str(), 0, nullptr, nullptr);
    if (!doc) {
      MESSAGE("cache-vectors not generated (node tools/golden/decode-dump/cache-vectors.mjs): skipped");
      return;
    }
    yyjson_val *root = yyjson_doc_get_root(doc);
    yyjson_val *songs = yyjson_obj_get(root, "songs");
    Env e;
    auto &c = e.svc->cache();
    // estimate of the patches of `which` songs (all when empty) as the service computes it
    auto estimateOf = [&](const std::vector<std::size_t> &which) {
      std::string body = "[";
      std::size_t i, n, k = 0;
      yyjson_val *s;
      yyjson_arr_foreach(songs, i, n, s) {
        if (!which.empty() && std::find(which.begin(), which.end(), i) == which.end()) continue;
        char *txt = yyjson_val_write(yyjson_obj_get(s, "patch"), 0, nullptr);
        body += (k++ ? "," : "") + std::string(txt);
        std::free(txt);
      }
      yyjson_doc *pd = parse(body + "]");
      std::string out = e.svc->estimate(yyjson_doc_get_root(pd));
      yyjson_doc_free(pd);
      return out;
    };
    int compared = 0;
    auto check = [&](const std::string &got, yyjson_val *want, const std::string &what) {
      yyjson_doc *g = parse(got);
      REQUIRE(g);
      yyjson_val *gr = yyjson_doc_get_root(g);
      INFO(what << ": " << got);
      CHECK(num(gr, "mb") == doctest::Approx(num(want, "mb")).epsilon(1e-12));
      CHECK(yyjson_get_bool(yyjson_obj_get(gr, "exact")) == yyjson_get_bool(yyjson_obj_get(want, "exact")));
      CHECK(num(gr, "samples") == num(want, "samples"));
      CHECK(num(gr, "capMB") == num(want, "capMB"));
      yyjson_doc_free(g);
      ++compared;
    };
    std::size_t i, n;
    yyjson_val *s;
    // 1. nothing decoded: every sample at the 1.75 MB default (float32 storage, 700 MB cap)
    yyjson_arr_foreach(songs, i, n, s)
        check(estimateOf({i}), yyjson_obj_get(s, "fresh"), std::string("fresh ") + str(s, "id"));
    check(estimateOf({}), yyjson_obj_get(yyjson_obj_get(root, "all"), "fresh"),
          "fresh, all songs (shared samples once)");
    // 2. the JS cache decoded three songs: replay exactly those sizes through a fake decoder, then compare the
    //    estimates again (exact for decoded keys, folder mean for their siblings, default for the rest)
    std::map<std::string, std::uint64_t> sizes;
    {
      std::size_t k, kn;
      yyjson_val *key, *val;
      yyjson_obj_foreach(yyjson_obj_get(root, "sizes"), k, kn, key, val)
          sizes[std::string(RIG_REPO_DIR) + "/app" + yyjson_get_str(key)] =
              static_cast<std::uint64_t>(yyjson_get_num(val));
    }
    c.setLoader([&sizes](const rig::samples::LoadRequest &rq) {
      rig::samples::LoadOutcome o;
      rig::samples::Processed p;
      p.channels = 1;
      p.frames = static_cast<std::size_t>(sizes.at(rq.url) / 4);
      p.ch[0].assign(p.frames, 0.0f);
      p.natural = p.frames;
      o.buffer = rig::samples::makeStored(p, rq.engineRate, rq.storage);
      o.status = rig::samples::LoadOutcome::Status::Ok;
      return o;
    });
    c.setCapBytes(100000ull * 1024 * 1024);
    for (const auto &kv : sizes) c.requestJob({kv.first, 60, {}}, 1, false, nullptr);
    CHECK(c.entryCount() == sizes.size());
    c.setCapBytes(700ull * 1024 * 1024);  // the JS default (cacheMB 700); 611 MB are held, nothing is evicted
    CHECK(c.entryCount() == sizes.size());
    yyjson_arr_foreach(songs, i, n, s)
        check(estimateOf({i}), yyjson_obj_get(s, "after"), std::string("after ") + str(s, "id"));
    check(estimateOf({}), yyjson_obj_get(yyjson_obj_get(root, "all"), "after"), "after, all songs");
    std::printf("\n== byte accounting: %d JS estimates reproduced exactly (mb, exact, samples, capMB)\n", compared);
    CHECK(compared == 2 * static_cast<int>(yyjson_arr_size(songs)) + 2);
    yyjson_doc_free(doc);
  }

  TEST_CASE("preload end to end (offline, real MP3s): pins, status, estimate, stored bytes vs the JS cache") {
    const std::string app = std::string(RIG_REPO_DIR) + "/app";
    const std::string dir = tmpDir("_mini");
    std::string files;
    for (const char *n : {"A1", "A2", "A3", "A4"})
      files += std::string(files.empty() ? "" : ",") + "\"" + n + "\":\"" + app + "/samples/ep-rhodes/" + n + ".mp3\"";
    writeText(dir + "/manifest.json", R"({"instruments":[{"id":"mini","layers":[{"files":{)" + files + "}}]}]}");
    Env e(app, dir + "/manifest.json");
    yyjson_doc *pd = parse(R"([{"slots":[{"instrument":{"type":"sampler","id":"user:mini"}},null,null,null]}])");
    const yyjson_val *patches = yyjson_doc_get_root(pd);
    CHECK_FALSE(e.svc->estimate(patches).find("\"exact\":true") != std::string::npos);
    const std::string reply = e.svc->preload(patches, "auto");
    yyjson_doc *rd = parse(reply);
    REQUIRE(rd);
    CHECK(num(yyjson_doc_get_root(rd), "deferred") == 0);
    CHECK(num(yyjson_doc_get_root(rd), "decodedMB") > 0);
    CHECK(num(yyjson_doc_get_root(rd), "pinnedMB") == doctest::Approx(num(yyjson_doc_get_root(rd), "decodedMB")));
    CHECK(e.sink.saw("\"phase\":\"preload\""));
    auto &c = e.svc->cache();
    CHECK(c.entryCount() == 4);
    CHECK(c.pins().size() == 4);  // auto with <= 2 patches = add
    CHECK(e.svc->sampleStatus(patches) == R"({"loaded":[true],"failed":[false]})");
    CHECK(e.svc->estimate(patches).find("\"exact\":true") != std::string::npos);
    // stored bytes against what the JS cache holds for the same files (cache-vectors `sizes`)
    yyjson_doc *vd = yyjson_read_file((dumpDir() + "/cache-vectors.json").c_str(), 0, nullptr, nullptr);
    if (vd) {
      yyjson_val *sz = yyjson_obj_get(yyjson_doc_get_root(vd), "sizes");
      std::printf("\n== stored bytes, native vs JS (44.1 kHz, float32): file, native, JS\n");
      for (const char *n : {"A1", "A2", "A3", "A4"}) {
        const std::string url = app + "/samples/ep-rhodes/" + n + ".mp3";
        const double js = num(sz, (std::string("/samples/ep-rhodes/") + n + ".mp3").c_str(), -1);
        const double nat = c.sizes().at(url);
        std::printf("%-6s %10.0f %10.0f  diff %+.0f\n", n, nat, js, nat - js);
        CHECK(js > 0);
        CHECK(std::fabs(nat - js) <= 4 * 16);  // an onset flipping by a few frames moves the start, nothing else
      }
      yyjson_doc_free(vd);
    }
    yyjson_doc_free(rd);
    yyjson_doc_free(pd);
    std::filesystem::remove_all(dir);
  }

  TEST_CASE("preload under a hard cap defers, then rewarmPins brings the pinned samples back") {
    const std::string dir = tmpDir("_defer");
    auto manifest = [&](const char *id, const char *tag) {
      return std::string("{\"id\":\"") + id + "\",\"layers\":[{\"files\":{\"C4\":\"" + tag + "1.wav\",\"D4\":\"" + tag +
             "2.wav\",\"E4\":\"" + tag + "3.wav\"}}]}";
    };
    writeText(dir + "/manifest.json", "{\"instruments\":[" + manifest("a", "a") + "," + manifest("b", "b") + "]}");
    Env e(RIG_REPO_DIR "/app", dir + "/manifest.json");
    auto &c = e.svc->cache();
    c.setLoader([](const rig::samples::LoadRequest &rq) {
      rig::samples::LoadOutcome o;
      rig::samples::Processed p;
      p.channels = 1;
      p.frames = 2560;  // 10 KiB
      p.ch[0].assign(p.frames, 0.1f);
      p.natural = p.frames;
      o.buffer = rig::samples::makeStored(p, rq.engineRate, rq.storage);
      o.status = rig::samples::LoadOutcome::Status::Ok;
      return o;
    });
    c.setCapBytes(45 * 1024);
    auto patchOf = [&](const char *id) {
      yyjson_doc *d = parse(std::string("[{\"slots\":[{\"instrument\":{\"type\":\"sampler\",\"id\":\"user:") + id +
                            "\"}},null,null,null]}]");
      return d;
    };
    yyjson_doc *A = patchOf("a"), *B = patchOf("b");
    e.svc->preload(yyjson_doc_get_root(A), "replace");
    CHECK(c.bytes() == 30 * 1024);
    // song A plays: protect = its buffers (what commit does)
    rig::PatchSpec pa, pb;
    std::string err;
    REQUIRE(rig::parsePatch(yyjson_arr_get_first(yyjson_doc_get_root(A)), pa, &err));
    REQUIRE(rig::parsePatch(yyjson_arr_get_first(yyjson_doc_get_root(B)), pb, &err));
    e.svc->onCommit(pa, 0);
    CHECK(c.hasProtect());
    // B warms next to it: room for one sample only; the other two are deferred (A is pinned and protected)
    const std::string reply = e.svc->preload(yyjson_doc_get_root(B), "add");
    CHECK(reply.find("\"deferred\":2") != std::string::npos);
    CHECK(c.bytes() == 40 * 1024);
    CHECK(c.pins().size() == 6);
    // the setlist moves on: A is unpinned and B is the song that plays; the re-warm decodes B's missing samples,
    // pushing unpinned A out (LRU) but never B's own buffers
    c.unpin(e.svc->sampleJobs({pa}).keys);
    e.svc->onCommit(pb, 1);
    for (const auto &k : e.svc->sampleJobs({pb}).keys) CHECK(c.has(k));
    CHECK(c.bytes() <= 45 * 1024);
    CHECK(c.evictedPinned() == 0);
    yyjson_doc_free(A);
    yyjson_doc_free(B);
    std::filesystem::remove_all(dir);
  }

  TEST_CASE("live instruments are keyed at their long cap, others at the legacy cap (sustain pin budget)") {
    Env e;
    yyjson_doc *pd = parse(R"([{"slots":[{"instrument":{"type":"sampler","id":"salamander-piano"}},null,null,null]}])");
    auto cold = e.svc->sampleJobs({});  // no patches: nothing
    CHECK(cold.keys.empty());
    rig::PatchSpec p;
    std::string err;
    REQUIRE(rig::parsePatch(yyjson_arr_get_first(yyjson_doc_get_root(pd)), p, &err));
    auto legacy = e.svc->sampleJobs({p});
    REQUIRE(legacy.keys.size() == 90);
    CHECK(legacy.keys[0].find("#max=") == std::string::npos);
    CHECK(legacy.jobs[0].opts.maxSec == 0);
    CHECK(legacy.jobs[0].opts.hasMaxMonoLoss);  // maxMonoLossDb 3 stays
    // the playing song uses the instrument: a long key (maxSec 30 as the JS key suffix)
    auto &live = e.model->patchMut().slots[0];
    live.present = true;
    live.instType = "sampler";
    live.instId = "salamander-piano";
    auto lng = e.svc->sampleJobs({p});
    CHECK(lng.keys[0].size() == legacy.keys[0].size() + 7);
    CHECK(lng.keys[0].find("#max=30") != std::string::npos);
    CHECK(lng.jobs[0].opts.maxSec == 30);
    // protect keys hold both caps of the instrument
    auto prot = e.svc->protectKeys({&p});
    CHECK(prot.size() == 180 + 0);  // 90 legacy + 90 long
    yyjson_doc_free(pd);
  }

  TEST_CASE("memory pressure, low resource and rate change through the service") {
    const std::string dir = tmpDir("_mem");
    writeText(dir + "/manifest.json",
              R"({"instruments":[{"id":"s","layers":[{"files":{"C4":"s1.wav","D4":"s2.wav"}}]}]})");
    Env e(RIG_REPO_DIR "/app", dir + "/manifest.json", 44100);
    auto &c = e.svc->cache();
    c.setLoader([](const rig::samples::LoadRequest &rq) {
      rig::samples::LoadOutcome o;
      rig::samples::Processed p;
      p.channels = 2;
      p.frames = 1000;
      p.ch[0].assign(p.frames, 0.1f);
      p.ch[1].assign(p.frames, 0.1f);
      p.natural = p.frames;
      o.buffer = rig::samples::makeStored(p, rq.engineRate, rq.storage);
      o.status = rig::samples::LoadOutcome::Status::Ok;
      return o;
    });
    yyjson_doc *pd = parse(R"([{"slots":[{"instrument":{"type":"sampler","id":"user:s"}},null,null,null]}])");
    e.svc->preload(yyjson_doc_get_root(pd), "add");
    c.requestJob({dir + "/extra.wav", 60, {}}, 1, false, nullptr);
    CHECK(c.entryCount() == 3);
    e.model->memoryPressure(1);  // Model forwards to services; the pinned song stays
    CHECK(c.entryCount() == 2);
    CHECK(e.sink.saw("memory pressure"));
    e.model->memoryPressure(2);  // critical: pins beyond the current song go too (none is protected here)
    CHECK(c.entryCount() == 0);
    CHECK(c.pins().size() == 2);  // pins stay
    // stats fields mirror _debugStats (decodedMB, pinnedMB, referencedMB, capMB; one decimal)
    const std::string st = e.svc->statsFields();
    CHECK(st.find("\"capMB\":700") != std::string::npos);
    CHECK(st.find("\"decodedMB\":0") != std::string::npos);
    // rate change: stale buffers leave the lookup path
    e.svc->preload(yyjson_doc_get_root(pd), "add");
    CHECK(c.entryCount() == 2);
    e.model->service<rig::CacheService>()->onRateChanged(48000);
    CHECK(c.engineRate() == 48000);
    CHECK(c.entryCount() == 0);
    // low resource: pins follow the playing song only, restored (plus the current) on leaving
    auto &live = e.model->patchMut().slots[0];
    live.present = true;
    live.instType = "sampler";
    live.instId = "user:s";
    c.pinAdd({"/other/pin.mp3"});
    e.svc->setLowResource(true);
    CHECK(c.pins().size() == 2);
    CHECK_FALSE(c.pins().count("/other/pin.mp3"));
    e.svc->setLowResource(false);
    CHECK(c.pins().count("/other/pin.mp3"));
    yyjson_doc_free(pd);
    std::filesystem::remove_all(dir);
  }

  TEST_CASE("pcmOverride: Chromium-decoded PCM through the engine's own load path equals the JS processSample") {
    Dump d;
    if (!d.ok()) {
      MESSAGE("decode-dump not generated: skipped");
      return;
    }
    Env e;
    e.svc->setPcmOverride(dumpDir());
    const auto *sal = e.svc->registry().find("salamander-piano");
    REQUIRE(sal);
    const std::string url = std::string(RIG_REPO_DIR) + "/app/samples/salamander-piano/v4/A4.mp3";  // MIDI 69
    rig::samples::SampleJob job{url, 69, sal->decodeOpts};
    const rig::SampleBuffer *b = nullptr;
    e.svc->cache().requestJob(job, 1, false, [&](const rig::SampleBuffer *x) { b = x; });
    REQUIRE(b);
    rig::io::WavData ref;
    REQUIRE(readDump("proc/salamander-piano__v4__A4.def.wav", ref));
    REQUIRE(b->channels == ref.ch.size());
    REQUIRE(b->frames == ref.frames());
    double mx = 0;
    for (std::size_t c = 0; c < b->channels; ++c)
      for (std::size_t i = 0; i < b->frames; ++i)
        mx = std::max(mx, std::fabs(static_cast<double>(b->f32[c][i]) - static_cast<double>(ref.ch[c][i])));
    std::printf("\n== pcmOverride salamander v4/A4: native engine buffer vs JS processSample: max abs %.3e\n", mx);
    CHECK(mx == 0.0);
    // without the hook the native decoder is used: close, but not bit-identical (decoder + onset)
    Env plain;
    const rig::SampleBuffer *p = nullptr;
    plain.svc->cache().requestJob(job, 1, false, [&](const rig::SampleBuffer *x) { p = x; });
    REQUIRE(p);
    CHECK(p->channels == b->channels);
  }
}
