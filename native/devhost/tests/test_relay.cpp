// The whole dev host in-process (null audio backend, ephemeral port): HTTP routes, the WebSocket relay to the core,
// recording through the relay, page replacement and the panic/rec-stop cleanup for a page that goes away.
#include <unistd.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>

#include "devhost.h"
#include "doctest.h"
#include "util.h"

namespace fs = std::filesystem;

namespace {

struct Running {
  fs::path dir;
  devhost::Devhost *host = nullptr;
  std::thread th;
  explicit Running(devhost::Devhost &h) : host(&h) {
    th = std::thread([this] { host->run(); });
  }
  ~Running() {
    host->stop();
    th.join();
    host->close();
  }
};

std::string slurp(const fs::path &p) {
  std::ifstream f(p);
  std::ostringstream s;
  s << f.rdbuf();
  return s.str();
}

}  // namespace

TEST_SUITE("devhost-relay") {
  TEST_CASE("HTTP: app files, main.js import swapped, contract, api stubs, traversal refused") {
    devhost::DevhostOptions o;
    o.port = 0;
    o.repoDir = DEVHOST_REPO_DIR;
    o.recordingsDir.clear();
    o.audio.backend = "null";
    devhost::Devhost h(o);
    std::string err;
    REQUIRE_MESSAGE(h.open(&err), err);
    Running run(h);
    const auto port = h.port();
    std::string r = dht::httpGet(port, "/");
    CHECK(r.rfind("HTTP/1.1 200", 0) == 0);
    CHECK(r.find("text/html") != std::string::npos);
    r = dht::httpGet(port, "/js/main.js");
    CHECK(r.find(devhost::kMainDevhost) != std::string::npos);
    CHECK(r.find(devhost::kMainNeedle) == std::string::npos);
    r = dht::httpGet(port, "/__bridge/engine-api.json");
    CHECK(r.find("\"messages\"") != std::string::npos);
    r = dht::httpGet(port, "/api/health");
    CHECK(r.find("\"userSamples\":false") != std::string::npos);
    CHECK(dht::httpGet(port, "/api/heartbeat").rfind("HTTP/1.1 204", 0) == 0);
    CHECK(dht::httpGet(port, "/../native/core/README.md").rfind("HTTP/1.1 404", 0) == 0);
    CHECK(dht::httpGet(port, "/%2e%2e/package.json").rfind("HTTP/1.1 404", 0) == 0);
    CHECK(dht::httpGet(port, "/__rig/ws").rfind("HTTP/1.1 400", 0) == 0);  // not an upgrade
    CHECK(dht::httpGet(port, "/api/other").find("not served by rig-devhost") != std::string::npos);
  }

  TEST_CASE("HTTP: --user-samples serves the patch packs (lane N1): health flags, /api/user-patches, no pack = off") {
    const fs::path dir = fs::temp_directory_path() / ("rig devhost packs \xC3\x84-" + std::to_string(::getpid()));
    fs::remove_all(dir);
    fs::create_directories(dir / "Bank Pack" / "songs");
    std::ofstream(dir / "Bank Pack" / "pack.json") << R"({"mode":"bank"})";
    std::ofstream(dir / "Bank Pack" / "songs" / "lantern.json")
        << R"({"app":"worship-rig","kind":"song","schema":2,"song":{"name":"Lantern","patch":{}},"bank":{"title":"L"}})";
    fs::create_directories(dir / "empty");
    devhost::DevhostOptions o;
    o.port = 0;
    o.repoDir = DEVHOST_REPO_DIR;
    o.recordingsDir.clear();
    o.audio.backend = "null";
    o.userSamples = {dir.string(), (dir / "missing").string()};
    devhost::Devhost h(o);
    std::string err;
    REQUIRE_MESSAGE(h.open(&err), err);
    {
      Running run(h);
      const auto port = h.port();
      std::string r = dht::httpGet(port, "/api/health");
      CHECK(r.find(R"("userSamples":true,"userPatches":true,"features":["user-samples","user-patches"])") !=
            std::string::npos);
      r = dht::httpGet(port, "/api/user-patches");
      CHECK(r.rfind("HTTP/1.1 200", 0) == 0);
      CHECK(r.find(R"({"app":"worship-rig","kind":"user-patches","enabled":true,"patches":[{"packId":"Bank Pack:lantern.json")") !=
            std::string::npos);
      CHECK(r.find(R"("mode":"bank")") != std::string::npos);
      r = dht::httpGet(port, "/api/user-samples");
      CHECK(r.find("\"dir\":\"" + dir.string() + "\"") != std::string::npos);
      fs::remove_all(dir / "Bank Pack");  // the flag follows the folder (no cache)
      CHECK(dht::httpGet(port, "/api/health").find(R"("userPatches":false,"features":["user-samples"])") !=
            std::string::npos);
    }
    fs::remove_all(dir);
    devhost::DevhostOptions off;
    off.port = 0;
    off.repoDir = DEVHOST_REPO_DIR;
    off.recordingsDir.clear();
    off.audio.backend = "null";
    devhost::Devhost h2(off);
    REQUIRE_MESSAGE(h2.open(&err), err);
    Running run2(h2);
    CHECK(dht::httpGet(h2.port(), "/api/user-patches").find(R"("enabled":false,"patches":[])") != std::string::npos);
  }

  TEST_CASE("WebSocket: hello, audio start, ticks, a take recorded, replaced page cleaned up") {
    const fs::path dir = fs::temp_directory_path() / ("devhost-relay-" + std::to_string(::getpid()));
    fs::remove_all(dir);
    fs::create_directories(dir);
    devhost::DevhostOptions o;
    o.port = 0;
    o.repoDir = DEVHOST_REPO_DIR;
    o.recordingsDir = (dir / "rec").string();
    o.logPath = (dir / "log.jsonl").string();
    o.audio.backend = "null";
    o.seed = 3;
    devhost::Devhost h(o);
    std::string err;
    REQUIRE_MESSAGE(h.open(&err), err);
    {
      Running run(h);
      dht::WsClient a;
      REQUIRE(a.open(h.port()));
      CHECK(a.handshake.find("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") != std::string::npos);
      a.text(R"({"v":1,"op":"hello","protocol":1,"app":"test","id":1})");
      const std::string hello = a.until("\"re\":1");
      CHECK(hello.find("\"protocol\":1") != std::string::npos);
      CHECK(hello.find("worship-rig-core") != std::string::npos);
      a.text(R"({"v":1,"op":"audio","action":"start","id":2})");
      CHECK_FALSE(a.until("\"re\":2").empty());  // the reply precedes the device's `running` (G9 order)
      CHECK_FALSE(a.until("\"state\":\"running\"").empty());
      CHECK_FALSE(a.until("\"ev\":\"tick\"").empty());
      // a batch (JSON array) goes through rig_post unchanged
      a.text(R"([{"v":1,"op":"get","what":"stats","id":3},{"v":1,"op":"get","what":"state","id":4}])");
      CHECK_FALSE(a.until("\"re\":4").empty());
      // a ping is answered with a pong carrying the same payload
      dht::sendAll(a.fd, dht::clientFrame(devhost::WsOp::Ping, "pp"));
      bool pong = false;
      for (int i = 0; i < 200 && !pong; ++i) {
        auto f = a.next(2000);
        if (f.op == 0xA) pong = f.payload == "pp";
        if (f.op < 0) break;
      }
      CHECK(pong);
      // a page with a foreign Origin is refused (403) and does not replace the active page
      {
        dht::WsClient evil;
        CHECK_FALSE(evil.open(h.port(), "/__rig/ws", "Origin: https://evil.example\r\n"));
        CHECK(evil.handshake.rfind("HTTP/1.1 403", 0) == 0);
        CHECK(h.serverStats().pages == 1);
      }
      // a sounding test voice, so the take below is not silence (T09 review: it used to record zeros only)
      a.text(R"({"v":1,"op":"prepare","id":7,"patch":{"slots":[{"instrument":{"type":"test","id":"sine"},)"
             R"("gain":1,"params":{"attack":0.002,"release":0.05}},null,null,null]}})");
      CHECK_FALSE(a.until("\"re\":7").empty());
      a.text(R"({"v":1,"op":"commit","id":8,"token":1})");
      CHECK(a.until("\"re\":8").find("\"committed\":true") != std::string::npos);
      a.text(R"({"v":1,"op":"play","e":"on","n":69,"vel":100,"id":9})");
      CHECK_FALSE(a.until("\"re\":9").empty());
      // a take through the relay: the recordings folder of the dev host, a valid WAV with audio frames
      a.text(R"({"v":1,"op":"rec","action":"start","id":5})");
      const std::string started = a.until("\"re\":5");
      CHECK(started.find("\"ok\":true") != std::string::npos);
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      a.text(R"({"v":1,"op":"rec","action":"stop","id":6})");
      const std::string stopped = a.until("\"re\":6");
      CHECK(stopped.find("\"seconds\":") != std::string::npos);
      std::size_t wavs = 0;
      std::uintmax_t bytes = 0;
      fs::path wav;
      for (auto &f : fs::directory_iterator(dir / "rec")) {
        if (f.path().extension() == ".wav") {
          ++wavs;
          bytes = f.file_size();
          wav = f.path();
        }
      }
      CHECK(wavs == 1);
      CHECK(bytes > 44 + 4 * 48000 / 4);  // > 0.25 s of 16-bit stereo at 48 kHz
      // the A4 is in the file on both channels (16-bit stereo after the 44-byte header)
      const std::string pcm = wavs == 1 ? slurp(wav) : std::string();
      int peakL = 0, peakR = 0;
      for (std::size_t i = 44; i + 3 < pcm.size(); i += 4) {
        const auto s16 = [&](std::size_t k) {
          return static_cast<std::int16_t>(static_cast<unsigned char>(pcm[k]) |
                                           (static_cast<unsigned char>(pcm[k + 1]) << 8));
        };
        peakL = std::max(peakL, std::abs(static_cast<int>(s16(i))));
        peakR = std::max(peakR, std::abs(static_cast<int>(s16(i + 2))));
      }
      CHECK(peakL > 300);  // > -40 dBFS
      CHECK(peakR > 300);

      // a second page replaces the first: close 4000 to the old one, panic + rec stop posted for it
      dht::WsClient b;
      REQUIRE(b.open(h.port()));
      a.until("never-arrives", 3000);
      CHECK(a.lastClose.size() >= 2);
      if (a.lastClose.size() >= 2) {
        CHECK(((static_cast<unsigned char>(a.lastClose[0]) << 8) | static_cast<unsigned char>(a.lastClose[1])) ==
              4000);
      }
      b.text(R"({"v":1,"op":"hello","protocol":1,"app":"test2","id":1})");
      CHECK_FALSE(b.until("\"re\":1").empty());
      CHECK(h.serverStats().pages == 2);
    }
    const std::string log = slurp(dir / "log.jsonl");
    CHECK(log.find(R"({"v":1,"op":"play","e":"panic"})") != std::string::npos);
    CHECK(log.find("\"dir\":\"in\"") != std::string::npos);
    CHECK(log.find("\"dir\":\"out\"") != std::string::npos);
    fs::remove_all(dir);
  }
}
