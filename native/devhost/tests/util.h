// Test helpers for the dev host: an event sink for rig_engine, a blocking TCP/WebSocket client.
#pragma once
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "ws_codec.h"

namespace dht {

struct Sink {
  std::mutex mu;
  std::string all;
  int events = 0;
  static void fn(void *u, const char *j, std::size_t n) {
    auto *s = static_cast<Sink *>(u);
    std::lock_guard<std::mutex> lk(s->mu);
    s->all.append(j, n);
    s->all += '\n';
    ++s->events;
  }
  bool waitFor(const char *needle, int ms = 4000) {
    for (int i = 0; i < ms; ++i) {
      {
        std::lock_guard<std::mutex> lk(mu);
        if (all.find(needle) != std::string::npos) return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
  }
  std::string text() {
    std::lock_guard<std::mutex> lk(mu);
    return all;
  }
};

/** Blocking client socket to 127.0.0.1:port with a receive timeout. */
inline int connectTo(std::uint16_t port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  if (::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) != 0) {
    ::close(fd);
    return -1;
  }
  return fd;
}

inline void sendAll(int fd, const std::string &s) {
  std::size_t off = 0;
  while (off < s.size()) {
    const auto n = ::send(fd, s.data() + off, s.size() - off, MSG_NOSIGNAL);
    if (n <= 0) return;
    off += static_cast<std::size_t>(n);
  }
}

/** Reads until the peer closes or `ms` pass. */
inline std::string readAll(int fd, int ms = 3000) {
  std::string o;
  char buf[65536];
  const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
  while (std::chrono::steady_clock::now() < end) {
    pollfd p{fd, POLLIN, 0};
    if (::poll(&p, 1, 50) <= 0) continue;
    const auto n = ::recv(fd, buf, sizeof buf, 0);
    if (n <= 0) break;
    o.append(buf, static_cast<std::size_t>(n));
  }
  return o;
}

/** One HTTP GET; returns the whole response (head + body). */
inline std::string httpGet(std::uint16_t port, const std::string &path) {
  const int fd = connectTo(port);
  if (fd < 0) return {};
  sendAll(fd, "GET " + path + " HTTP/1.1\r\nHost: x\r\n\r\n");
  std::string r = readAll(fd);
  ::close(fd);
  return r;
}

/** Masked client frame. */
inline std::string clientFrame(devhost::WsOp op, const std::string &payload, bool fin = true) {
  std::string o;
  o += static_cast<char>((fin ? 0x80 : 0) | static_cast<int>(op));
  const std::size_t n = payload.size();
  if (n < 126) {
    o += static_cast<char>(0x80 | n);
  } else if (n <= 0xFFFF) {
    o += static_cast<char>(0x80 | 126);
    o += static_cast<char>(n >> 8);
    o += static_cast<char>(n & 0xFF);
  } else {
    o += static_cast<char>(0x80 | 127);
    for (int b = 7; b >= 0; --b) o += static_cast<char>((static_cast<std::uint64_t>(n) >> (8 * b)) & 0xFF);
  }
  const unsigned char mask[4] = {0x12, 0x34, 0x56, 0x78};
  o.append(reinterpret_cast<const char *>(mask), 4);
  for (std::size_t i = 0; i < n; ++i) o += static_cast<char>(payload[i] ^ mask[i & 3]);
  return o;
}

/** A WebSocket client: handshake, send text, read server frames. */
struct WsClient {
  int fd = -1;
  std::string buf, handshake;
  ~WsClient() {
    if (fd >= 0) ::close(fd);
  }
  bool open(std::uint16_t port, const std::string &path = "/__rig/ws", const std::string &extraHeaders = "") {
    fd = connectTo(port);
    if (fd < 0) return false;
    sendAll(fd, "GET " + path +
                    " HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n"
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
                    extraHeaders + "\r\n");
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (buf.find("\r\n\r\n") == std::string::npos && std::chrono::steady_clock::now() < end) fill(50);
    const auto e = buf.find("\r\n\r\n");
    if (e == std::string::npos) return false;
    handshake = buf.substr(0, e + 4);
    buf.erase(0, e + 4);
    return handshake.rfind("HTTP/1.1 101", 0) == 0;
  }
  void fill(int ms) {
    pollfd p{fd, POLLIN, 0};
    if (::poll(&p, 1, ms) <= 0) return;
    char b[65536];
    const auto n = ::recv(fd, b, sizeof b, 0);
    if (n > 0) buf.append(b, static_cast<std::size_t>(n));
    if (n == 0) closed = true;
  }
  bool closed = false;
  void text(const std::string &s) { sendAll(fd, clientFrame(devhost::WsOp::Text, s)); }
  struct Frame {
    int op = -1;
    std::string payload;
  };
  /** Next complete server frame within ms (op -1 on timeout). */
  Frame next(int ms = 3000) {
    const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    for (;;) {
      if (buf.size() >= 2) {
        const auto *p = reinterpret_cast<const unsigned char *>(buf.data());
        std::uint64_t len = p[1] & 0x7F;
        std::size_t h = 2;
        if (len == 126 && buf.size() >= 4) {
          len = (std::uint64_t{p[2]} << 8) | p[3];
          h = 4;
        } else if (len == 127 && buf.size() >= 10) {
          len = 0;
          for (int b = 0; b < 8; ++b) len = (len << 8) | p[2 + b];
          h = 10;
        } else if (len >= 126) {
          h = 0;
        }
        if (h && buf.size() >= h + len) {
          Frame f;
          f.op = p[0] & 0x0F;
          f.payload = buf.substr(h, static_cast<std::size_t>(len));
          buf.erase(0, h + static_cast<std::size_t>(len));
          return f;
        }
      }
      if (closed || std::chrono::steady_clock::now() >= end) return {};
      fill(20);
    }
  }
  /** Reads text frames until one contains `needle`; returns it ("" on timeout). */
  std::string until(const char *needle, int ms = 4000) {
    const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (std::chrono::steady_clock::now() < end) {
      const int left =
          static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(end - std::chrono::steady_clock::now())
                               .count());
      Frame f = next(left > 0 ? left : 1);
      if (f.op == 1 && f.payload.find(needle) != std::string::npos) return f.payload;
      if (f.op == 8 || f.op < 0) {
        if (f.op == 8) lastClose = f.payload;
        if (f.op == 8 || closed) return {};
      }
    }
    return {};
  }
  std::string lastClose;
};

}  // namespace dht
