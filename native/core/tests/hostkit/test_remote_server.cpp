// Remote server (remote lane, D45; REMOTE.md §2.4) over real loopback sockets: the page, pairing, state (plain and
// long poll), commands, WebSocket, Lock, limits, timeouts, stop. Every request is raw bytes, as a phone would send.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "doctest.h"
#include "remote_net.h"
#include "remote_server.h"
#include "rig/rig_hostkit.h"
#include "rig/rig_remote.h"

using namespace rig::hostkit::remote;

namespace {

std::int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

int connectTo(std::uint16_t port) {
  const int fd = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  REQUIRE(connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) == 0);
  return fd;
}

void sendAll(int fd, const std::string &s) {
  std::size_t off = 0;
  while (off < s.size()) {
    const ssize_t n = send(fd, s.data() + off, s.size() - off, 0);
    if (n <= 0) return;
    off += static_cast<std::size_t>(n);
  }
}

/** Read until the peer closes or `ms` pass. */
std::string readAll(int fd, int ms = 3000) {
  std::string out;
  const std::int64_t end = nowMs() + ms;
  char buf[4096];
  while (nowMs() < end) {
    pollfd p{fd, POLLIN, 0};
    if (poll(&p, 1, 50) <= 0) continue;
    const ssize_t n = recv(fd, buf, sizeof buf, 0);
    if (n <= 0) break;
    out.append(buf, static_cast<std::size_t>(n));
  }
  return out;
}

/** Read until `needle` appears (or `ms` pass); keeps the connection open. */
std::string readUntil(int fd, const std::string &needle, int ms = 3000) {
  std::string out;
  const std::int64_t end = nowMs() + ms;
  char buf[4096];
  while (nowMs() < end && out.find(needle) == std::string::npos) {
    pollfd p{fd, POLLIN, 0};
    if (poll(&p, 1, 50) <= 0) continue;
    const ssize_t n = recv(fd, buf, sizeof buf, 0);
    if (n <= 0) break;
    out.append(buf, static_cast<std::size_t>(n));
  }
  return out;
}

const char *kHost = "127.0.0.1:8450";

std::string request(std::uint16_t port, const std::string &raw) {
  const int fd = connectTo(port);
  sendAll(fd, raw);
  std::string r = readAll(fd);
  close(fd);
  return r;
}
std::string get(std::uint16_t port, const std::string &path, const std::string &token = "",
                const std::string &host = kHost) {
  std::string raw = "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\n";
  if (!token.empty()) raw += "X-Rig-Token: " + token + "\r\n";
  return request(port, raw + "\r\n");
}
std::string post(std::uint16_t port, const std::string &path, const std::string &body, const std::string &token = "",
                 const std::string &origin = "") {
  std::string raw = "POST " + path + " HTTP/1.1\r\nHost: " + std::string(kHost) + "\r\nContent-Type: application/json\r\n"
                    + "Content-Length: " + std::to_string(body.size()) + "\r\n";
  if (!token.empty()) raw += "X-Rig-Token: " + token + "\r\n";
  if (!origin.empty()) raw += "Origin: " + origin + "\r\n";
  return request(port, raw + "\r\n" + body);
}
int status(const std::string &resp) { return resp.size() > 12 ? std::stoi(resp.substr(9, 3)) : 0; }
std::string bodyOf(const std::string &resp) {
  const auto i = resp.find("\r\n\r\n");
  return i == std::string::npos ? "" : resp.substr(i + 4);
}

std::string state(const std::string &extra = "") {
  return R"({"v":1,"current":{"id":"a","name":"Way Maker","key":"E"},"modes":[],"master":1,"masterDb":0,)"
         R"("droneOn":false,"droneKey":"E","audio":"running","latencyMs":5,"midi":{"connected":false,"name":null},)"
         R"("lowResource":false,"recording":false,"windowVisible":true,"memoryMB":null)"
         + extra + "}";
}

/** A masked client text frame. */
std::string frame(const std::string &payload, std::uint8_t first = 0x81) {
  std::string f;
  f += static_cast<char>(first);
  if (payload.size() < 126) {
    f += static_cast<char>(0x80 | payload.size());
  } else {
    f += static_cast<char>(0x80 | 126);
    f += static_cast<char>(payload.size() >> 8);
    f += static_cast<char>(payload.size() & 0xFF);
  }
  const char m[4] = {0x12, 0x34, 0x56, 0x78};
  f.append(m, 4);
  for (std::size_t i = 0; i < payload.size(); ++i) f += static_cast<char>(payload[i] ^ m[i & 3]);
  return f;
}

/** Text payloads of the server frames in `bytes` (after the 101 head). */
std::vector<std::string> serverTexts(const std::string &bytes, std::vector<int> *closeCodes = nullptr) {
  std::vector<std::string> out;
  std::size_t i = bytes.find("\r\n\r\n");
  i = i == std::string::npos ? 0 : i + 4;
  while (i + 2 <= bytes.size()) {
    const auto op = static_cast<std::uint8_t>(bytes[i]) & 0x0F;
    std::size_t len = static_cast<std::uint8_t>(bytes[i + 1]) & 0x7F, hdr = 2;
    if (len == 126) {
      if (i + 4 > bytes.size()) break;
      len = (static_cast<std::size_t>(static_cast<std::uint8_t>(bytes[i + 2])) << 8)
            | static_cast<std::uint8_t>(bytes[i + 3]);
      hdr = 4;
    }
    if (i + hdr + len > bytes.size()) break;
    const std::string payload = bytes.substr(i + hdr, len);
    if (op == 0x1) out.push_back(payload);
    if (op == 0x8 && closeCodes && payload.size() >= 2) {
      closeCodes->push_back((static_cast<std::uint8_t>(payload[0]) << 8) | static_cast<std::uint8_t>(payload[1]));
    }
    i += hdr + len;
  }
  return out;
}

struct Fixture {
  std::mutex mu;
  std::vector<std::string> commands;
  std::atomic<int> infos{0};
  Server server;
  explicit Fixture(ServerTimeouts to = {})
      : server(ServerHooks{[this](const std::string &c) {
                             std::lock_guard<std::mutex> g(mu);
                             commands.push_back(c);
                           },
                           [this] { ++infos; }},
               Limits{}, to) {
    StartOptions o;
    o.bind = "127.0.0.1";
    o.anyPort = true;
    std::string err;
    REQUIRE(server.start(o, &err));
    REQUIRE(server.port() > 0);
  }
  std::uint16_t port() { return server.port(); }
  std::string code() {
    const std::string j = server.infoJson();
    const auto i = j.find("\"code\":\"");
    return j.substr(i + 8, 6);
  }
  std::string pair() {
    const std::string r = post(port(), "/api/pair", "{\"code\":\"" + code() + "\"}");
    REQUIRE(status(r) == 200);
    const std::string b = bodyOf(r);
    return b.substr(10, 32);  // {"token":"<32 hex>"}
  }
  std::vector<std::string> takeCommands(int waitMs = 1000) {
    const std::int64_t end = nowMs() + waitMs;
    for (;;) {
      {
        std::lock_guard<std::mutex> g(mu);
        if (!commands.empty() || nowMs() > end) {
          std::vector<std::string> c;
          c.swap(commands);
          return c;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
  }
};

}  // namespace

TEST_SUITE("hostkit-remote-server") {
  TEST_CASE("the page: 503 until set, then the HTML with a strict CSP; HEAD; 404 elsewhere; no CORS") {
    Fixture f;
    CHECK(status(get(f.port(), "/")) == 503);
    f.server.setPage("<!doctype html><p>remote</p>");
    const std::string r = get(f.port(), "/");
    CHECK(status(r) == 200);
    CHECK(bodyOf(r) == "<!doctype html><p>remote</p>");
    CHECK(r.find("Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline';") != std::string::npos);
    CHECK(r.find("connect-src 'self' ws://127.0.0.1:8450;") != std::string::npos);
    CHECK(r.find("text/html; charset=utf-8") != std::string::npos);
    const std::string h = request(f.port(), "HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    CHECK(status(h) == 200);
    CHECK(bodyOf(h).empty());
    CHECK(status(get(f.port(), "/index.html")) == 200);
    CHECK(status(get(f.port(), "/favicon.ico")) == 204);
    CHECK(status(get(f.port(), "/../etc/passwd")) == 404);
    CHECK(status(get(f.port(), "/api/nope")) == 404);
    CHECK(status(request(f.port(), "OPTIONS /api/cmd HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.com\r\n\r\n"))
          == 405);
    CHECK(status(request(f.port(), "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n")) == 501);
    CHECK(status(request(f.port(), "GARBAGE\r\n\r\n")) == 400);
  }

  TEST_CASE("DNS rebinding and cross-site: Host and Origin are checked") {
    Fixture f;
    f.server.setPage("x");
    CHECK(status(get(f.port(), "/", "", "evil.example:8450")) == 403);
    CHECK(status(get(f.port(), "/", "", "mac.local:8450")) == 200);
    CHECK(status(post(f.port(), "/api/pair", "{\"code\":\"" + f.code() + "\"}", "", "http://evil.example")) == 403);
    CHECK(status(post(f.port(), "/api/pair", "{\"code\":\"" + f.code() + "\"}", "", "null")) == 403);
    CHECK(status(post(f.port(), "/api/pair", "{\"code\":\"" + f.code() + "\"}", "", "http://127.0.0.1:8450")) == 200);
    CHECK(status(get(f.port(), "/api/pair")) == 405);
    // skeptic-2 N3: JSON only (a cross-site form can only send text/plain, urlencoded or multipart)
    const std::string form = "POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\n"
                             "Content-Length: 17\r\n\r\n{\"code\":\"123456\"}";
    CHECK(status(request(f.port(), form)) == 415);
    CHECK(f.server.infoJson().find("\"pairingSec\":300") != std::string::npos);  // switched on: pairing open
    CHECK(status(post(f.port(), "/api/state", "{}")) == 405);
  }

  TEST_CASE("pairing, state and commands over HTTP; Lock; the info hook") {
    Fixture f;
    const int infos0 = f.infos.load();
    CHECK(status(post(f.port(), "/api/pair", "{\"code\":\"abc\"}")) == 400);
    const std::string wrong = f.code() == "000000" ? "000001" : "000000";
    CHECK(status(post(f.port(), "/api/pair", "{\"code\":\"" + wrong + "\"}")) == 403);
    const std::string tok = f.pair();
    CHECK(tok.size() == 32);
    CHECK(f.infos.load() > infos0);  // Settings shows the paired count
    CHECK(f.server.infoJson().find("\"paired\":1") != std::string::npos);
    CHECK(status(get(f.port(), "/api/state")) == 401);
    CHECK(status(get(f.port(), "/api/state", std::string(32, 'f'))) == 401);
    CHECK(bodyOf(get(f.port(), "/api/state", tok)) == R"({"seq":0,"ready":false})");
    CHECK_FALSE(f.server.publishState("{\"v\":1}"));
    REQUIRE(f.server.publishState(state()));
    CHECK(bodyOf(get(f.port(), "/api/state", tok)).find(R"("seq":1,"ready":true,"song":"Way Maker")") == 1);
    const std::string c = post(f.port(), "/api/cmd", R"({"cmd":"nextSong","id":"c1"})", tok);
    CHECK(status(c) == 200);
    CHECK(bodyOf(c) == R"({"id":"c1","ok":true})");
    auto cmds = f.takeCommands();
    REQUIRE(cmds.size() == 1);
    CHECK(cmds[0] == R"({"v":1,"type":"nextSong","via":"remote"})");
    CHECK(status(post(f.port(), "/api/cmd", R"({"cmd":"nextSong","id":"c1"})", tok)) == 200);  // a retry
    CHECK(f.takeCommands(300).empty());  // ...runs nothing
    CHECK(status(post(f.port(), "/api/cmd", R"({"cmd":"panic","id":"c2"})")) == 401);
    // Lock
    REQUIRE(f.server.publishState(state(R"(,"locked":true)")));
    CHECK(bodyOf(post(f.port(), "/api/cmd", R"({"cmd":"prevSong","id":"c3"})", tok))
          == R"({"id":"c3","ok":false,"error":"locked"})");
    CHECK(f.takeCommands(300).empty());
    CHECK(bodyOf(post(f.port(), "/api/cmd", R"({"cmd":"panic","id":"c4"})", tok)) == R"({"id":"c4","ok":true})");
    cmds = f.takeCommands();
    REQUIRE(cmds.size() == 1);
    CHECK(cmds[0] == R"({"v":1,"type":"panic","via":"remote"})");
    // a body in pieces, and one too large
    const int fd = connectTo(f.port());
    const std::string body = R"({"cmd":"panic","id":"c5"})";
    sendAll(fd, "POST /api/cmd HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Rig-Token: " + tok
                    + "\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body.substr(0, 5));
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    sendAll(fd, body.substr(5));
    CHECK(bodyOf(readAll(fd)) == R"({"id":"c5","ok":true})");
    close(fd);
    CHECK(status(post(f.port(), "/api/cmd", std::string(2000, 'x'), tok)) == 431);  // Content-Length > 1 KB
  }

  TEST_CASE("long poll: held until the view changes, or answered at the deadline") {
    ServerTimeouts to;
    to.longPollMs = 700;
    Fixture f(to);
    const std::string tok = f.pair();
    REQUIRE(f.server.publishState(state()));
    std::string got;
    std::int64_t took = 0;
    std::thread t([&] {
      const std::int64_t t0 = nowMs();
      got = get(f.port(), "/api/state?since=1", tok);
      took = nowMs() - t0;
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    REQUIRE(f.server.publishState(state().replace(state().find("Way Maker"), 9, "Holy Forever")));
    t.join();
    CHECK(bodyOf(got).find(R"("seq":2,"ready":true,"song":"Holy Forever")") == 1);
    CHECK(took >= 150);
    CHECK(took < 650);
    const std::int64_t t0 = nowMs();
    const std::string idle = get(f.port(), "/api/state?since=2", tok);
    CHECK(nowMs() - t0 >= 600);
    CHECK(bodyOf(idle).find(R"("seq":2)") == 1);  // the same view at the deadline
    CHECK(bodyOf(get(f.port(), "/api/state?since=1", tok)).find(R"("seq":2)") == 1);  // behind: answered at once
  }

  TEST_CASE("WebSocket: upgrade, auth, view pushes, commands and acks, ping, forgetAll closes it") {
    Fixture f;
    const std::string tok = f.pair();
    REQUIRE(f.server.publishState(state()));
    const int fd = connectTo(f.port());
    sendAll(fd, "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:8450\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Origin: http://127.0.0.1:8450\r\nSec-WebSocket-Version: 13\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    std::string in = readUntil(fd, "\r\n\r\n");
    CHECK(in.rfind("HTTP/1.1 101 Switching Protocols\r\n", 0) == 0);
    CHECK(in.find("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n") != std::string::npos);
    sendAll(fd, frame("{\"auth\":\"" + tok + "\"}"));
    in += readUntil(fd, "Way Maker");
    auto texts = serverTexts(in);
    REQUIRE(texts.size() == 1);
    CHECK(texts[0].find(R"({"seq":1,"ready":true,"song":"Way Maker")") == 0);
    sendAll(fd, frame(R"({"cmd":"nextSnapshot","id":"w1"})"));
    in += readUntil(fd, "\"w1\"");
    auto cmds = f.takeCommands();
    REQUIRE(cmds.size() == 1);
    CHECK(cmds[0] == R"({"v":1,"type":"nextScene","via":"remote"})");
    REQUIRE(f.server.publishState(state(R"(,"scene":{"n":0,"count":2,"name":"Verse"})")));
    in += readUntil(fd, "Verse");
    sendAll(fd, frame("{\"ping\":1}"));
    in += readUntil(fd, "pong");
    texts = serverTexts(in);
    REQUIRE(texts.size() == 4);
    CHECK(texts[1] == R"({"id":"w1","ok":true})");
    CHECK(texts[2].find(R"("snapshot":"Verse","snapshotN":0,"snapshotCount":2)") != std::string::npos);
    CHECK(texts[3] == R"({"pong":1})");
    f.server.forgetAll();
    const std::string rest = readAll(fd, 1500);
    std::vector<int> codes;
    serverTexts("\r\n\r\n" + rest, &codes);
    REQUIRE(codes.size() == 1);
    CHECK(codes[0] == 4001);
    close(fd);
    CHECK(status(get(f.port(), "/api/state", tok)) == 401);
  }

  TEST_CASE("WebSocket: a wrong token, no auth in time, a binary frame, a cross-site upgrade") {
    ServerTimeouts to;
    to.wsAuthMs = 300;
    Fixture f(to);
    const std::string up = "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
    auto closeCode = [&](const std::string &extraHead, const std::string &after) {
      const int fd = connectTo(f.port());
      sendAll(fd, up + extraHead + "\r\n");
      readUntil(fd, "\r\n\r\n");
      if (!after.empty()) sendAll(fd, after);
      std::vector<int> codes;
      serverTexts("\r\n\r\n" + readAll(fd, 1500), &codes);
      close(fd);
      return codes.empty() ? 0 : codes[0];
    };
    CHECK(closeCode("", frame("{\"auth\":\"" + std::string(32, 'a') + "\"}")) == 4001);
    CHECK(closeCode("", frame("not json")) == 4001);
    CHECK(closeCode("", "") == 4001);  // nothing within wsAuthMs
    const std::string tok = f.pair();
    CHECK(closeCode("", frame("{\"auth\":\"" + tok + "\"}") + frame("x", 0x82)) == 1003);
    CHECK(closeCode("", frame(std::string(5000, 'a'))) == 1009);
    CHECK(status(request(f.port(), up + "Origin: http://evil.example\r\n\r\n")) == 403);
  }

  TEST_CASE("an evicted pairing (the 9th phone) closes its WebSocket and fails its long poll (skeptic-2 C10)") {
    ServerTimeouts to;
    to.longPollMs = 5000;
    Fixture f(to);
    REQUIRE(f.server.publishState(state()));
    const std::string first = f.pair();
    const int fd = connectTo(f.port());
    sendAll(fd, "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    readUntil(fd, "\r\n\r\n");
    sendAll(fd, frame("{\"auth\":\"" + first + "\"}"));
    readUntil(fd, "Way Maker");
    for (int i = 0; i < 8; ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      f.pair();  // 8 more: `first` (least recently used) is dropped
    }
    std::vector<int> codes;
    serverTexts("\r\n\r\n" + readAll(fd, 1500), &codes);
    close(fd);
    REQUIRE(codes.size() == 1);
    CHECK(codes[0] == 4001);
    CHECK(status(get(f.port(), "/api/state", first)) == 401);
  }

  TEST_CASE("connection limits: 4 per IP; eviction after a grace; an idle HTTP connection is dropped") {
    Fixture f;
    f.server.setPage("x");
    std::vector<int> fds;
    for (int i = 0; i < 4; ++i) fds.push_back(connectTo(f.port()));
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    // skeptic-2 G1: inside the grace nobody is evicted: the newcomer is refused
    const int early = connectTo(f.port());
    sendAll(early, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    CHECK(readAll(early, 600).empty());
    close(early);
    std::this_thread::sleep_for(std::chrono::milliseconds(1500));
    // skeptic-2 F8: the 5th from the same IP takes the oldest idle one's place instead of being refused
    const int fifth = connectTo(f.port());
    sendAll(fifth, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    CHECK(status(readAll(fifth, 1500)) == 200);
    close(fifth);
    CHECK(readAll(fds[0], 300).empty());  // the oldest was closed
    // the rest say nothing: dropped at the first-byte deadline (3 s from their connect), long before httpMs (15 s)
    const std::int64_t t0 = nowMs();
    for (std::size_t i = 1; i < fds.size(); ++i) CHECK(readAll(fds[i], 5000).empty());
    CHECK(nowMs() - t0 < 2500);
    for (int fd : fds) close(fd);
    CHECK(status(get(f.port(), "/")) == 200);
  }

  TEST_CASE("request rate limit per IP") {
    Fixture f;
    f.server.setPage("x");
    int limited = 0;
    for (int i = 0; i < 80; ++i) limited += status(get(f.port(), "/")) == 429 ? 1 : 0;
    CHECK(limited >= 10);  // the burst is 60, refilled at 30/s while the loop runs
  }

  TEST_CASE("stop: the port closes, every pairing ends, the code rolls; start again works") {
    Fixture f;
    const std::string tok = f.pair();
    const std::string code = f.code();
    const std::uint16_t port = f.port();
    f.server.stop();
    CHECK_FALSE(f.server.running());
    CHECK(f.server.infoJson().find("\"on\":false") != std::string::npos);
    CHECK(f.server.infoJson().find("\"paired\":0") != std::string::npos);
    CHECK(f.code() != code);
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    CHECK(connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) != 0);
    close(fd);
    StartOptions o;
    o.bind = "127.0.0.1";
    o.anyPort = true;
    std::string err;
    REQUIRE(f.server.start(o, &err));
    CHECK(status(get(f.port(), "/api/state", tok)) == 401);
    f.server.stop();
    f.server.stop();  // idempotent
  }

  TEST_CASE("QR: a version-sized square of modules; info JSON shape") {
    const std::string q = qrJson("http://192.168.1.20:8450/#p=123456");
    const auto size = std::stoi(q.substr(8));
    CHECK(size >= 21);
    CHECK((size - 17) % 4 == 0);
    const auto m0 = q.find("\"modules\":\"") + 11;
    const auto m1 = q.find('"', m0);
    CHECK(m1 - m0 == static_cast<std::size_t>(size * size));
    CHECK(q.substr(m0, 7) == "1111111");  // a finder pattern's top row
    Fixture f;
    const std::string j = f.server.infoJson();
    CHECK(j.find("\"on\":true") != std::string::npos);
    CHECK(j.find("\"port\":" + std::to_string(f.port())) != std::string::npos);
    CHECK(j.find("\"addresses\":[") != std::string::npos);
  }

  TEST_CASE("C API: create, start on a port, state, info, stop, destroy") {
    struct Ctx {
      std::atomic<int> cmds{0}, infos{0};
    } ctx;
    rig_remote *r = rig_remote_create([](void *c, const char *) { ++static_cast<Ctx *>(c)->cmds; },
                                      [](void *c) { ++static_cast<Ctx *>(c)->infos; }, &ctx);
    REQUIRE(r);
    rig_remote_set_page(r, "<p>x</p>", 8);
    char *err = nullptr;
    CHECK(rig_remote_start(r, 70000, &err) == -1);
    REQUIRE(err);
    rig_hostkit_free(err);
    const int port = rig_remote_start(r, 0, &err);
    if (port < 0) {  // 8450..8459 all busy on this machine: not this code's fault
      rig_hostkit_free(err);
      rig_remote_destroy(r);
      return;
    }
    CHECK(port >= 8450);
    CHECK(port <= 8459);
    CHECK(rig_remote_start(r, 0, nullptr) == port);  // already running
    const std::string s = state();
    CHECK(rig_remote_publish_state(r, s.data(), s.size()) == 1);
    CHECK(rig_remote_publish_state(r, "{}", 2) == 0);
    char *info = rig_remote_info_json(r);
    REQUIRE(info);
    CHECK(std::string(info).find("\"on\":true") != std::string::npos);
    rig_hostkit_free(info);
    rig_remote_new_code(r);
    rig_remote_forget_all(r);
    CHECK(ctx.infos.load() >= 3);
    rig_remote_stop(r);
    rig_remote_destroy(r);
    rig_remote_destroy(nullptr);
  }
}
