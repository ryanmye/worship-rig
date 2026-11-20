// Sampler (T12): ports of the JS engine suites `sampler` and `undampedOptIn` (test/phase1/engine/suites.mjs:686,
// :1844) through the C API, plus unit tests of SamplerInstrument (polyphony cap and steal order, D1 cap, zone table
// swap, VoiceEnded, bend, tone, the allocation trap). The fixture samples are the JS suite's own
// (test/phase1/engine/fixtures: test-keys soft/loud C4 + A4 WAVs, test-mp3 C4), served from a temporary app dir whose
// manifest names them by absolute path.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include <unistd.h>

#include "helpers.h"
#include "inst/sampler.h"
#include "num/js_math.h"
#include "runtime/rt_guard.h"
#include "samples/buffer_cache.h"
#include "samples/manifest.h"
#include "yyjson.h"

namespace {

constexpr double kSR = 44100;  // suites.mjs SR
const double kPi = 3.141592653589793;

std::string fixtures() {
  return std::string(RIG_REPO_DIR) + "/test/phase1/engine/fixtures";
}

double db(double x) {
  return x > 0 ? 20 * std::log10(x) : -INFINITY;
}

double rms(const std::vector<float> &d, double a, double b) {
  const auto i0 = static_cast<std::size_t>(std::max(0.0, std::floor(a * kSR)));
  const auto i1 = std::min(d.size(), static_cast<std::size_t>(std::floor(b * kSR)));
  double s = 0;
  for (std::size_t i = i0; i < i1; ++i) s += double(d[i]) * d[i];
  return std::sqrt(s / static_cast<double>(std::max<std::size_t>(1, i1 - i0)));
}

/** Hann-windowed single-bin DFT magnitude at f over [a, b] (suites.mjs bandMag, as a ratio measure). */
double bandMag(const std::vector<float> &d, double a, double b, double f) {
  const auto i0 = static_cast<std::size_t>(a * kSR), i1 = std::min(d.size(), static_cast<std::size_t>(b * kSR));
  const double n = static_cast<double>(i1 - i0);
  double re = 0, im = 0;
  for (std::size_t i = i0; i < i1; ++i) {
    const double k = static_cast<double>(i - i0);
    const double w = 0.5 - 0.5 * std::cos(2 * kPi * k / (n - 1));
    re += w * d[i] * std::cos(2 * kPi * f * k / kSR);
    im -= w * d[i] * std::sin(2 * kPi * f * k / kSR);
  }
  return std::sqrt(re * re + im * im);
}

/** Strongest frequency in [lo, hi] over [a, b] (0.05 Hz scan, then a parabolic refinement). */
double peakHz(const std::vector<float> &d, double a, double b, double lo, double hi) {
  double best = lo, m = -1;
  for (double f = lo; f <= hi; f += 0.5) {
    const double v = bandMag(d, a, b, f);
    if (v > m) m = v, best = f;
  }
  double fb = best;
  for (double f = best - 0.5; f <= best + 0.5; f += 0.02) {
    const double v = bandMag(d, a, b, f);
    if (v > m) m = v, fb = f;
  }
  return fb;
}

/** First frame after `from` where |x| > thr, as seconds after `from` (-1: none). */
double onsetAfter(const std::vector<float> &d, double from, double to, double thr = 1e-3) {
  for (auto i = static_cast<std::size_t>(from * kSR); i < d.size() && i < to * kSR; ++i)
    if (std::fabs(d[i]) > thr) return static_cast<double>(i) / kSR - from;
  return -1;
}

/** A temporary app dir: <dir>/samples/manifest.json = `manifest`. Removed with the object. */
struct TempApp {
  std::filesystem::path dir;
  explicit TempApp(const std::string &name, const std::string &manifest, const std::string &user = "") {
    dir = std::filesystem::temp_directory_path() / ("rig-t12-" + name + "-" + std::to_string(::getpid()));
    std::filesystem::create_directories(dir / "samples");
    std::ofstream(dir / "samples" / "manifest.json") << manifest;
    if (!user.empty()) std::ofstream(dir / "user-manifest.json") << user;
  }
  ~TempApp() {
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
  }
  std::string app() const { return dir.string(); }
  std::string userManifest() const { return (dir / "user-manifest.json").string(); }
};

/** Offline engine with an app dir; renders the slot-0 tap (instrument -> strip, before sends and master). */
struct Eng {
  rig_engine *e = nullptr;
  std::vector<std::string> msgs;
  std::string appDir, userPath;
  Eng(const std::string &app, const std::string &user = "") : appDir(app), userPath(user) {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.flags = RIG_FLAG_TEST_API;
    cfg.sample_rate = kSR;
    cfg.app_dir = appDir.c_str();
    cfg.user_manifest = userPath.empty() ? nullptr : userPath.c_str();
    cfg.on_event = [](void *u, const char *j, size_t n) { static_cast<Eng *>(u)->msgs.emplace_back(j, n); };
    cfg.event_user = this;
    e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
    post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rig_test_tap(e, "slot0.pan") == RIG_OK);
  }
  ~Eng() { rig_destroy(e); }
  Eng(const Eng &) = delete;
  Eng &operator=(const Eng &) = delete;
  void post(const std::string &m) { rig_post(e, m.data(), m.size()); }
  std::string all() const {
    std::string s;
    for (const auto &m : msgs) s += m;
    return s;
  }
  void use(const std::string &id, const std::string &slotExtra = "") {
    msgs.clear();
    post(R"({"v":1,"op":"prepare","id":5,"patch":{"slots":[{"instrument":{"type":"sampler","id":")" + id +
         R"("},"gain":1)" + slotExtra + R"(},null,null,null]}})");
    long token = -1;
    for (const auto &r : msgs)
      if (const auto p = r.find("\"token\":"); p != std::string::npos)
        token = std::strtol(r.c_str() + p + 8, nullptr, 10);
    REQUIRE(token >= 0);
    post(R"({"v":1,"op":"commit","id":6,"token":)" + std::to_string(token) + R"(,"when":0})");
  }
  void on(int n, int vel, double t) {
    post(R"({"v":1,"op":"play","id":7,"e":"on","n":)" + std::to_string(n) + ",\"vel\":" + std::to_string(vel) +
         ",\"when\":" + std::to_string(t) + "}");
  }
  void off(int n, double t) {
    post(R"({"v":1,"op":"play","id":8,"e":"off","n":)" + std::to_string(n) + ",\"when\":" + std::to_string(t) + "}");
  }
  std::vector<float> render(double sec) {
    const auto frames = static_cast<std::size_t>(std::ceil(sec * kSR));
    std::vector<float> L(frames), R(frames);
    for (std::size_t d = 0; d < frames;) {
      const std::size_t n = std::min<std::size_t>(frames - d, 1000);
      float *p[2] = {L.data() + d, R.data() + d};
      REQUIRE(rig_offline_render(e, p, 2, static_cast<uint32_t>(n)) == RIG_OK);
      d += n;
    }
    return L;
  }
};

std::string fixtureManifest() {
  const std::string f = fixtures();
  return R"({"instruments":[
    {"id":"test-keys","name":"Test Keys","category":"piano","ext":"wav","release":0.12,"gainTrim":0,"layers":[
      {"vel":[0,63],"dir":")" + f + R"(/test-keys/soft","notes":["C4","A4"]},
      {"vel":[64,127],"dir":")" + f + R"(/test-keys/loud","notes":["C4","A4"]}]},
    {"id":"test-mp3","name":"Test MP3","category":"mallet","ext":"mp3","release":0.12,"gainTrim":0,"layers":[
      {"vel":[0,127],"dir":")" + f + R"(/test-mp3","notes":["C4"]}]},
    {"id":"test-missing","name":"Test Missing","category":"guitar","ext":"wav","release":0.12,"gainTrim":0,"layers":[
      {"vel":[0,127],"dir":")" + f + R"(/test-keys/soft","notes":["C4","D4"]}]}]})";
}

/** A decoded sample for unit tests (engine rate kSR, float storage). */
std::unique_ptr<rig::samples::Stored> loadWav(const std::string &path, int midi) {
  rig::samples::LoadRequest rq;
  rq.url = path;
  rq.midi = midi;
  rq.engineRate = kSR;
  auto o = rig::samples::loadSampleFile(rq, nullptr);
  REQUIRE(o.status == rig::samples::LoadOutcome::Status::Ok);
  return std::move(o.buffer);
}

struct Events final : rig::EventSink {
  std::vector<rig::AudioEvent> ev;
  bool push(const rig::AudioEvent &e) override {
    if (ev.size() < ev.capacity()) ev.push_back(e);  // never allocates (capacity reserved by the test)
    return true;
  }
};

/** Renders a unit directly, one quantum at a time, from frame 0. */
struct UnitRig {
  rig::SamplerInstrument &u;
  Events sink;
  rig::Bus bus;
  std::int64_t frame = 0;
  explicit UnitRig(rig::SamplerInstrument &x) : u(x) { sink.ev.reserve(4096); }
  void quantum(std::vector<float> *L = nullptr) {
    rig::RenderContext ctx{frame, kSR, static_cast<std::uint64_t>(frame / 128), rig::UnitSlot::Inst0, &sink};
    rig::UnitIO io;
    io.out = &bus;
    u.process(ctx, io);
    if (L) L->insert(L->end(), bus.ch[0], bus.ch[0] + rig::kQ);
    frame += static_cast<std::int64_t>(rig::kQ);
  }
  void until(double sec, std::vector<float> *L = nullptr) {
    while (static_cast<double>(frame) < sec * kSR) quantum(L);
  }
};

std::int64_t fr(double t) {
  return std::llround(t * kSR);
}

}  // namespace

TEST_SUITE("sampler") {
  TEST_CASE("sampler suite: layers, onset trim, repitch, undamped top, mp3 onset (suites.mjs sampler)") {
    TempApp app("suite", fixtureManifest());
    Eng e(app.app());
    e.use("test-keys");
    e.on(60, 110, 0.5);  // loud layer, onset trim
    e.off(60, 1.2);
    e.on(60, 30, 1.5);  // soft layer
    e.off(60, 2.2);
    e.on(62, 30, 2.5);  // repitch C4 -> D4
    e.off(62, 3.2);
    e.on(93, 30, 3.5);  // >= 90 (factory piano) ignores release
    e.off(93, 3.6);
    const auto d = e.render(5.5);
    const double onset = onsetAfter(d, 0.5, 0.7);
    const double h1 = bandMag(d, 0.6, 1.15, 3 * 261.63) / bandMag(d, 0.6, 1.15, 261.63);
    const double h2 = bandMag(d, 1.6, 2.15, 3 * 261.63) / bandMag(d, 1.6, 2.15, 261.63);
    const double f = peakHz(d, 2.6, 3.15, 250, 340);
    const double ringing = db(rms(d, 3.8, 4.1));
    INFO("onset ", onset, " h1 ", h1, " h2 ", h2, " f ", f, " ringing ", ringing);
    CHECK(onset >= 0);
    CHECK(onset < 0.004);
    CHECK(h1 > 0.4);
    CHECK(h2 < 0.01);
    CHECK(std::fabs(f / 293.66 - 1) < 0.005);
    CHECK(ringing > -60);

    Eng e2(app.app());
    e2.use("test-mp3");
    e2.on(60, 100, 0.5);
    const auto d2 = e2.render(1.5);
    const double onset2 = onsetAfter(d2, 0.5, 0.8);
    INFO("mp3 onset ", onset2);
    CHECK(onset2 >= 0);
    CHECK(onset2 < 0.004);
  }

  TEST_CASE("missing sample: warned once, the instrument still plays (suites.mjs sampler)") {
    TempApp app("missing", fixtureManifest());
    Eng e(app.app());
    e.use("test-missing");
    e.on(62, 100, 0.1);
    const auto d = e.render(1.0);
    const std::string all = e.all();
    std::size_t warns = 0;
    for (std::size_t p = 0; (p = all.find("\"ev\":\"warn\"", p)) != std::string::npos; ++p) {
      const std::size_t end = all.find('}', p);
      if (all.substr(p, end - p).find("D4") != std::string::npos) ++warns;
    }
    CHECK(warns == 1);
    CHECK(db(rms(d, 0.3, 0.8)) > -50);
  }

  TEST_CASE("polyphony: cap 32 steals oldest released then oldest held; D1 default 64; pool 128") {
    auto c4 = loadWav(fixtures() + "/test-keys/loud/C4.wav", 60);
    auto *z = new rig::SamplerZones();
    z->layers.push_back({0, 127, {{60, c4.get()}}});
    rig::SamplerSetup s;
    rig::SamplerInstrument u(s, z, kSR);
    CHECK(u.voiceCap() == rig::kSamplerDefaultCap);
    u.setVoiceCap(32);  // the JS SAMPLER_MAX_VOICES the suite checks
    UnitRig r(u);
    // pedal held in the Model: no note-off reaches the instrument; 40 notes 10 ms apart
    rig::SamplerInstrument::Counts at32, at40;
    for (int i = 0; i < 40; ++i) {  // issued up front, as the suite does (allocation happens at call time)
      u.noteOn(36 + i, 90, 90 / 127.0f, fr(0.1 + i * 0.01));
      if (i == 31) at32 = u.counts();
      if (i == 39) at40 = u.counts();
    }
    CHECK(at32.held + at32.released == 32);
    CHECK(at32.killed == 0);
    CHECK(at40.held + at40.released == 32);
    CHECK(at40.killed == 8);
    // released voices go first: release 4 of the oldest held ones, the next note takes the earliest released
    u.noteOff(70, fr(0.6), false);
    u.noteOff(69, fr(0.6), false);
    r.until(0.61);
    u.noteOn(100, 90, 90 / 127.0f, fr(0.61));
    const auto c = u.counts();
    CHECK(c.held + c.released == 32);
    CHECK(c.released == 1);

    rig::SamplerInstrument u2(s, nullptr, kSR);
    u2.setVoiceCap(1000);
    CHECK(u2.voiceCap() == rig::kSamplerPoolVoices);
  }

  TEST_CASE("D1 default cap 64: 70 held notes keep 64 sounding") {
    auto c4 = loadWav(fixtures() + "/test-keys/soft/C4.wav", 60);
    auto *z = new rig::SamplerZones();
    z->layers.push_back({0, 127, {{60, c4.get()}}});
    rig::SamplerInstrument u(rig::SamplerSetup{}, z, kSR);
    UnitRig r(u);
    for (int i = 0; i < 70; ++i) u.noteOn(30 + i, 80, 80 / 127.0f, fr(0.01 + i * 0.001));
    const auto c0 = u.counts();
    CHECK(c0.held == 64);
    CHECK(c0.killed == 6);
    r.until(0.2);  // the 6 stolen voices faded (20 ms) and ended
    const auto c = u.counts();
    CHECK(c.held == 64);
    CHECK(c.killed == 0);
    CHECK(u.liveVoices() == 64);
  }

  TEST_CASE("voices end: VoiceEnded per voice, release follows the release param, undamped ignores note-off") {
    auto c4 = loadWav(fixtures() + "/test-keys/soft/C4.wav", 60);
    auto *z = new rig::SamplerZones();
    z->layers.push_back({0, 127, {{60, c4.get()}, {91, c4.get()}}});  // 91 plays the same file at rate 1
    rig::SamplerSetup s;
    s.undampedFrom = 90;
    s.release = 0.12;
    rig::SamplerInstrument u(s, z, kSR);
    UnitRig r(u);
    u.noteOn(60, 100, 100 / 127.0f, fr(0.1));
    u.noteOn(91, 100, 100 / 127.0f, fr(0.1));
    r.until(0.5);
    u.noteOff(60, fr(0.5), false);
    u.noteOff(91, fr(0.5), false);
    // stop at release + 1.3 x (0.12 x 6.9) = 1.08 s after the note-off
    r.until(1.7);
    REQUIRE(r.sink.ev.size() == 1);
    CHECK(r.sink.ev[0].kind == rig::EventKind::VoiceEnded);
    CHECK(r.sink.ev[0].f.a == 0.0);  // UnitSlot::Inst0
    CHECK(r.sink.ev[0].frame >= fr(0.5 + 0.12 * 6.9 * 1.3) - 128);
    CHECK(r.sink.ev[0].frame <= fr(0.5 + 0.12 * 6.9 * 1.3) + 128);
    CHECK(u.liveVoices() == 1);  // the undamped one rings to the end of its buffer
    r.until(4.0);
    CHECK(u.liveVoices() == 0);
    CHECK(r.sink.ev.size() == 2);
  }

  TEST_CASE("zone table swap: matching instSeq replaces the table, the old one goes back as Garbage") {
    auto c4 = loadWav(fixtures() + "/test-keys/soft/C4.wav", 60);
    rig::SamplerSetup s;
    s.instSeq = 7;
    auto *z0 = new rig::SamplerZones();
    z0->instSeq = 7;
    rig::SamplerInstrument u(s, z0, kSR);
    UnitRig r(u);
    u.noteOn(60, 100, 100 / 127.0f, fr(0.01));
    r.until(0.1);
    CHECK(u.liveVoices() == 0);  // nothing decoded yet: silent, no voice
    auto *z1 = new rig::SamplerZones();
    z1->instSeq = 7;
    z1->layers.push_back({0, 127, {{60, c4.get()}}});
    rig::Command c{};
    c.op = rig::opOf(rig::SamplerOp::Zones);
    c.sub = rig::kSubOwnedPayload;
    c.aux = 7;
    c.p.ptr = static_cast<rig::Owned *>(z1);
    u.apply(c);
    CHECK(u.zones() == z1);
    auto *stale = new rig::SamplerZones();
    stale->instSeq = 8;  // another instance's table
    c.aux = 8;
    c.p.ptr = static_cast<rig::Owned *>(stale);
    u.apply(c);
    CHECK(u.zones() == z1);
    r.quantum();
    int garbage = 0;
    for (const auto &e : r.sink.ev)
      if (e.kind == rig::EventKind::Garbage) {
        ++garbage;
        delete static_cast<rig::Owned *>(e.ptr);
      }
    CHECK(garbage == 2);
    u.noteOn(60, 100, 100 / 127.0f, r.frame);
    CHECK(u.liveVoices() == 1);
  }

  TEST_CASE("bend retunes live and new voices; tone and morph move the tone corner") {
    auto a4 = loadWav(fixtures() + "/test-keys/soft/A4.wav", 69);
    auto *z = new rig::SamplerZones();
    z->layers.push_back({0, 127, {{69, a4.get()}}});
    rig::SamplerInstrument u(rig::SamplerSetup{}, z, kSR);
    CHECK(u.toneHz() == kSR / 2);  // tone 1: Nyquist (exact bypass)
    UnitRig r(u);
    std::vector<float> L;
    u.noteOn(69, 100, 100 / 127.0f, fr(0.05));
    u.setBend(2, fr(0.6));
    r.until(1.2, &L);
    const double f0 = peakHz(L, 0.1, 0.55, 400, 520);
    const double f1 = peakHz(L, 0.7, 1.15, 400, 520);
    INFO("f0 ", f0, " f1 ", f1);
    CHECK(std::fabs(f0 / 440 - 1) < 0.003);
    CHECK(std::fabs(f1 / (440 * std::pow(2, 2 / 12.0)) - 1) < 0.003);
    u.setParam(rig::kSamplerTone, 0.5, 1.2, 0);
    CHECK(u.toneHz() == doctest::Approx(500 * std::sqrt(40.0)));
    rig::Command m{};
    m.op = rig::opOf(rig::SamplerOp::Morph);
    m.f.a = 1;
    m.f.b = 1.3;
    u.apply(m);
    CHECK(u.toneHz() == doctest::Approx(500 * std::pow(40, 0.8)));
    u.setParam(rig::kSamplerRelease, 9, 1.3, 0);
    CHECK(u.paramValue(rig::kSamplerRelease) == 1.5);  // RELEASE_RANGE
    CHECK(rig::samplerParamIndex("tone") == rig::kSamplerTone);
    CHECK(rig::samplerParamIndex("attack") == -1);
  }

  TEST_CASE("audio thread: no allocation while rendering, stealing, bending and swapping tables") {
    auto c4 = loadWav(fixtures() + "/test-keys/loud/C4.wav", 60);
    auto *z = new rig::SamplerZones();
    z->layers.push_back({0, 127, {{60, c4.get()}}});
    rig::SamplerInstrument u(rig::SamplerSetup{}, z, kSR);
    u.setVoiceCap(32);
    UnitRig r(u);
    auto *z2 = new rig::SamplerZones();
    z2->layers.push_back({0, 127, {{60, c4.get()}}});
    const long before = rigtest::g_rtAllocs;
    {
      rig::rt::RenderScope scope;
      for (int i = 0; i < 60; ++i) {
        u.noteOn(40 + (i % 50), 100, 100 / 127.0f, r.frame + 17);
        if (i % 3 == 0) u.noteOff(40 + (i % 50), r.frame + 60, false);
        if (i == 20) u.setBend(-1, r.frame);
        if (i == 30) {
          rig::Command c{};
          c.op = rig::opOf(rig::SamplerOp::Zones);
          c.sub = rig::kSubOwnedPayload;
          c.p.ptr = static_cast<rig::Owned *>(z2);
          u.apply(c);
        }
        r.quantum();
      }
      u.allNotesOff(r.frame);
      for (int i = 0; i < 40; ++i) r.quantum();
    }
    CHECK(rigtest::g_rtAllocs == before);
    for (const auto &e : r.sink.ev)
      if (e.kind == rig::EventKind::Garbage) delete static_cast<rig::Owned *>(e.ptr);
  }

  TEST_CASE("undampedOptIn: undampedFrom defaults and opt-in; damped notes decay after note-off (suites.mjs)") {
    const std::string url = fixtures() + "/test-keys/soft/C4.wav";  // claimed as G6 (91): plays at rate 1
    auto entry = [&](const std::string &id, const std::string &extra) {
      return R"({"id":")" + id + R"(","name":")" + id + R"(","ext":"wav","release":0.12,)" + extra +
             R"("layers":[{"vel":[0,127],"files":{"G6":")" + url + R"("}}]})";
    };
    const std::string factory = "{\"instruments\":[" + entry("f-piano", R"("category":"piano",)") + "," +
                                entry("f-strings", R"("category":"strings",)") + "," +
                                entry("f-piano-off", R"("category":"piano","undampedFrom":null,)") + "]}";
    const std::string user = "{\"instruments\":[" + entry("piano", R"("category":"piano",)") + "," +
                             entry("strings", R"("category":"strings",)") + "," +
                             entry("optin", R"("category":"strings","undampedFrom":90,)") + "]}";
    {
      yyjson_doc *fd = yyjson_read(factory.data(), factory.size(), 0);
      yyjson_doc *ud = yyjson_read(user.data(), user.size(), 0);
      rig::samples::NormalizeOptions fo, uo;
      uo.idPrefix = "user:";
      uo.group = "My Samples";
      uo.secondary = true;
      auto f = rig::samples::normalizeManifest(yyjson_doc_get_root(fd), "/m/manifest.json", fo);
      auto u = rig::samples::normalizeManifest(yyjson_doc_get_root(ud), "/u/manifest.json", uo);
      REQUIRE(f.size() == 3);
      REQUIRE(u.size() == 3);
      CHECK(f[0].undampedFrom == 90);
      CHECK(f[1].undampedFrom == -1);
      CHECK(f[2].undampedFrom == -1);
      CHECK(u[0].undampedFrom == -1);
      CHECK(u[1].undampedFrom == -1);
      CHECK(u[2].undampedFrom == 90);
      CHECK(u[2].id == "user:optin");
      yyjson_doc_free(fd);
      yyjson_doc_free(ud);
    }
    TempApp app("undamped", factory, user);
    auto decay = [&](const std::string &id) {
      Eng e(app.app(), app.userManifest());
      e.use(id);
      e.on(91, 100, 0.1);
      e.off(91, 1.0);
      const auto d = e.render(2.2);
      return db(rms(d, 1.6, 1.9)) - db(rms(d, 0.8, 0.95));  // level after note-off re held
    };
    const double fPiano = decay("f-piano"), fStrings = decay("f-strings"), uPiano = decay("user:piano"),
                 uStrings = decay("user:strings"), uOptIn = decay("user:optin");
    INFO("f-piano ", fPiano, " f-strings ", fStrings, " user:piano ", uPiano, " user:strings ", uStrings,
         " user:optin ", uOptIn);
    CHECK(fPiano > -10);
    CHECK(uOptIn > -10);
    CHECK(fStrings < -30);
    CHECK(uPiano < -30);
    CHECK(uStrings < -30);
  }

  TEST_CASE("slot params: initial tone/release from the patch, slots.<i>.release overrides the release") {
    TempApp app("params", fixtureManifest());
    Eng a(app.app());
    a.use("test-keys", R"(,"release":0.05)");  // seconds to -60 dB at note-off (sustain)
    a.on(60, 100, 0.1);
    a.off(60, 0.5);
    const auto da = a.render(1.0);
    Eng b(app.app());
    b.use("test-keys", R"(,"params":{"release":1.5})");  // tau 1.5 s: still loud 0.3 s after the note-off
    b.on(60, 100, 0.1);
    b.off(60, 0.5);
    const auto dbb = b.render(1.0);
    const double held = db(rms(da, 0.3, 0.45));
    INFO("held ", held, " override ", db(rms(da, 0.6, 0.8)), " long ", db(rms(dbb, 0.6, 0.8)));
    CHECK(db(rms(da, 0.6, 0.8)) < held - 60);
    CHECK(db(rms(dbb, 0.6, 0.8)) > held - 6);
  }

  TEST_CASE("cost per 128-frame block (printed; no timing assertion on a shared box)") {
    auto c4 = loadWav(fixtures() + "/test-keys/loud/C4.wav", 60);
    for (const bool multi : {false, true}) {
      for (const int voices : {1, 16, 64}) {
        auto *z = new rig::SamplerZones();
        z->layers.push_back({0, 127, {{60, c4.get()}}});
        rig::SamplerSetup s;
        s.multiLayer = multi;  // single-layer sets run a per-voice velocity LPF
        rig::SamplerInstrument u(s, z, kSR);
        u.setVoiceCap(128);
        UnitRig r(u);
        for (int i = 0; i < voices; ++i) u.noteOn(50 + i % 20, 100, 100 / 127.0f, 0);
        r.quantum();
        const int blocks = 300;  // 0.87 s: every voice still sounds (the 2.4 s file repitched at most 1.5x)
        const auto t0 = std::chrono::steady_clock::now();
        for (int b = 0; b < blocks; ++b) r.quantum();
        const double us =
            std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / blocks;
        CHECK(u.liveVoices() == static_cast<unsigned>(voices));
        MESSAGE(std::string(multi ? "multi-layer " : "single-layer (voice LPF) "), voices, " voices: ", us,
                " us per 128-frame block (", 100 * us / (128e6 / 48000), " % of a 48 kHz block)");
      }
    }
  }
}
