// HTTP request parsing, safe static path resolution, MIME types.
#include <filesystem>
#include <fstream>

#include "doctest.h"
#include "http.h"

using devhost::parseHttpRequest;

TEST_SUITE("devhost-http") {
  TEST_CASE("request head: incomplete, complete, headers lower-cased, query split, percent-decoded path") {
    bool complete = true;
    std::size_t len = 0;
    CHECK_FALSE(parseHttpRequest("GET / HTTP/1.1\r\nHost: x\r\n", &complete, &len));
    CHECK_FALSE(complete);
    auto r = parseHttpRequest("GET /js/a%20b.js?x=1&y HTTP/1.1\r\nHost: x\r\nX-Thing:  v  \r\n\r\nBODY", &complete,
                              &len);
    REQUIRE(r);
    CHECK(complete);
    CHECK(r->method == "GET");
    CHECK(r->path == "/js/a b.js");
    CHECK(r->query == "x=1&y");
    CHECK(r->header("x-thing") == "v");
    CHECK(len == std::string("GET /js/a%20b.js?x=1&y HTTP/1.1\r\nHost: x\r\nX-Thing:  v  \r\n\r\n").size());
  }

  TEST_CASE("malformed heads are refused") {
    bool complete = false;
    CHECK_FALSE(parseHttpRequest("GET\r\n\r\n", &complete, nullptr));
    CHECK(complete);
    CHECK_FALSE(parseHttpRequest("GET nope HTTP/1.1\r\n\r\n", &complete, nullptr));
    CHECK_FALSE(parseHttpRequest("GET /%zz HTTP/1.1\r\n\r\n", &complete, nullptr));
    CHECK_FALSE(parseHttpRequest("GET /%00 HTTP/1.1\r\n\r\n", &complete, nullptr));
    CHECK_FALSE(parseHttpRequest("GET / FTP/1.0\r\n\r\n", &complete, nullptr));
    CHECK_FALSE(parseHttpRequest("GET / HTTP/1.1\r\nno colon\r\n\r\n", &complete, nullptr));
  }

  TEST_CASE("WebSocket upgrade detection (token lists, case, version)") {
    bool c = false;
    auto r = parseHttpRequest(
        "GET /__rig/ws HTTP/1.1\r\nConnection: keep-alive, Upgrade\r\nUpgrade: WebSocket\r\n"
        "Sec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n",
        &c, nullptr);
    REQUIRE(r);
    CHECK(r->isWebSocketUpgrade());
    r = parseHttpRequest("GET /__rig/ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", &c, nullptr);
    REQUIRE(r);
    CHECK_FALSE(r->isWebSocketUpgrade());  // no key
  }

  TEST_CASE("static paths stay inside the root (.., symlinks, backslashes, directories)") {
    namespace fs = std::filesystem;
    const fs::path root = fs::temp_directory_path() / ("devhost-http-" + std::to_string(::getpid()));
    fs::remove_all(root);
    fs::create_directories(root / "app" / "js");
    std::ofstream(root / "app" / "index.html") << "i";
    std::ofstream(root / "app" / "js" / "m.js") << "m";
    std::ofstream(root / "secret.txt") << "s";
    fs::create_symlink(root / "secret.txt", root / "app" / "link.txt");
    const std::string app = (root / "app").string();
    CHECK(devhost::resolveStatic(app, "/") == (fs::canonical(root / "app" / "index.html")).string());
    CHECK(devhost::resolveStatic(app, "/js/m.js").has_value());
    CHECK_FALSE(devhost::resolveStatic(app, "/../secret.txt"));
    CHECK_FALSE(devhost::resolveStatic(app, "/js/../../secret.txt"));
    CHECK_FALSE(devhost::resolveStatic(app, "/js/../index.html"));  // any ".." segment is refused
    CHECK_FALSE(devhost::resolveStatic(app, "/link.txt"));          // symlink out of the root
    CHECK_FALSE(devhost::resolveStatic(app, "/js"));                // a directory
    CHECK_FALSE(devhost::resolveStatic(app, "/js\\m.js"));
    CHECK_FALSE(devhost::resolveStatic(app, "/missing.js"));
    CHECK(devhost::resolveStatic(app, "/js/..m.js") == std::nullopt);  // not "..", just missing
    fs::remove_all(root);
  }

  TEST_CASE("MIME types and response heads") {
    CHECK(std::string(devhost::mimeFor("/js/main.js")) == "text/javascript; charset=utf-8");
    CHECK(std::string(devhost::mimeFor("/A.CSS")) == "text/css; charset=utf-8");
    CHECK(std::string(devhost::mimeFor("/x.bin")) == "application/octet-stream");
    const std::string h = devhost::httpHead(200, "application/json", 12);
    CHECK(h.rfind("HTTP/1.1 200 OK\r\n", 0) == 0);
    CHECK(h.find("Content-Length: 12\r\n") != std::string::npos);
    CHECK(h.find("Connection: close") != std::string::npos);
    CHECK(devhost::httpHead(204, "x", 0).find("Content-Length") == std::string::npos);
  }
}
