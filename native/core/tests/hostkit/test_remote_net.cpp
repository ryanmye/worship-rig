// Remote wire pieces (remote lane, D45; REMOTE.md §2.4): HTTP head parsing, filters, WebSocket codec, on byte strings.
#include <cstdint>
#include <random>
#include <string>

#include "doctest.h"
#include "remote_net.h"

using namespace rig::hostkit::remote;

namespace {
HeadStatus parse(const std::string &s, HttpRequest *r = nullptr, std::size_t *len = nullptr) {
  HttpRequest tmp;
  std::size_t l = 0;
  return parseHead(s, r ? r : &tmp, len ? len : &l);
}
std::uint32_t v4(int a, int b, int c, int d) {
  return static_cast<std::uint32_t>(a) << 24 | static_cast<std::uint32_t>(b) << 16 | static_cast<std::uint32_t>(c) << 8
         | static_cast<std::uint32_t>(d);
}
/** A masked client frame. */
std::string clientFrame(std::uint8_t first, const std::string &payload, std::uint32_t mask = 0x11223344) {
  std::string f;
  f += static_cast<char>(first);
  const std::size_t n = payload.size();
  if (n < 126) {
    f += static_cast<char>(0x80 | n);
  } else if (n <= 0xFFFF) {
    f += static_cast<char>(0x80 | 126);
    f += static_cast<char>(n >> 8);
    f += static_cast<char>(n & 0xFF);
  } else {
    f += static_cast<char>(0x80 | 127);
    for (int b = 7; b >= 0; --b) f += static_cast<char>((static_cast<std::uint64_t>(n) >> (8 * b)) & 0xFF);
  }
  const std::uint8_t m[4] = {static_cast<std::uint8_t>(mask >> 24), static_cast<std::uint8_t>(mask >> 16),
                             static_cast<std::uint8_t>(mask >> 8), static_cast<std::uint8_t>(mask)};
  for (std::uint8_t b : m) f += static_cast<char>(b);
  for (std::size_t i = 0; i < n; ++i) f += static_cast<char>(payload[i] ^ static_cast<char>(m[i & 3]));
  return f;
}
}  // namespace

TEST_SUITE("hostkit-remote-net") {
  TEST_CASE("HTTP: a normal request; headers lower-cased and trimmed; query split; body length") {
    HttpRequest r;
    std::size_t len = 0;
    const std::string s = "POST /api/cmd?x=1&since=42 HTTP/1.1\r\nHost: 192.168.1.2:8450\r\nX-Rig-Token:  abc \r\n"
                          "Content-Length: 5\r\n\r\nhello";
    REQUIRE(parse(s, &r, &len) == HeadStatus::Ok);
    CHECK(r.method == "POST");
    CHECK(r.path == "/api/cmd");
    CHECK(r.query == "x=1&since=42");
    CHECK(r.header("host") == "192.168.1.2:8450");
    CHECK(r.header("x-rig-token") == "abc");
    CHECK(r.contentLength == 5);
    CHECK(len == s.size() - 5);
    CHECK(queryNumber(r.query, "since").value() == 42);
    CHECK_FALSE(queryNumber(r.query, "nope"));
    CHECK_FALSE(queryNumber("since=-1", "since"));
    CHECK_FALSE(queryNumber("since=1e3", "since"));
    CHECK_FALSE(queryNumber("since=", "since"));
  }

  TEST_CASE("HTTP: incomplete, malformed, too large, unsupported") {
    CHECK(parse("GET / HTTP/1.1\r\nHost: x") == HeadStatus::Incomplete);
    CHECK(parse("") == HeadStatus::Incomplete);
    CHECK(parse(std::string(kMaxHead + 1, 'a')) == HeadStatus::TooLarge);
    CHECK(parse("GET / HTTP/1.1\r\nX: " + std::string(kMaxHead, 'a') + "\r\n\r\n") == HeadStatus::TooLarge);
    std::string many = "GET / HTTP/1.1\r\n";
    for (int i = 0; i < 41; ++i) many += "X" + std::to_string(i) + ": y\r\n";
    CHECK(parse(many + "\r\n") == HeadStatus::TooLarge);
    CHECK(parse("GET  / HTTP/1.1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET /\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("get / HTTP/1.1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET x HTTP/1.1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET /a b HTTP/1.1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET /\xC3\xA9 HTTP/1.1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET / HTTP/2.0\r\n\r\n") == HeadStatus::Unsupported);
    CHECK(parse("GET / FTP/1.1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET / HTTP/1.1\r\nNoColon\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET / HTTP/1.1\r\n: v\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET / HTTP/1.1\r\nBad Name: v\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET / HTTP/1.1\r\nA: b\r\n c\r\n\r\n") == HeadStatus::Bad);  // obs-fold
    CHECK(parse("GET / HTTP/1.1\r\nA: b\x01\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET / HTTP/1.1\r\nA: b\nC: d\r\n\r\n") == HeadStatus::Bad);  // a lone LF or CR: smuggling shapes
    CHECK(parse("GET / HTTP/1.1\r\nA: b\rC: d\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n") == HeadStatus::Bad);  // request smuggling shapes
    CHECK(parse("POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("POST / HTTP/1.1\r\nContent-Length: 1 2\r\n\r\n") == HeadStatus::Bad);
    CHECK(parse("POST / HTTP/1.1\r\nContent-Length: 1025\r\n\r\n") == HeadStatus::TooLarge);
    CHECK(parse("POST / HTTP/1.1\r\nContent-Length: 99999999999\r\n\r\n") == HeadStatus::TooLarge);
    CHECK(parse("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n") == HeadStatus::Unsupported);
    HttpRequest r;
    REQUIRE(parse("GET / HTTP/1.1\r\nA: 1\r\na: 2\r\n\r\n", &r) == HeadStatus::Ok);
    CHECK(r.header("a") == "1, 2");
  }

  TEST_CASE("HTTP: random bytes never crash the parser") {
    std::mt19937 rng(7);
    for (int i = 0; i < 5000; ++i) {
      std::string s = i % 2 ? "GET / HTTP/1.1\r\n" : "";
      const int n = static_cast<int>(rng() % 300);
      for (int k = 0; k < n; ++k) s += static_cast<char>(rng() % 256);
      if (i % 3 == 0) s += "\r\n\r\n";
      HttpRequest r;
      std::size_t len = 0;
      const HeadStatus st = parseHead(s, &r, &len);
      if (st == HeadStatus::Ok) CHECK(len <= s.size());
    }
  }

  TEST_CASE("responses carry the security headers") {
    const std::string r = httpResponse(404, "text/plain", "nope", "X-A: b\r\n");
    CHECK(r.rfind("HTTP/1.1 404 Not Found\r\n", 0) == 0);
    for (const char *h : {"Content-Length: 4\r\n", "Cache-Control: no-store\r\n", "X-Content-Type-Options: nosniff\r\n",
                          "Referrer-Policy: no-referrer\r\n", "X-Frame-Options: DENY\r\n", "Connection: close\r\n",
                          "X-A: b\r\n\r\nnope"}) {
      CHECK(r.find(h) != std::string::npos);
    }
  }

  TEST_CASE("filters: local IPv4 / IPv6 ranges") {
    for (auto a : {v4(127, 0, 0, 1), v4(10, 1, 2, 3), v4(172, 16, 0, 1), v4(172, 31, 255, 255), v4(192, 168, 1, 20),
                   v4(169, 254, 3, 4), v4(100, 64, 0, 1), v4(100, 127, 255, 255)}) {
      CHECK(isLocalIPv4(a));
    }
    for (auto a : {v4(8, 8, 8, 8), v4(172, 15, 0, 1), v4(172, 32, 0, 1), v4(192, 169, 0, 1), v4(100, 63, 0, 1),
                   v4(100, 128, 0, 1), v4(0, 0, 0, 0), v4(224, 0, 0, 1), v4(255, 255, 255, 255), v4(1, 1, 1, 1)}) {
      CHECK_FALSE(isLocalIPv4(a));
    }
    std::array<std::uint8_t, 16> a{};
    a[15] = 1;
    CHECK(isLocalIPv6(a));  // ::1
    a = {0xfe, 0x80};
    CHECK(isLocalIPv6(a));
    a = {0xfe, 0xbf};
    CHECK(isLocalIPv6(a));
    a = {0xfe, 0xc0};
    CHECK_FALSE(isLocalIPv6(a));  // fec0::/10 (deprecated site-local): not ours
    a = {0xfd, 0x12};
    CHECK(isLocalIPv6(a));
    a = {0xfc};
    CHECK(isLocalIPv6(a));
    a = {0x20, 0x01, 0x0d, 0xb8};
    CHECK_FALSE(isLocalIPv6(a));
    a = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 0, 5};
    CHECK(isLocalIPv6(a));
    a = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 8, 8, 8, 8};
    CHECK_FALSE(isLocalIPv6(a));
    a = {};
    CHECK_FALSE(isLocalIPv6(a));  // ::
  }

  TEST_CASE("filters: Host (DNS rebinding) and Origin (cross-site)") {
    for (const char *h : {"192.168.1.20:8450", "192.168.1.20", "10.0.0.1:1", "localhost:8450", "LOCALHOST",
                          "ryans-macbook.local:8450", "Ryans-MacBook-Pro.local", "a.b.local", "[::1]:8450",
                          "[fe80::1%25en0]" /* refused below: % */}) {
      if (std::string(h).find('%') != std::string::npos) CHECK_FALSE(hostAllowed(h));
      else CHECK(hostAllowed(h));
    }
    for (const char *h : {"", "evil.com", "evil.com:8450", "192.168.1.20.evil.com", "local", ".local", "-x.local",
                          "x-.local", "192.168.1", "192.168.1.256", "192.168.01.2", "1.2.3.4.5", "x.local:",
                          "x.local:123456", "x.local:12a", "[::1", "[]:80", "[g::1]", "localhost.evil.com",
                          "a b.local", "x_y.local"}) {
      CHECK_FALSE(hostAllowed(h));
    }
    CHECK(originAllowed("", "192.168.1.2:8450"));
    CHECK(originAllowed("http://192.168.1.2:8450", "192.168.1.2:8450"));
    CHECK(originAllowed("HTTP://Mac.Local:8450", "mac.local:8450"));
    CHECK_FALSE(originAllowed("null", "192.168.1.2:8450"));
    CHECK_FALSE(originAllowed("https://192.168.1.2:8450", "192.168.1.2:8450"));
    CHECK_FALSE(originAllowed("http://192.168.1.2", "192.168.1.2:8450"));
    CHECK_FALSE(originAllowed("http://evil.com", "192.168.1.2:8450"));
    CHECK_FALSE(originAllowed("http://192.168.1.2:8450.evil.com", "192.168.1.2:8450"));
  }

  TEST_CASE("WebSocket: accept key (RFC 6455 §1.3 example) and upgrade checks") {
    CHECK(wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    HttpRequest r;
    REQUIRE(parse("GET /ws HTTP/1.1\r\nHost: x.local\r\nUpgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\n"
                  "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
                  &r) == HeadStatus::Ok);
    CHECK(isWsUpgrade(r));
    HttpRequest bad = r;
    bad.headers["sec-websocket-version"] = "8";
    CHECK_FALSE(isWsUpgrade(bad));
    bad = r;
    bad.headers["sec-websocket-key"] = "short";
    CHECK_FALSE(isWsUpgrade(bad));
    bad = r;
    bad.headers["connection"] = "keep-alive";
    CHECK_FALSE(isWsUpgrade(bad));
    bad = r;
    bad.method = "POST";
    CHECK_FALSE(isWsUpgrade(bad));
  }

  TEST_CASE("WebSocket: frames, fragmentation, control frames, limits") {
    WsParser p;
    const std::string two = clientFrame(0x81, "hello") + clientFrame(0x01, "frag") + clientFrame(0x89, "pi")
                            + clientFrame(0x80, "ment") + clientFrame(0x88, std::string("\x03\xe8", 2) + "bye");
    for (char ch : two) p.feed(&ch, 1);  // byte by byte
    auto e = p.next();
    CHECK(e.kind == WsParser::Event::Message);
    CHECK(e.payload == "hello");
    e = p.next();
    CHECK(e.kind == WsParser::Event::Ping);  // a control frame inside a fragmented message
    CHECK(e.payload == "pi");
    e = p.next();
    CHECK(e.kind == WsParser::Event::Message);
    CHECK(e.payload == "fragment");
    e = p.next();
    CHECK(e.kind == WsParser::Event::Close);
    CHECK(e.closeCode == 1000);
    CHECK(p.next().kind == WsParser::Event::None);
    CHECK_FALSE(p.failed());

    WsParser big;
    const std::string f = clientFrame(0x81, std::string(kMaxWsMessage + 1, 'a'));
    big.feed(f.data(), 4);  // the header alone is enough to refuse it
    big.next();
    CHECK(big.failCode() == 1009);
    WsParser huge;  // a 64-bit length near 2^64: refused before any arithmetic with it
    std::string h = "\x81\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xF0";
    huge.feed(h.data(), h.size());
    huge.next();
    CHECK(huge.failCode() == 1009);
    WsParser frag;
    const std::string ff = clientFrame(0x01, std::string(3000, 'a')) + clientFrame(0x80, std::string(3000, 'a'));
    frag.feed(ff.data(), ff.size());
    frag.next();
    CHECK(frag.failCode() == 1009);  // the whole message counts
    WsParser unmasked;
    unmasked.feed("\x81\x01x", 3);
    unmasked.next();
    CHECK(unmasked.failCode() == 1002);
    WsParser rsv;
    const std::string rf = clientFrame(0xC1, "x");
    rsv.feed(rf.data(), rf.size());
    rsv.next();
    CHECK(rsv.failCode() == 1002);
    WsParser longPing;
    const std::string lp = clientFrame(0x89, std::string(126, 'a'));
    longPing.feed(lp.data(), lp.size());
    longPing.next();
    CHECK(longPing.failCode() == 1002);
    WsParser cont;
    const std::string cf = clientFrame(0x80, "x");
    cont.feed(cf.data(), cf.size());
    cont.next();
    CHECK(cont.failCode() == 1002);
    WsParser op;
    const std::string of = clientFrame(0x83, "x");
    op.feed(of.data(), of.size());
    op.next();
    CHECK(op.failCode() == 1002);
  }

  TEST_CASE("WebSocket: random frames never crash the parser") {
    std::mt19937 rng(11);
    for (int i = 0; i < 3000; ++i) {
      WsParser p;
      std::string s;
      const int n = static_cast<int>(rng() % 200);
      for (int k = 0; k < n; ++k) s += static_cast<char>(rng() % 256);
      p.feed(s.data(), s.size());
      for (int k = 0; k < 50 && !p.failed(); ++k) {
        if (p.next().kind == WsParser::Event::None) break;
      }
    }
  }

  TEST_CASE("server frames") {
    std::string out;
    wsEncodeFrame(out, WsOp::Text, "hi");
    CHECK(out == std::string("\x81\x02hi", 4));
    out.clear();
    wsEncodeFrame(out, WsOp::Text, std::string(200, 'a'));
    CHECK(out.substr(0, 4) == std::string("\x81\x7E\x00\xC8", 4));
    CHECK(wsClosePayload(4001, "x") == std::string("\x0F\xA1x", 3));
  }
}
