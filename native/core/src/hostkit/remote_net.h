// The browser remote's wire pieces (remote lane, D45; REMOTE.md §2.4), with no sockets so each is tested on byte
// strings: an HTTP/1.1 request head parser (strict, small), a WebSocket (RFC 6455) server codec adapted from
// native/devhost/src/ws_codec.cpp with tighter limits, and the filters that keep the remote on the local network:
// peer address ranges, the Host header (DNS rebinding) and the Origin header (cross-site requests).
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>

namespace rig::hostkit::remote {

// ---- HTTP

constexpr std::size_t kMaxHead = 8192;   // request line + headers
constexpr std::size_t kMaxBody = 1024;   // POST bodies (pair, cmd)
constexpr std::size_t kMaxHeaders = 40;

struct HttpRequest {
  std::string method;  // GET | POST | HEAD | OPTIONS | …
  std::string path;    // the target before '?', not decoded (routes are fixed ASCII)
  std::string query;   // after '?'
  std::map<std::string, std::string> headers;  // lower-case names, trimmed values
  std::size_t contentLength = 0;

  std::string header(const std::string &lowerName) const {
    auto it = headers.find(lowerName);
    return it == headers.end() ? std::string() : it->second;
  }
};

enum class HeadStatus { Incomplete, Ok, Bad, TooLarge, Unsupported };

/**
 * Parse the request head at the start of `buf`. Ok: `*req` filled, `*headLen` = bytes up to and including the blank
 * line. Bad: malformed (bad request line, header without a colon, obs-fold, control bytes, duplicate Host or
 * Content-Length, a bad Content-Length). TooLarge: the head passes kMaxHead or kMaxHeaders, or Content-Length passes
 * kMaxBody. Unsupported: Transfer-Encoding (no chunked bodies here), or an HTTP version other than 1.0 / 1.1.
 */
HeadStatus parseHead(std::string_view buf, HttpRequest *req, std::size_t *headLen);

/** `name=<digits>` from a query string, or nullopt. */
std::optional<std::uint64_t> queryNumber(std::string_view query, std::string_view name);

/** A response: status line, the security headers every reply carries, then `extra` header lines and the body. */
std::string httpResponse(int code, std::string_view contentType, std::string_view body, std::string_view extra = {});

// ---- filters

/** Loopback, RFC 1918, link-local, CGNAT 100.64/10 (host byte order: 192.168.1.2 = 0xC0A80102). */
bool isLocalIPv4(std::uint32_t addr);
/** ::1, fe80::/10, fc00::/7, and IPv4-mapped ::ffff:a.b.c.d by the IPv4 rule. */
bool isLocalIPv6(const std::array<std::uint8_t, 16> &addr);

/**
 * The Host header must name this machine by an IP literal (IPv4 dotted quad, [IPv6]), `localhost`, or a `.local`
 * name, with an optional port. A public DNS name is refused: that is what a DNS-rebinding page would send.
 */
bool hostAllowed(std::string_view host);

/**
 * No Origin is fine (same-origin GETs, old Safari's same-origin XHR); otherwise it must be `http://<host>` exactly
 * (case-insensitive), where host is the request's (already allowed) Host header. "null" is refused.
 */
bool originAllowed(std::string_view origin, std::string_view host);

// ---- WebSocket

constexpr std::size_t kMaxWsMessage = 4096;

/** `Sec-WebSocket-Accept` for a client key (RFC 6455 §4.2.2). */
std::string wsAcceptKey(std::string_view clientKey);
/** A valid upgrade request: GET, Upgrade: websocket, Connection contains upgrade, version 13, a 16-byte base64 key. */
bool isWsUpgrade(const HttpRequest &req);

enum class WsOp : std::uint8_t { Continuation = 0x0, Text = 0x1, Binary = 0x2, Close = 0x8, Ping = 0x9, Pong = 0xA };

/** One unmasked server frame (FIN set), appended to `out`. */
void wsEncodeFrame(std::string &out, WsOp op, std::string_view payload);
/** A close frame payload: 2-byte code + reason (cut to fit a control frame). */
std::string wsClosePayload(std::uint16_t code, std::string_view reason);

/** Incremental parser of client frames (masked, as RFC 6455 requires). See devhost's WsParser; limits are tighter. */
class WsParser {
 public:
  explicit WsParser(std::size_t maxMessage = kMaxWsMessage) : max_(maxMessage) {}

  struct Event {
    enum Kind { None, Message, Ping, Pong, Close } kind = None;
    bool binary = false;
    std::string payload;
    std::uint16_t closeCode = 0;
  };

  void feed(const char *data, std::size_t len) { buf_.append(data, len); }
  Event next();
  bool failed() const { return failCode_ != 0; }
  std::uint16_t failCode() const { return failCode_; }
  std::size_t buffered() const { return buf_.size() - pos_; }

 private:
  Event fail(std::uint16_t code);
  std::string buf_;
  std::size_t pos_ = 0;
  std::size_t max_;
  bool inMessage_ = false;
  bool msgBinary_ = false;
  std::string msg_;
  std::uint16_t failCode_ = 0;
};

}  // namespace rig::hostkit::remote
