// WebSocket codec vectors: FIPS 180 SHA-1, RFC 4648 base64, RFC 6455 handshake and frame examples.
#include <string>

#include "doctest.h"
#include "util.h"
#include "ws_codec.h"

using devhost::WsOp;
using devhost::WsParser;

namespace {
std::string hex(const std::array<std::uint8_t, 20> &d) {
  static const char *k = "0123456789abcdef";
  std::string o;
  for (auto b : d) {
    o += k[b >> 4];
    o += k[b & 15];
  }
  return o;
}
std::string b64(const std::string &s) {
  return devhost::base64(reinterpret_cast<const std::uint8_t *>(s.data()), s.size());
}
}  // namespace

TEST_SUITE("devhost-ws") {
  TEST_CASE("SHA-1 FIPS 180 vectors incl. the two-block padding boundary") {
    CHECK(hex(devhost::sha1("abc")) == "a9993e364706816aba3e25717850c26c9cd0d89d");
    CHECK(hex(devhost::sha1("")) == "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    CHECK(hex(devhost::sha1("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")) ==
          "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
    CHECK(hex(devhost::sha1(std::string(1000000, 'a'))) == "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
    // padding boundaries (55/56: one vs two final blocks; 63/64; 119/120), values from Python hashlib
    CHECK(hex(devhost::sha1(std::string(55, 'x'))) == "cef734ba81a024479e09eb5a75b6ddae62e6abf1");
    CHECK(hex(devhost::sha1(std::string(56, 'x'))) == "901305367c259952f4e7af8323f480d59f81335b");
    CHECK(hex(devhost::sha1(std::string(63, 'x'))) == "0ddc4e0cccd9a12850deb5abb0853a4425559fec");
    CHECK(hex(devhost::sha1(std::string(64, 'x'))) == "bb2fa3ee7afb9f54c6dfb5d021f14b1ffe40c163");
    CHECK(hex(devhost::sha1(std::string(119, 'x'))) == "4300320394f7ee239bcdce7d3b8bcee173a0cd5c");
    CHECK(hex(devhost::sha1(std::string(120, 'x'))) == "ceb2821639c4b6dcb10bce0e522ca2e608ce056d");
    CHECK(hex(devhost::sha1(std::string(64, 'a'))) == "0098ba824b5c16427bd7a1122a5a442a25ec644d");
  }

  TEST_CASE("base64 RFC 4648 vectors") {
    CHECK(b64("") == "");
    CHECK(b64("f") == "Zg==");
    CHECK(b64("fo") == "Zm8=");
    CHECK(b64("foo") == "Zm9v");
    CHECK(b64("foob") == "Zm9vYg==");
    CHECK(b64("fooba") == "Zm9vYmE=");
    CHECK(b64("foobar") == "Zm9vYmFy");
  }

  TEST_CASE("RFC 6455 1.3 handshake accept key") {
    CHECK(devhost::wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  }

  TEST_CASE("server frames: RFC 6455 5.7 'Hello' and the 16/64-bit length forms") {
    std::string f;
    devhost::wsEncodeFrame(f, WsOp::Text, "Hello");
    CHECK(f == std::string("\x81\x05Hello", 7));
    f.clear();
    devhost::wsEncodeFrame(f, WsOp::Binary, std::string(256, 'a'));
    CHECK(f.substr(0, 4) == std::string("\x82\x7E\x01\x00", 4));
    CHECK(f.size() == 4 + 256);
    f.clear();
    devhost::wsEncodeFrame(f, WsOp::Binary, std::string(65536, 'a'));
    CHECK(f.substr(0, 10) == std::string("\x82\x7F\x00\x00\x00\x00\x00\x01\x00\x00", 10));
    f.clear();
    devhost::wsEncodeFrame(f, WsOp::Text, std::string(125, 'z'));
    CHECK(static_cast<unsigned char>(f[1]) == 125);
  }

  TEST_CASE("client frames: RFC 6455 5.7 masked 'Hello', byte-by-byte feeding, fragmentation") {
    WsParser p;
    const std::string masked("\x81\x85\x37\xfa\x21\x3d\x7f\x9f\x4d\x51\x58", 11);
    for (char c : masked) {
      CHECK(p.next().kind == WsParser::Event::None);
      p.feed(&c, 1);
    }
    auto ev = p.next();
    CHECK(ev.kind == WsParser::Event::Message);
    CHECK(ev.payload == "Hello");
    CHECK_FALSE(ev.binary);
    // "Hel" + "lo" fragmented, with a ping in between (control frames may interleave)
    std::string s = dht::clientFrame(WsOp::Text, "Hel", false) + dht::clientFrame(WsOp::Ping, "p") +
                    dht::clientFrame(WsOp::Continuation, "lo", true);
    p.feed(s.data(), s.size());
    ev = p.next();
    CHECK(ev.kind == WsParser::Event::Ping);
    CHECK(ev.payload == "p");
    ev = p.next();
    CHECK(ev.kind == WsParser::Event::Message);
    CHECK(ev.payload == "Hello");
    CHECK(p.next().kind == WsParser::Event::None);
  }

  TEST_CASE("client frames: 16- and 64-bit lengths, close codes") {
    WsParser p;
    const std::string big(70000, 'q'), mid(300, 'm');
    std::string s = dht::clientFrame(WsOp::Text, mid) + dht::clientFrame(WsOp::Binary, big) +
                    dht::clientFrame(WsOp::Close, devhost::wsClosePayload(1001, "bye")) +
                    dht::clientFrame(WsOp::Close, "");
    p.feed(s.data(), s.size());
    auto ev = p.next();
    CHECK(ev.payload == mid);
    ev = p.next();
    CHECK(ev.binary);
    CHECK(ev.payload == big);
    ev = p.next();
    CHECK(ev.kind == WsParser::Event::Close);
    CHECK(ev.closeCode == 1001);
    ev = p.next();
    CHECK(ev.closeCode == 1005);
  }

  TEST_CASE("protocol errors fail the parser with the RFC close code") {
    {
      WsParser p;  // unmasked client frame
      const std::string s("\x81\x02hi", 4);
      p.feed(s.data(), s.size());
      CHECK(p.next().kind == WsParser::Event::None);
      CHECK(p.failCode() == 1002);
    }
    {
      WsParser p;  // continuation with nothing to continue
      const std::string s = dht::clientFrame(WsOp::Continuation, "x");
      p.feed(s.data(), s.size());
      p.next();
      CHECK(p.failCode() == 1002);
    }
    {
      WsParser p;  // fragmented control frame
      const std::string s = dht::clientFrame(WsOp::Ping, "x", false);
      p.feed(s.data(), s.size());
      p.next();
      CHECK(p.failCode() == 1002);
    }
    {
      WsParser p(100);  // over the message cap, also when the cap is crossed by fragments
      const std::string s = dht::clientFrame(WsOp::Text, std::string(60, 'a'), false) +
                            dht::clientFrame(WsOp::Continuation, std::string(60, 'a'));
      p.feed(s.data(), s.size());
      p.next();
      CHECK(p.failCode() == 1009);
    }
    {
      WsParser p;  // reserved bits
      std::string s = dht::clientFrame(WsOp::Text, "x");
      s[0] = static_cast<char>(s[0] | 0x40);
      p.feed(s.data(), s.size());
      p.next();
      CHECK(p.failCode() == 1002);
    }
  }
}
