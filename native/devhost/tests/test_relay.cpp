// The whole dev host in-process (null audio backend, ephemeral port): HTTP routes, the WebSocket relay to the core,
// recording through the relay, page replacement and the panic/rec-stop cleanup for a page that goes away.
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
      CHECK(a.handshake.find("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kK+C5qWlo/YWo4=") != std::string::npos);
      a.text(R"({"v":1,"op":"hello","protocol":1,"app":"test","id":1})");
      const std::string hello = a.until("\"re\":1");
      CHECK(hello.find("\"protocol\":1") != std::string::npos);
      CHECK(hello.find("worship-rig-core") != std::string::npos);
      a.text(R"({"v":1,"op":"audio","action":"start","id":2})");
      CHECK_FALSE(a.until("\"state\":\"running\"").empty());
      CHECK_FALSE(a.until("\"re\":2").empty());
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
      for (auto &f : fs::directory_iterator(dir / "rec")) {
        if (f.path().extension() == ".wav") {
          ++wavs;
          bytes = f.file_size();
        }
      }
      CHECK(wavs == 1);
      CHECK(bytes > 44 + 4 * 48000 / 4);  // > 0.25 s of 16-bit stereo at 48 kHz

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
