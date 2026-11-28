// The browser remote's wire pieces (remote lane, D45). See remote_net.h.
#include "remote_net.h"

#include <algorithm>
#include <cctype>
#include <cstring>

#include "sha1.h"

namespace rig::hostkit::remote {
namespace {

char lower(char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; }
std::string toLower(std::string_view s) {
  std::string out(s);
  for (char &c : out) c = lower(c);
  return out;
}
bool iequals(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (lower(a[i]) != lower(b[i])) return false;
  }
  return true;
}
std::string_view trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  return s;
}
bool isDigit(char c) { return c >= '0' && c <= '9'; }
bool allDigits(std::string_view s) { return !s.empty() && std::all_of(s.begin(), s.end(), isDigit); }
bool isTokenChar(char c) {
  return std::isalnum(static_cast<unsigned char>(c)) != 0 || std::strchr("!#$%&'*+-.^_`|~", c) != nullptr;
}

const char *reason(int code) {
  switch (code) {
    case 101: return "Switching Protocols";
    case 200: return "OK";
    case 204: return "No Content";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 413: return "Payload Too Large";
    case 415: return "Unsupported Media Type";
    case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large";
    case 501: return "Not Implemented";
    case 503: return "Service Unavailable";
    default: return "Error";
  }
}

std::string base64(const std::uint8_t *d, std::size_t n) {
  static const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  std::size_t i = 0;
  for (; i + 3 <= n; i += 3) {
    const std::uint32_t v = (std::uint32_t{d[i]} << 16) | (std::uint32_t{d[i + 1]} << 8) | d[i + 2];
    out += a[(v >> 18) & 63];
    out += a[(v >> 12) & 63];
    out += a[(v >> 6) & 63];
    out += a[v & 63];
  }
  if (n - i == 1) {
    const std::uint32_t v = std::uint32_t{d[i]} << 16;
    out += a[(v >> 18) & 63];
    out += a[(v >> 12) & 63];
    out += "==";
  } else if (n - i == 2) {
    const std::uint32_t v = (std::uint32_t{d[i]} << 16) | (std::uint32_t{d[i + 1]} << 8);
    out += a[(v >> 18) & 63];
    out += a[(v >> 12) & 63];
    out += a[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

bool isIPv4Literal(std::string_view s) {
  int parts = 0;
  while (true) {
    std::size_t dot = s.find('.');
    std::string_view p = s.substr(0, dot);
    if (p.empty() || p.size() > 3 || !allDigits(p) || (p.size() > 1 && p[0] == '0')) return false;
    if (std::stoi(std::string(p)) > 255) return false;
    ++parts;
    if (dot == std::string_view::npos) break;
    s.remove_prefix(dot + 1);
  }
  return parts == 4;
}

bool isDotLocalName(std::string_view s) {
  if (s.size() > 253 || s.size() < 7) return false;  // "x.local"
  if (!iequals(s.substr(s.size() - 6), ".local")) return false;
  std::string_view labels = s.substr(0, s.size() - 6);
  while (true) {
    std::size_t dot = labels.find('.');
    std::string_view l = labels.substr(0, dot);
    if (l.empty() || l.size() > 63 || l.front() == '-' || l.back() == '-') return false;
    for (char c : l) {
      if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '-')) return false;
    }
    if (dot == std::string_view::npos) return true;
    labels.remove_prefix(dot + 1);
  }
}

}  // namespace

// ---- HTTP

HeadStatus parseHead(std::string_view buf, HttpRequest *req, std::size_t *headLen) {
  const std::size_t end = buf.find("\r\n\r\n");
  if (end == std::string_view::npos) return buf.size() > kMaxHead ? HeadStatus::TooLarge : HeadStatus::Incomplete;
  if (end + 4 > kMaxHead) return HeadStatus::TooLarge;
  std::string_view head = buf.substr(0, end);
  for (std::size_t i = 0; i < head.size(); ++i) {
    const char c = head[i];
    const auto u = static_cast<unsigned char>(c);
    if ((u < 0x20 && c != '\r' && c != '\n' && c != '\t') || u == 0x7F) return HeadStatus::Bad;
    // CR and LF only as CRLF: a lone one is how one request hides inside another (smuggling)
    if (c == '\r' && (i + 1 >= head.size() || head[i + 1] != '\n')) return HeadStatus::Bad;
    if (c == '\n' && (i == 0 || head[i - 1] != '\r')) return HeadStatus::Bad;
  }
  HttpRequest r;
  std::size_t eol = head.find("\r\n");
  std::string_view line = head.substr(0, eol);
  // request line: METHOD SP target SP HTTP/1.x
  const std::size_t s1 = line.find(' ');
  const std::size_t s2 = s1 == std::string_view::npos ? s1 : line.find(' ', s1 + 1);
  if (s2 == std::string_view::npos || line.find(' ', s2 + 1) != std::string_view::npos) return HeadStatus::Bad;
  std::string_view method = line.substr(0, s1), target = line.substr(s1 + 1, s2 - s1 - 1), ver = line.substr(s2 + 1);
  if (method.empty() || method.size() > 16) return HeadStatus::Bad;
  for (char c : method) {
    if (!(c >= 'A' && c <= 'Z')) return HeadStatus::Bad;
  }
  if (target.empty() || target.size() > 2048 || target[0] != '/') return HeadStatus::Bad;
  for (char c : target) {
    const auto u = static_cast<unsigned char>(c);
    if (u <= 0x20 || u >= 0x7F) return HeadStatus::Bad;
  }
  if (ver != "HTTP/1.1" && ver != "HTTP/1.0") {
    return ver.rfind("HTTP/", 0) == 0 ? HeadStatus::Unsupported : HeadStatus::Bad;
  }
  r.method = std::string(method);
  const std::size_t q = target.find('?');
  r.path = std::string(target.substr(0, q));
  if (q != std::string_view::npos) r.query = std::string(target.substr(q + 1));
  // headers
  std::size_t count = 0;
  bool sawLength = false;
  while (eol != std::string_view::npos) {
    head.remove_prefix(eol + 2);
    eol = head.find("\r\n");
    line = head.substr(0, eol);
    if (line.empty()) return HeadStatus::Bad;  // only the final blank line may be empty, and it is not in `head`
    if (line[0] == ' ' || line[0] == '\t') return HeadStatus::Bad;  // obs-fold
    if (++count > kMaxHeaders) return HeadStatus::TooLarge;
    const std::size_t colon = line.find(':');
    if (colon == std::string_view::npos || colon == 0) return HeadStatus::Bad;
    std::string_view name = line.substr(0, colon);
    for (char c : name) {
      if (!isTokenChar(c)) return HeadStatus::Bad;
    }
    const std::string key = toLower(name);
    const std::string value(trim(line.substr(colon + 1)));
    if (r.headers.count(key)) {
      if (key == "host" || key == "content-length" || key == "transfer-encoding") return HeadStatus::Bad;
      r.headers[key] += ", " + value;
    } else {
      r.headers.emplace(key, value);
    }
    if (key == "content-length") sawLength = true;
  }
  if (r.headers.count("transfer-encoding")) return HeadStatus::Unsupported;
  if (sawLength) {
    const std::string &v = r.headers["content-length"];
    if (!allDigits(v) || v.size() > 7) return v.size() > 7 && allDigits(v) ? HeadStatus::TooLarge : HeadStatus::Bad;
    r.contentLength = static_cast<std::size_t>(std::stoul(v));
    if (r.contentLength > kMaxBody) return HeadStatus::TooLarge;
  }
  *req = std::move(r);
  *headLen = end + 4;
  return HeadStatus::Ok;
}

std::optional<std::uint64_t> queryNumber(std::string_view query, std::string_view name) {
  while (!query.empty()) {
    const std::size_t amp = query.find('&');
    std::string_view kv = query.substr(0, amp);
    const std::size_t eq = kv.find('=');
    if (eq != std::string_view::npos && kv.substr(0, eq) == name) {
      std::string_view v = kv.substr(eq + 1);
      if (!allDigits(v) || v.size() > 15) return std::nullopt;
      return std::stoull(std::string(v));
    }
    if (amp == std::string_view::npos) break;
    query.remove_prefix(amp + 1);
  }
  return std::nullopt;
}

std::string httpResponse(int code, std::string_view contentType, std::string_view body, std::string_view extra) {
  std::string r = "HTTP/1.1 " + std::to_string(code) + " " + reason(code) + "\r\n";
  if (!contentType.empty()) r += "Content-Type: " + std::string(contentType) + "\r\n";
  if (code != 101) r += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  r += "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n"
       "X-Frame-Options: DENY\r\n";
  if (code != 101) r += "Connection: close\r\n";
  r.append(extra.data(), extra.size());
  r += "\r\n";
  r.append(body.data(), body.size());
  return r;
}

// ---- filters

bool isLocalIPv4(std::uint32_t a) {
  const auto b0 = a >> 24, b1 = (a >> 16) & 0xFF;
  return b0 == 127 || b0 == 10 || (b0 == 172 && (b1 & 0xF0) == 16) || (b0 == 192 && b1 == 168)
         || (b0 == 169 && b1 == 254) || (b0 == 100 && (b1 & 0xC0) == 64);
}

bool isLocalIPv6(const std::array<std::uint8_t, 16> &a) {
  static const std::uint8_t loop[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
  if (std::memcmp(a.data(), loop, 16) == 0) return true;
  if (a[0] == 0xFE && (a[1] & 0xC0) == 0x80) return true;  // fe80::/10
  if ((a[0] & 0xFE) == 0xFC) return true;                  // fc00::/7
  static const std::uint8_t mapped[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF};
  if (std::memcmp(a.data(), mapped, 12) == 0) {
    return isLocalIPv4((std::uint32_t{a[12]} << 24) | (std::uint32_t{a[13]} << 16) | (std::uint32_t{a[14]} << 8)
                       | a[15]);
  }
  return false;
}

bool hostAllowed(std::string_view host) {
  if (host.empty() || host.size() > 260) return false;
  std::string_view name = host;
  std::string_view port;
  if (host.front() == '[') {
    const std::size_t close = host.find(']');
    if (close == std::string_view::npos || close < 3) return false;
    for (char c : host.substr(1, close - 1)) {
      if (!(std::isxdigit(static_cast<unsigned char>(c)) || c == ':' || c == '.')) return false;
    }
    std::string_view rest = host.substr(close + 1);
    if (!rest.empty()) {
      if (rest[0] != ':') return false;
      port = rest.substr(1);
      if (!allDigits(port) || port.size() > 5) return false;
    }
    return true;
  }
  const std::size_t colon = host.rfind(':');
  if (colon != std::string_view::npos) {
    name = host.substr(0, colon);
    port = host.substr(colon + 1);
    if (!allDigits(port) || port.size() > 5) return false;
  }
  return isIPv4Literal(name) || iequals(name, "localhost") || isDotLocalName(name);
}

bool originAllowed(std::string_view origin, std::string_view host) {
  if (origin.empty()) return true;
  if (origin == "null") return false;
  return iequals(origin, "http://" + std::string(host));
}

// ---- WebSocket

std::string wsAcceptKey(std::string_view clientKey) {
  const std::string hex = sha1Hex(std::string(clientKey) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  std::uint8_t d[20];
  for (int i = 0; i < 20; ++i) d[i] = static_cast<std::uint8_t>(std::stoi(hex.substr(2 * i, 2), nullptr, 16));
  return base64(d, 20);
}

bool isWsUpgrade(const HttpRequest &req) {
  if (req.method != "GET" || !iequals(req.header("upgrade"), "websocket")) return false;
  const std::string conn = toLower(req.header("connection"));
  bool hasUpgrade = false;
  std::string_view c = conn;
  while (true) {
    const std::size_t comma = c.find(',');
    if (trim(c.substr(0, comma)) == "upgrade") hasUpgrade = true;
    if (comma == std::string_view::npos) break;
    c.remove_prefix(comma + 1);
  }
  if (!hasUpgrade || req.header("sec-websocket-version") != "13") return false;
  const std::string key = req.header("sec-websocket-key");
  if (key.size() != 24 || key.compare(22, 2, "==") != 0) return false;
  return std::all_of(key.begin(), key.begin() + 22,
                     [](char ch) { return std::isalnum(static_cast<unsigned char>(ch)) || ch == '+' || ch == '/'; });
}

void wsEncodeFrame(std::string &out, WsOp op, std::string_view payload) {
  out += static_cast<char>(0x80u | static_cast<unsigned>(op));
  const std::size_t n = payload.size();
  if (n < 126) {
    out += static_cast<char>(n);
  } else if (n <= 0xFFFF) {
    out += static_cast<char>(126);
    out += static_cast<char>((n >> 8) & 0xFF);
    out += static_cast<char>(n & 0xFF);
  } else {
    out += static_cast<char>(127);
    const auto v = static_cast<std::uint64_t>(n);
    for (int b = 7; b >= 0; --b) out += static_cast<char>((v >> (8 * b)) & 0xFF);
  }
  out.append(payload.data(), payload.size());
}

std::string wsClosePayload(std::uint16_t code, std::string_view reasonText) {
  std::string p;
  p += static_cast<char>(code >> 8);
  p += static_cast<char>(code & 0xFF);
  p.append(reasonText.substr(0, 123));
  return p;
}

WsParser::Event WsParser::fail(std::uint16_t code) {
  failCode_ = code;
  return {};
}

WsParser::Event WsParser::next() {
  if (failed()) return {};
  for (;;) {
    const std::size_t avail = buf_.size() - pos_;
    if (avail < 2) break;
    const auto *p = reinterpret_cast<const std::uint8_t *>(buf_.data() + pos_);
    const bool fin = (p[0] & 0x80) != 0;
    if (p[0] & 0x70) return fail(1002);
    const unsigned opc = p[0] & 0x0F;
    if (!(p[1] & 0x80)) return fail(1002);  // client frames must be masked
    std::uint64_t len = p[1] & 0x7F;
    std::size_t hdr = 2;
    if (len == 126) {
      if (avail < 4) break;
      len = (std::uint64_t{p[2]} << 8) | p[3];
      hdr = 4;
    } else if (len == 127) {
      if (avail < 10) break;
      len = 0;
      for (int b = 0; b < 8; ++b) len = (len << 8) | p[2 + b];
      hdr = 10;
    }
    const bool control = (opc & 0x8) != 0;
    if (control && (!fin || len > 125)) return fail(1002);
    if (!control && len > max_) return fail(1009);  // bounds len before any arithmetic with it
    if (avail < hdr + 4 + len) break;
    const std::uint8_t *mask = p + hdr;
    std::string payload(static_cast<std::size_t>(len), '\0');
    const std::uint8_t *src = mask + 4;
    for (std::size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<char>(src[i] ^ mask[i & 3]);
    pos_ += hdr + 4 + static_cast<std::size_t>(len);
    if (pos_ > 16384 && pos_ * 2 > buf_.size()) {
      buf_.erase(0, pos_);
      pos_ = 0;
    }
    Event ev;
    switch (opc) {
      case 0x0:
        if (!inMessage_) return fail(1002);
        if (msg_.size() + payload.size() > max_) return fail(1009);
        msg_ += payload;
        if (!fin) continue;
        inMessage_ = false;
        ev.kind = Event::Message;
        ev.binary = msgBinary_;
        ev.payload = std::move(msg_);
        msg_.clear();
        return ev;
      case 0x1:
      case 0x2:
        if (inMessage_) return fail(1002);
        if (!fin) {
          inMessage_ = true;
          msgBinary_ = opc == 0x2;
          msg_ = std::move(payload);
          continue;
        }
        ev.kind = Event::Message;
        ev.binary = opc == 0x2;
        ev.payload = std::move(payload);
        return ev;
      case 0x8:
        ev.kind = Event::Close;
        ev.closeCode = payload.size() >= 2 ? static_cast<std::uint16_t>((static_cast<std::uint8_t>(payload[0]) << 8)
                                                                        | static_cast<std::uint8_t>(payload[1]))
                                           : std::uint16_t{1005};
        ev.payload = std::move(payload);
        return ev;
      case 0x9:
        ev.kind = Event::Ping;
        ev.payload = std::move(payload);
        return ev;
      case 0xA:
        ev.kind = Event::Pong;
        ev.payload = std::move(payload);
        return ev;
      default:
        return fail(1002);
    }
  }
  return {};
}

}  // namespace rig::hostkit::remote
