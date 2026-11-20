// WebSocket codec (see ws_codec.h). SHA-1 per FIPS 180-4 (only used for the handshake accept key, not security).
#include "ws_codec.h"

#include <cstring>

namespace devhost {

namespace {

std::uint32_t rol(std::uint32_t x, int n) {
  return (x << n) | (x >> (32 - n));
}

void sha1Block(std::uint32_t h[5], const std::uint8_t *p) {
  std::uint32_t w[80];
  for (int i = 0; i < 16; ++i) {
    w[i] = (std::uint32_t{p[4 * i]} << 24) | (std::uint32_t{p[4 * i + 1]} << 16) | (std::uint32_t{p[4 * i + 2]} << 8) |
           std::uint32_t{p[4 * i + 3]};
  }
  for (int i = 16; i < 80; ++i) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  std::uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (int i = 0; i < 80; ++i) {
    std::uint32_t f, k;
    if (i < 20) {
      f = (b & c) | (~b & d);
      k = 0x5A827999u;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ED9EBA1u;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8F1BBCDCu;
    } else {
      f = b ^ c ^ d;
      k = 0xCA62C1D6u;
    }
    const std::uint32_t t = rol(a, 5) + f + e + k + w[i];
    e = d;
    d = c;
    c = rol(b, 30);
    b = a;
    a = t;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
}

}  // namespace

std::array<std::uint8_t, 20> sha1(std::string_view data) {
  std::uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
  const auto *p = reinterpret_cast<const std::uint8_t *>(data.data());
  std::size_t n = data.size();
  std::size_t i = 0;
  for (; i + 64 <= n; i += 64) sha1Block(h, p + i);
  std::uint8_t tail[128] = {};
  const std::size_t rest = n - i;
  if (rest) std::memcpy(tail, p + i, rest);
  tail[rest] = 0x80;
  const std::size_t blocks = rest + 9 <= 64 ? 1 : 2;
  const std::uint64_t bits = static_cast<std::uint64_t>(n) * 8u;
  for (int b = 0; b < 8; ++b) tail[blocks * 64 - 1 - b] = static_cast<std::uint8_t>(bits >> (8 * b));
  for (std::size_t b = 0; b < blocks; ++b) sha1Block(h, tail + 64 * b);
  std::array<std::uint8_t, 20> out{};
  for (int k = 0; k < 5; ++k) {
    for (int b = 0; b < 4; ++b) out[4 * k + b] = static_cast<std::uint8_t>(h[k] >> (24 - 8 * b));
  }
  return out;
}

std::string base64(const std::uint8_t *data, std::size_t len) {
  static const char *kAlpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  std::size_t i = 0;
  for (; i + 3 <= len; i += 3) {
    const std::uint32_t v = (std::uint32_t{data[i]} << 16) | (std::uint32_t{data[i + 1]} << 8) | data[i + 2];
    out += kAlpha[(v >> 18) & 63];
    out += kAlpha[(v >> 12) & 63];
    out += kAlpha[(v >> 6) & 63];
    out += kAlpha[v & 63];
  }
  if (len - i == 1) {
    const std::uint32_t v = std::uint32_t{data[i]} << 16;
    out += kAlpha[(v >> 18) & 63];
    out += kAlpha[(v >> 12) & 63];
    out += "==";
  } else if (len - i == 2) {
    const std::uint32_t v = (std::uint32_t{data[i]} << 16) | (std::uint32_t{data[i + 1]} << 8);
    out += kAlpha[(v >> 18) & 63];
    out += kAlpha[(v >> 12) & 63];
    out += kAlpha[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

std::string wsAcceptKey(std::string_view clientKey) {
  std::string s(clientKey);
  s += "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const auto d = sha1(s);
  return base64(d.data(), d.size());
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

std::string wsClosePayload(std::uint16_t code, std::string_view reason) {
  std::string p;
  p += static_cast<char>(code >> 8);
  p += static_cast<char>(code & 0xFF);
  p.append(reason.substr(0, 123));
  return p;
}

WsParser::Event WsParser::fail(std::uint16_t code, const char *why) {
  failCode_ = code;
  failReason_ = why;
  return {};
}

WsParser::Event WsParser::next() {
  if (failed()) return {};
  for (;;) {
    const std::size_t avail = buf_.size() - pos_;
    if (avail < 2) break;
    const auto *p = reinterpret_cast<const std::uint8_t *>(buf_.data() + pos_);
    const bool fin = (p[0] & 0x80) != 0;
    if (p[0] & 0x70) return fail(1002, "reserved bits set");
    const unsigned opc = p[0] & 0x0F;
    const bool masked = (p[1] & 0x80) != 0;
    if (!masked) return fail(1002, "client frame not masked");
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
    if (control && (!fin || len > 125)) return fail(1002, "bad control frame");
    if (!control && len > max_) return fail(1009, "message too big");
    if (avail < hdr + 4 + len) break;
    const std::uint8_t *mask = p + hdr;
    std::string payload(static_cast<std::size_t>(len), '\0');
    const std::uint8_t *src = mask + 4;
    for (std::size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<char>(src[i] ^ mask[i & 3]);
    pos_ += hdr + 4 + static_cast<std::size_t>(len);
    if (pos_ > 65536 && pos_ * 2 > buf_.size()) {  // compact the consumed prefix now and then
      buf_.erase(0, pos_);
      pos_ = 0;
    }
    Event ev;
    switch (opc) {
      case 0x0:
        if (!inMessage_) return fail(1002, "continuation without a message");
        if (msg_.size() + payload.size() > max_) return fail(1009, "message too big");
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
        if (inMessage_) return fail(1002, "new message inside a fragmented one");
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
        ev.closeCode = payload.size() >= 2
                           ? static_cast<std::uint16_t>((static_cast<std::uint8_t>(payload[0]) << 8) |
                                                        static_cast<std::uint8_t>(payload[1]))
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
        return fail(1002, "unknown opcode");
    }
  }
  return {};
}

}  // namespace devhost
