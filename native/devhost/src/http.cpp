// Minimal HTTP for the dev host (see http.h).
#include "http.h"

#include <algorithm>
#include <cctype>
#include <filesystem>

namespace devhost {

namespace {

std::string lower(std::string_view s) {
  std::string o(s);
  for (auto &c : o) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return o;
}

std::string_view trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r')) s.remove_suffix(1);
  return s;
}

bool hasToken(const std::string &list, const char *token) {
  std::string_view v = list;
  while (!v.empty()) {
    const std::size_t c = v.find(',');
    if (lower(trim(v.substr(0, c))) == token) return true;
    if (c == std::string_view::npos) break;
    v.remove_prefix(c + 1);
  }
  return false;
}

int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/** Lower-case host of "host[:port]" or "[v6][:port]" ("" when malformed). */
std::string hostOf(std::string_view hp) {
  if (!hp.empty() && hp.front() == '[') {
    const std::size_t e = hp.find(']');
    return e == std::string_view::npos ? std::string() : lower(hp.substr(0, e + 1));
  }
  return lower(hp.substr(0, hp.find(':')));
}

bool isIpLiteral(const std::string &h) {
  if (h.size() > 2 && h.front() == '[' && h.back() == ']') return true;
  int dots = 0;
  for (const char c : h) {
    if (c == '.') {
      ++dots;
    } else if (c < '0' || c > '9') {
      return false;
    }
  }
  return dots == 3;
}

}  // namespace

bool webSocketOriginAllowed(const std::string &origin, const std::string &host) {
  if (origin.empty()) return true;
  const std::string_view o = origin;
  const std::size_t p = o.find("://");
  if (p == std::string_view::npos) return false;
  const std::string scheme = lower(o.substr(0, p));
  if (scheme != "http" && scheme != "https") return false;
  const std::string_view hp = o.substr(p + 3);
  if (hp.empty() || hp.find('/') != std::string_view::npos) return false;
  const std::string h = hostOf(hp);
  if (h == "127.0.0.1" || h == "localhost" || h == "[::1]") return true;
  return isIpLiteral(h) && lower(hp) == lower(trim(host));
}

bool HttpRequest::isWebSocketUpgrade() const {
  return method == "GET" && hasToken(header("connection"), "upgrade") && lower(header("upgrade")) == "websocket" &&
         !header("sec-websocket-key").empty() && header("sec-websocket-version") == "13";
}

std::optional<std::string> percentDecode(std::string_view s) {
  std::string o;
  o.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] != '%') {
      o += s[i];
      continue;
    }
    if (i + 2 >= s.size()) return std::nullopt;
    const int hi = hexVal(s[i + 1]), lo = hexVal(s[i + 2]);
    if (hi < 0 || lo < 0 || (hi == 0 && lo == 0)) return std::nullopt;
    o += static_cast<char>(hi * 16 + lo);
    i += 2;
  }
  return o;
}

std::optional<HttpRequest> parseHttpRequest(std::string_view head, bool *complete, std::size_t *headLen) {
  const std::size_t end = head.find("\r\n\r\n");
  *complete = end != std::string_view::npos;
  if (!*complete) return std::nullopt;
  if (headLen) *headLen = end + 4;
  std::string_view h = head.substr(0, end + 2);
  const std::size_t eol = h.find("\r\n");
  std::string_view line = h.substr(0, eol);
  const std::size_t s1 = line.find(' ');
  const std::size_t s2 = s1 == std::string_view::npos ? s1 : line.find(' ', s1 + 1);
  if (s1 == std::string_view::npos || s2 == std::string_view::npos) return std::nullopt;
  HttpRequest r;
  r.method = std::string(line.substr(0, s1));
  r.target = std::string(line.substr(s1 + 1, s2 - s1 - 1));
  if (line.substr(s2 + 1).substr(0, 5) != "HTTP/") return std::nullopt;
  if (r.target.empty() || r.target[0] != '/') return std::nullopt;
  const std::size_t q = r.target.find('?');
  auto dec = percentDecode(std::string_view(r.target).substr(0, q));
  if (!dec) return std::nullopt;
  r.path = *dec;
  if (q != std::string::npos) r.query = r.target.substr(q + 1);
  h.remove_prefix(eol + 2);
  while (!h.empty()) {
    const std::size_t e = h.find("\r\n");
    std::string_view hl = h.substr(0, e);
    h.remove_prefix(e == std::string_view::npos ? h.size() : e + 2);
    if (hl.empty()) continue;
    const std::size_t colon = hl.find(':');
    if (colon == std::string_view::npos || colon == 0) return std::nullopt;
    r.headers[lower(trim(hl.substr(0, colon)))] = std::string(trim(hl.substr(colon + 1)));
  }
  return r;
}

std::optional<std::string> resolveStatic(const std::string &root, const std::string &urlPath) {
  namespace fs = std::filesystem;
  if (urlPath.empty() || urlPath[0] != '/') return std::nullopt;
  if (urlPath.find('\0') != std::string::npos || urlPath.find('\\') != std::string::npos) return std::nullopt;
  std::string rel = urlPath.substr(1);
  // no ".." segment at all (before any normalisation), so "/a/../b" is refused rather than rewritten
  std::size_t i = 0;
  while (i <= rel.size()) {
    const std::size_t j = std::min(rel.find('/', i), rel.size());
    if (rel.compare(i, j - i, "..") == 0 && j - i == 2) return std::nullopt;
    i = j + 1;
  }
  if (rel.empty() || rel.back() == '/') rel += "index.html";
  std::error_code ec;
  const fs::path base = fs::weakly_canonical(fs::path(root), ec);
  if (ec) return std::nullopt;
  const fs::path full = fs::weakly_canonical(base / rel, ec);
  if (ec) return std::nullopt;
  const std::string b = base.string(), f = full.string();
  if (f.size() <= b.size() || f.compare(0, b.size(), b) != 0 || f[b.size()] != '/') return std::nullopt;
  if (!fs::is_regular_file(full, ec)) return std::nullopt;
  return f;
}

const char *mimeFor(std::string_view path) {
  struct M {
    const char *ext, *type;
  };
  static const M kTypes[] = {
      {".html", "text/html; charset=utf-8"}, {".js", "text/javascript; charset=utf-8"},
      {".mjs", "text/javascript; charset=utf-8"}, {".css", "text/css; charset=utf-8"},
      {".json", "application/json"}, {".svg", "image/svg+xml"}, {".png", "image/png"},
      {".jpg", "image/jpeg"}, {".woff2", "font/woff2"}, {".ico", "image/x-icon"},
      {".md", "text/plain; charset=utf-8"}, {".txt", "text/plain; charset=utf-8"}, {".mp3", "audio/mpeg"},
      {".wav", "audio/wav"}, {".m4a", "audio/mp4"}, {".webmanifest", "application/manifest+json"},
  };
  for (const auto &m : kTypes) {
    const std::string_view e = m.ext;
    if (path.size() >= e.size() && lower(path.substr(path.size() - e.size())) == e) return m.type;
  }
  return "application/octet-stream";
}

std::string httpHead(int code, const char *contentType, std::size_t contentLength) {
  const char *reason = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request"
                     : code == 403 ? "Forbidden" : code == 404 ? "Not Found"
                     : code == 405 ? "Method Not Allowed" : "Error";
  std::string h = "HTTP/1.1 " + std::to_string(code) + " " + reason + "\r\n";
  if (code != 204) {
    h += "Content-Type: ";
    h += contentType;
    h += "\r\nContent-Length: " + std::to_string(contentLength) + "\r\n";
  }
  h += "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
  return h;
}

}  // namespace devhost
