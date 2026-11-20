// WebSocket (RFC 6455) codec for the dev host: SHA-1 + base64 for the opening handshake, an incremental frame
// parser for client frames and a frame encoder for server frames. No sockets here (server.cpp owns them), so every
// piece is unit-tested on byte strings (tests/test_ws_codec.cpp). Only what a browser page needs: text/binary data
// frames with fragmentation, ping/pong/close, client masking enforced, 64-bit lengths, a message size cap.
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace devhost {

/** SHA-1 digest (20 bytes) of `data`. */
std::array<std::uint8_t, 20> sha1(std::string_view data);

/** Standard base64 with padding. */
std::string base64(const std::uint8_t *data, std::size_t len);

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key` (RFC 6455 section 4.2.2). */
std::string wsAcceptKey(std::string_view clientKey);

enum class WsOp : std::uint8_t { Continuation = 0x0, Text = 0x1, Binary = 0x2, Close = 0x8, Ping = 0x9, Pong = 0xA };

/** Encodes one unmasked server frame (FIN set) with `op` and `payload` into `out` (appended). */
void wsEncodeFrame(std::string &out, WsOp op, std::string_view payload);

/** Close frame payload: 2-byte status code + UTF-8 reason (truncated to fit a control frame). */
std::string wsClosePayload(std::uint16_t code, std::string_view reason);

/**
 * Incremental parser of client frames. feed() consumes bytes; complete messages and control frames are reported
 * through next(). Errors (unmasked client frame, reserved bits, bad opcode, fragmented control frame, oversize
 * message, continuation without a start) put the parser in a failed state with the close code to send.
 */
class WsParser {
 public:
  explicit WsParser(std::size_t maxMessage = 16u << 20) : max_(maxMessage) {}

  struct Event {
    enum Kind { None, Message, Ping, Pong, Close } kind = None;
    bool binary = false;          // Message: binary vs text
    std::string payload;          // Message/Ping/Pong payload; Close: the raw close payload
    std::uint16_t closeCode = 0;  // Close: status code (1005 when absent)
  };

  /** Appends bytes to the internal buffer. */
  void feed(const char *data, std::size_t len) { buf_.append(data, len); }

  /** Next event from the buffered bytes (kind None when more bytes are needed or after a failure). */
  Event next();

  bool failed() const { return failCode_ != 0; }
  std::uint16_t failCode() const { return failCode_; }
  const std::string &failReason() const { return failReason_; }
  std::size_t buffered() const { return buf_.size() - pos_; }

 private:
  Event fail(std::uint16_t code, const char *why);
  std::string buf_;
  std::size_t pos_ = 0;
  std::size_t max_;
  bool inMessage_ = false;
  bool msgBinary_ = false;
  std::string msg_;
  std::uint16_t failCode_ = 0;
  std::string failReason_;
};

}  // namespace devhost
