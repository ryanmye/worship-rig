// Minimal HTTP/1.1 pieces for the dev host: parse one request head, resolve a static path safely, MIME types and
// response heads. GET/HEAD only; every response closes the connection (the UI fetches a few hundred files once).
#pragma once
#include <map>
#include <optional>
#include <string>
#include <string_view>

namespace devhost {

struct HttpRequest {
  std::string method;
  std::string target;  // raw request target ("/js/main.js?x=1")
  std::string path;    // percent-decoded path without the query ("/js/main.js")
  std::string query;   // after '?', raw
  std::map<std::string, std::string> headers;  // lower-case names, trimmed values

  std::string header(const std::string &lowerName) const {
    auto it = headers.find(lowerName);
    return it == headers.end() ? std::string() : it->second;
  }
  /** True for a valid WebSocket upgrade request (RFC 6455 4.2.1). */
  bool isWebSocketUpgrade() const;
};

/**
 * Parses a request head (everything up to and including the blank line). Returns nothing when `head` does not yet
 * contain "\r\n\r\n" (*complete = false) or when the head is malformed (*complete = true, nullopt).
 */
std::optional<HttpRequest> parseHttpRequest(std::string_view head, bool *complete, std::size_t *headLen);

/** Percent-decoding; nullopt on a bad escape or an encoded NUL. */
std::optional<std::string> percentDecode(std::string_view s);

/**
 * Maps a URL path below `root` (an absolute directory). Rejects "..", NUL, backslashes and anything that resolves
 * outside root (symlinks included). "/" and ".../" map to index.html. Returns the absolute file path or nullopt.
 */
std::optional<std::string> resolveStatic(const std::string &root, const std::string &urlPath);

/**
 * Whether a WebSocket upgrade may become the page (cross-site WebSocket hijacking guard; browsers let any site open
 * ws://127.0.0.1). Allowed: no Origin (not a browser: Node, the C++ tests), an http(s) loopback origin on any port
 * (127.0.0.1, localhost, [::1]: rig-devhost itself, or server.js with ?devhost=), or the request's own Host when it
 * is an IP literal (`--bind 0.0.0.0` from another machine). A DNS name that is not localhost never passes, so a
 * rebound name cannot either. "null" (file://, sandboxed frames) is refused.
 */
bool webSocketOriginAllowed(const std::string &origin, const std::string &host);

/** Content type by extension (text types carry charset=utf-8). */
const char *mimeFor(std::string_view path);

/** "HTTP/1.1 <code> <reason>" head with content type/length, no-store and Connection: close. */
std::string httpHead(int code, const char *contentType, std::size_t contentLength);

}  // namespace devhost
