// The browser remote's server (remote lane, D45). See remote_server.h and native/docs/lanes/REMOTE.md §2.4.
#include "remote_server.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <map>

#if defined(__APPLE__)
#include <sys/random.h>
#endif

#include "js_json.h"
#include "js_text.h"
#include "qrcodegen.hpp"
#include "remote_net.h"

namespace rig::hostkit::remote {

namespace {

constexpr std::size_t kMaxIn = kMaxHead + kMaxBody;  // an HTTP request; a WebSocket reads in frames instead
constexpr std::size_t kMaxOut = 256 * 1024;          // a client that stops reading is dropped

void systemRandom(std::uint8_t *p, std::size_t n) {
  while (n > 0) {
    const std::size_t k = n < 256 ? n : 256;
    if (getentropy(p, k) != 0) std::abort();  // no randomness = no safe tokens: never fall back to something weak
    p += k;
    n -= k;
  }
}

std::int64_t steadyMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

void setNonBlocking(int fd) {
  const int fl = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, fl | O_NONBLOCK);
  fcntl(fd, F_SETFD, FD_CLOEXEC);
#if defined(SO_NOSIGPIPE)
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
}

#if defined(MSG_NOSIGNAL)
constexpr int kSendFlags = MSG_NOSIGNAL;
#else
constexpr int kSendFlags = 0;
#endif

/** Peer address as text, and whether it is on the local network. */
bool peerOf(const sockaddr_storage &ss, std::string *ip) {
  char buf[INET6_ADDRSTRLEN] = {0};
  if (ss.ss_family == AF_INET) {
    const auto *a = reinterpret_cast<const sockaddr_in *>(&ss);
    inet_ntop(AF_INET, &a->sin_addr, buf, sizeof buf);
    *ip = buf;
    return isLocalIPv4(ntohl(a->sin_addr.s_addr));
  }
  if (ss.ss_family == AF_INET6) {
    const auto *a = reinterpret_cast<const sockaddr_in6 *>(&ss);
    std::array<std::uint8_t, 16> b{};
    std::memcpy(b.data(), &a->sin6_addr, 16);
    static const std::uint8_t mapped[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF};
    if (std::memcmp(b.data(), mapped, 12) == 0) {
      in_addr v4;
      std::memcpy(&v4, b.data() + 12, 4);
      inet_ntop(AF_INET, &v4, buf, sizeof buf);
    } else {
      // one IPv6 host has a whole /64 to pick addresses from: limits count per /64 (skeptic-2 F8)
      in6_addr net{};
      std::memcpy(&net, b.data(), 8);
      inet_ntop(AF_INET6, &net, buf, sizeof buf);
      *ip = std::string(buf) + "/64";
      return isLocalIPv6(b);
    }
    *ip = buf;
    return isLocalIPv6(b);
  }
  return false;
}

std::string quote(std::string_view s) {
  std::string out;
  jsonQuote(s, out);
  return out;
}

/** A small JSON object body's string field, or "" (bodies are ≤ kMaxBody; depth 2 is plenty). */
std::string stringField(std::string_view body, std::string_view key) {
  ParseResult p = jsonParse(decodeUtf8(body), 2);
  if (!p.ok || p.tooDeep || p.value.type != JVal::Obj) return {};
  const JVal *v = p.value.get(key);
  return v && v->type == JVal::Str ? v->str : std::string();
}

}  // namespace

struct Server::Client {
  int fd = -1;
  std::string ip;
  bool ws = false;
  bool closing = false;  // close once `out` is flushed
  std::int64_t closeBy = 0;  // …or at this time, flushed or not (a peer that stops reading; skeptic-2 C2)
  bool dead = false;
  std::string in, out;
  std::int64_t since = 0;         // accept time (HTTP) / last message (WS)
  std::int64_t openedAt = 0;
  // long poll
  bool polling = false;
  std::uint64_t pollSince = 0;
  std::int64_t pollDeadline = 0;
  std::string host;
  // WebSocket
  WsParser parser;
  bool authed = false;
  std::string token;
  std::uint64_t sentSeq = 0;
  std::uint64_t forgetEpoch = 0;
};

Server::Server(ServerHooks hooks, Limits limits, ServerTimeouts timeouts, Service::NowMs now, Service::Random random)
    : hooks_(std::move(hooks)),
      to_(timeouts),
      now_(now ? std::move(now) : Service::NowMs(steadyMs)),
      svc_(limits, now_, random ? std::move(random) : Service::Random(systemRandom)) {
  infoSeen_ = svc_.infoVersion();
}

Server::~Server() {
  destroying_ = true;
  stop();
}

std::int64_t Server::nowMs() const { return now_(); }

void Server::setPage(std::string html) {
  std::lock_guard<std::mutex> g(mu_);
  page_ = std::move(html);
}

bool Server::start(const StartOptions &opt, std::string *err) {
  if (running_.load()) return true;
  auto fail = [&](const std::string &why) {
    if (err) *err = why + (errno ? std::string(": ") + std::strerror(errno) : std::string());
    if (listenFd_ >= 0) close(listenFd_);
    listenFd_ = -1;
    return false;
  };
  errno = 0;
  std::vector<int> ports;
  if (opt.anyPort) ports = {0};
  else if (opt.port > 0) ports = {opt.port};
  else for (int p = 8450; p <= 8459; ++p) ports.push_back(p);
  for (int p : ports) {
    int fd = -1;
    bool ok = false;
    if (opt.bind.empty()) {  // every interface: IPv6 dual stack, else IPv4
      fd = socket(AF_INET6, SOCK_STREAM, 0);
      if (fd >= 0) {
        int one = 1, zero = 0;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof zero);
        sockaddr_in6 a{};
        a.sin6_family = AF_INET6;
        a.sin6_addr = in6addr_any;
        a.sin6_port = htons(static_cast<std::uint16_t>(p));
        ok = bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) == 0;
        if (!ok) {
          close(fd);
          fd = -1;
        }
      }
    }
    if (!ok) {
      fd = socket(AF_INET, SOCK_STREAM, 0);
      if (fd < 0) return fail("socket");
      int one = 1;
      setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
      sockaddr_in a{};
      a.sin_family = AF_INET;
      a.sin_port = htons(static_cast<std::uint16_t>(p));
      if (opt.bind.empty()) a.sin_addr.s_addr = htonl(INADDR_ANY);
      else if (inet_pton(AF_INET, opt.bind.c_str(), &a.sin_addr) != 1) {
        close(fd);
        errno = 0;
        return fail("bad bind address " + opt.bind);
      }
      ok = bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) == 0;
      if (!ok) {
        close(fd);
        fd = -1;
        continue;
      }
    }
    listenFd_ = fd;
    break;
  }
  if (listenFd_ < 0) return fail("no free port");
  if (listen(listenFd_, 16) != 0) return fail("listen");
  setNonBlocking(listenFd_);
  sockaddr_storage bound{};
  socklen_t bl = sizeof bound;
  getsockname(listenFd_, reinterpret_cast<sockaddr *>(&bound), &bl);
  port_ = ntohs(bound.ss_family == AF_INET6 ? reinterpret_cast<sockaddr_in6 *>(&bound)->sin6_port
                                            : reinterpret_cast<sockaddr_in *>(&bound)->sin_port);
  {
    std::lock_guard<std::mutex> g(wakeMu_);
    if (pipe(wakeFds_) != 0) return fail("pipe");
    setNonBlocking(wakeFds_[0]);
    setNonBlocking(wakeFds_[1]);
  }
  {
    std::lock_guard<std::mutex> g(mu_);
    svc_.openPairing();  // switched on: phones can pair for a few minutes (REMOTE.md §2.3)
  }
  stop_ = false;
  running_ = true;
  thread_ = std::thread([this] { loop(); });
  notifyInfo();
  return true;
}

void Server::stop() {
  if (!running_.exchange(false)) return;
  stop_ = true;
  wake();
  if (thread_.joinable()) thread_.join();
  for (auto &c : clients_) close(c->fd);
  clients_.clear();
  close(listenFd_);
  listenFd_ = -1;
  {
    std::lock_guard<std::mutex> g(wakeMu_);
    close(wakeFds_[0]);
    close(wakeFds_[1]);
    wakeFds_[0] = wakeFds_[1] = -1;
  }
  port_ = 0;
  {
    std::lock_guard<std::mutex> g(mu_);
    svc_.forgetAll();  // switching the remote off ends every pairing (REMOTE.md §2.3)
    svc_.newCode(true);
  }
  if (!destroying_) notifyInfo();
}

void Server::wake() {
  std::lock_guard<std::mutex> g(wakeMu_);
  if (wakeFds_[1] >= 0) {
    const char b = 1;
    [[maybe_unused]] auto n = write(wakeFds_[1], &b, 1);  // non-blocking: a full pipe already means "wake up"
  }
}

bool Server::publishState(std::string_view json) {
  bool ok;
  {
    std::lock_guard<std::mutex> g(mu_);
    ok = svc_.setState(json);
  }
  if (ok) wake();
  return ok;
}

void Server::newCode() {
  {
    std::lock_guard<std::mutex> g(mu_);
    svc_.newCode(true);  // Settings "New code": a person at the Mac also ends a pause
  }
  notifyInfo();
}

void Server::forgetAll() {
  {
    std::lock_guard<std::mutex> g(mu_);
    svc_.forgetAll();
  }
  ++forgetEpoch_;
  wake();  // open WebSockets are closed on the server thread
  notifyInfo();
}

void Server::notifyInfo() {
  {
    std::lock_guard<std::mutex> g(mu_);
    infoSeen_ = svc_.infoVersion();
  }
  if (hooks_.info) hooks_.info();
}

std::string Server::infoJson() {
  std::string code;
  std::size_t paired;
  std::int64_t paused, pairing;
  {
    std::lock_guard<std::mutex> g(mu_);
    code = svc_.code();
    paired = svc_.pairedCount();
    paused = svc_.pausedMs();
    pairing = svc_.pairingMs();
  }
  const bool on = running_.load();
  std::string j = "{\"on\":";
  j += on ? "true" : "false";
  const std::uint16_t port = port_.load();
  j += ",\"port\":" + std::to_string(on ? port : 0);
  j += ",\"code\":" + quote(code) + ",\"paired\":" + std::to_string(paired);
  j += ",\"pausedSec\":" + std::to_string((paused + 999) / 1000);
  j += ",\"pairingSec\":" + std::to_string(on ? (pairing + 999) / 1000 : 0);
  j += ",\"addresses\":[";
  std::string url;
  if (on) {
    const auto addrs = localAddresses();
    for (std::size_t i = 0; i < addrs.size(); ++i) {
      if (i) j += ",";
      j += "{\"name\":" + quote(addrs[i].first) + ",\"ip\":" + quote(addrs[i].second) + "}";
    }
    if (!addrs.empty()) url = "http://" + addrs[0].second + ":" + std::to_string(port) + "/";
  }
  j += "],\"url\":" + (url.empty() ? std::string("null") : quote(url));
  if (!url.empty()) {
    const std::string pairUrl = url + "#p=" + code;
    j += ",\"pairUrl\":" + quote(pairUrl) + ",\"qr\":" + qrJson(pairUrl);
  } else {
    j += ",\"pairUrl\":null,\"qr\":null";
  }
  return j + "}";
}

// ---- the server thread

void Server::loop() {
  while (!stop_.load()) {
    try {
      loopOnce();
    } catch (...) {  // out of memory with a client's buffers: drop every connection rather than the process
      for (auto &c : clients_) close(c->fd);
      clients_.clear();
    }
  }
}

void Server::loopOnce() {
  std::vector<pollfd> fds;
  {
    fds.clear();
    fds.push_back({listenFd_, POLLIN, 0});
    fds.push_back({wakeFds_[0], POLLIN, 0});
    for (auto &c : clients_) {
      short ev = POLLIN;
      if (!c->out.empty()) ev |= POLLOUT;
      fds.push_back({c->fd, ev, 0});
    }
    poll(fds.data(), static_cast<nfds_t>(fds.size()), 200);
    if (stop_.load()) return;
    if (fds[1].revents & POLLIN) {
      char buf[64];
      while (read(wakeFds_[0], buf, sizeof buf) > 0) {
      }
    }
    if (fds[0].revents & POLLIN) acceptAll();
    // clients_ may have grown in acceptAll: only the ones polled have an entry
    for (std::size_t i = 2; i < fds.size(); ++i) {
      Client &c = *clients_[i - 2];
      if (c.dead) continue;
      if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) onReadable(c);
      if (!c.dead && !c.out.empty() && (fds[i].revents & POLLOUT)) flush(c);
    }
    // forgotten pairings: close their WebSockets and drop their long polls
    const std::uint64_t epoch = forgetEpoch_.load();
    if (epoch != seenForgetEpoch_) {
      seenForgetEpoch_ = epoch;
      for (auto &c : clients_) {
        if (c->ws && c->authed) wsClose(*c, 4001, "not-paired");
        if (c->polling) {
          c->polling = false;
          respond(*c, 401, "application/json", "{\"error\":\"not-paired\"}");
        }
      }
    }
    dropStaleTokens();
    pushViews();
    // timeouts
    const std::int64_t t = nowMs();
    for (auto &c : clients_) {
      if (c->dead) continue;
      if (c->closing) {
        if (t >= c->closeBy) c->dead = true;  // a peer that never reads its reply
        continue;
      }
      if (c->ws) {
        if (!c->authed && t - c->openedAt > to_.wsAuthMs) wsClose(*c, 4001, "auth timeout");
        else if (t - c->since > to_.wsIdleMs) wsClose(*c, 1001, "idle");
      } else if (c->polling) {
        if (t >= c->pollDeadline) {
          c->polling = false;
          std::string view;
          {
            std::lock_guard<std::mutex> g(mu_);
            view = svc_.viewJson();
          }
          respond(*c, 200, "application/json", view);
        }
      } else if (t - c->since > to_.httpMs || (c->in.empty() && t - c->openedAt > kFirstByteMs)) {
        c->dead = true;  // slow, or connected and silent (skeptic-2 F8)
      }
    }
    // hand out commands and info changes without the lock
    std::vector<std::string> cmds;
    bool infoChanged;
    {
      std::lock_guard<std::mutex> g(mu_);
      cmds.swap(pending_);
      const bool pairing = svc_.pairingMs() > 0, paused = svc_.pausedMs() > 0;
      infoChanged = svc_.infoVersion() != infoSeen_ || pairing != pairingSeen_ || paused != pausedSeen_;
      pairingSeen_ = pairing;
      pausedSeen_ = paused;
    }
    for (const std::string &m : cmds) {
      if (hooks_.command) hooks_.command(m);
    }
    if (infoChanged) notifyInfo();
    // reap
    for (auto &c : clients_) {
      if (c->closing && c->out.empty()) c->dead = true;
      if (c->dead && c->fd >= 0) close(c->fd);
    }
    clients_.erase(std::remove_if(clients_.begin(), clients_.end(), [](const auto &c) { return c->dead; }),
                   clients_.end());
  }
}

void Server::acceptAll() {
  for (;;) {
    sockaddr_storage ss{};
    socklen_t sl = sizeof ss;
    const int fd = accept(listenFd_, reinterpret_cast<sockaddr *>(&ss), &sl);
    if (fd < 0) return;
    std::string ip;
    const bool local = peerOf(ss, &ip);
    if (!local) {
      close(fd);  // not on the local network: no reply at all
      continue;
    }
    // full: make room by dropping the oldest connection that hasn't proved anything yet (no request served, no
    // paired WebSocket), from this IP when it is the IP that is full; else refuse the newcomer (skeptic-2 F8: idle
    // sockets that reconnect at once could hold every slot)
    auto live = [](const auto &c) { return !c->dead && !c->closing; };
    auto unproven = [&](const auto &c) { return live(c) && !c->polling && (c->ws ? !c->authed : true); };
    const auto perIp = std::count_if(clients_.begin(), clients_.end(),
                                     [&](const auto &c) { return !c->dead && c->ip == ip; });
    const auto total = std::count_if(clients_.begin(), clients_.end(), [](const auto &c) { return !c->dead; });
    const bool ipFull = perIp >= kMaxClientsPerIp, allFull = total >= kMaxClients;
    if (ipFull || allFull) {
      Client *victim = nullptr;
      for (auto &c : clients_) {
        if (!unproven(c) || (ipFull && c->ip != ip)) continue;
        if (!victim || c->openedAt < victim->openedAt) victim = c.get();
      }
      if (!victim) {
        close(fd);
        continue;
      }
      victim->dead = true;
      close(victim->fd);
      victim->fd = -1;
    }
    setNonBlocking(fd);
    auto c = std::make_unique<Client>();
    c->fd = fd;
    c->ip = ip;
    c->since = c->openedAt = nowMs();
    clients_.push_back(std::move(c));
  }
}

void Server::onReadable(Client &c) {
  char buf[4096];
  for (;;) {
    const ssize_t n = recv(c.fd, buf, sizeof buf, 0);
    if (n > 0) {
      if (c.closing || (c.ws && c.parser.failed())) continue;  // closing: drain and drop (skeptic-2 C1)
      if (c.ws) {
        c.parser.feed(buf, static_cast<std::size_t>(n));
        if (c.parser.buffered() > 2 * kMaxWsMessage + 64) {  // a frame bigger than allowed is refused by the parser;
          wsClose(c, 1009, "too big");                         // this bounds what it can make us hold before that
          return;
        }
      } else {
        if (c.polling) continue;  // one request per connection: ignore anything after it
        c.in.append(buf, static_cast<std::size_t>(n));
        if (c.in.size() > kMaxIn) {
          respond(c, 413, "text/plain", "too large");
          return;
        }
      }
      continue;
    }
    if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
      c.dead = true;
      return;
    }
    break;
  }
  if (c.ws) onWs(c);
  else if (!c.closing && !c.polling) onHttp(c);
}

void Server::closeLater(Client &c) {
  if (c.closing) return;
  c.closing = true;
  c.closeBy = nowMs() + 5000;
}

void Server::respond(Client &c, int code, std::string_view type, std::string_view body, std::string_view extra) {
  c.out += httpResponse(code, type, body, extra);
  closeLater(c);
  flush(c);
}

void Server::flush(Client &c) {
  while (!c.out.empty()) {
    const ssize_t n = send(c.fd, c.out.data(), c.out.size(), kSendFlags);
    if (n > 0) {
      c.out.erase(0, static_cast<std::size_t>(n));
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) break;
    c.dead = true;
    return;
  }
  if (c.out.size() > kMaxOut) c.dead = true;
}

void Server::onHttp(Client &c) {
  HttpRequest req;
  std::size_t headLen = 0;
  switch (parseHead(c.in, &req, &headLen)) {
    case HeadStatus::Incomplete: return;
    case HeadStatus::Bad: return respond(c, 400, "text/plain", "bad request");
    case HeadStatus::TooLarge: return respond(c, 431, "text/plain", "too large");
    case HeadStatus::Unsupported: return respond(c, 501, "text/plain", "not supported");
    case HeadStatus::Ok: break;
  }
  if (c.in.size() < headLen + req.contentLength) return;  // the body is still coming
  const std::string body = c.in.substr(headLen, req.contentLength);
  c.in.clear();
  bool allowed;
  {
    std::lock_guard<std::mutex> g(mu_);
    allowed = svc_.allowRequest(c.ip);
  }
  if (!allowed) return respond(c, 429, "application/json", "{\"error\":\"rate-limited\"}", "Retry-After: 1\r\n");
  const std::string host = req.header("host");
  if (!hostAllowed(host)) return respond(c, 403, "text/plain", "host not allowed");
  c.host = host;
  const bool originOk = originAllowed(req.header("origin"), host);
  const std::string token = req.header("x-rig-token");
  const std::string &p = req.path;

  if ((req.method == "GET" || req.method == "HEAD") && (p == "/" || p == "/index.html")) {
    std::string page;
    {
      std::lock_guard<std::mutex> g(mu_);
      page = page_;
    }
    // inline script and style only (one file), nothing from anywhere else; connect to this host's WebSocket
    const std::string csp = "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; "
                            "style-src 'unsafe-inline'; img-src data:; connect-src 'self' ws://" + host +
                            "; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n";
    if (page.empty()) return respond(c, 503, "text/plain", "page not set");
    return respond(c, 200, "text/html; charset=utf-8", req.method == "HEAD" ? std::string() : page, csp);
  }
  if (req.method == "GET" && p == "/favicon.ico") return respond(c, 204, "", "");
  if (p == "/ws") {
    if (!isWsUpgrade(req)) return respond(c, 400, "text/plain", "bad upgrade");
    if (!originOk) return respond(c, 403, "text/plain", "origin not allowed");
    c.out += httpResponse(101, "", "",
                          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                              + wsAcceptKey(req.header("sec-websocket-key")) + "\r\n");
    c.ws = true;
    c.since = c.openedAt = nowMs();
    c.forgetEpoch = forgetEpoch_.load();
    flush(c);
    return;
  }
  if (p == "/api/pair" || p == "/api/cmd" || p == "/api/state") {
    if (p == "/api/state" ? req.method != "GET" : req.method != "POST") {
      return respond(c, 405, "application/json", "{\"error\":\"method\"}");
    }
    if (!originOk) return respond(c, 403, "application/json", "{\"error\":\"origin\"}");
    // JSON only: a cross-site form can't send it without a CORS preflight, which never succeeds here (skeptic-2 N3)
    std::string ct = req.header("content-type");
    for (char &ch : ct) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    if (req.method == "POST" && ct.rfind("application/json", 0) != 0) {
      return respond(c, 415, "application/json", "{\"error\":\"content-type\"}");
    }
  }
  if (p == "/api/pair") {
    PairResult r;
    {
      std::lock_guard<std::mutex> g(mu_);
      r = svc_.pair(c.ip, stringField(body, "code"));
    }
    if (r.status == 200) return respond(c, 200, "application/json", "{\"token\":" + quote(r.token) + "}");
    return respond(c, r.status, "application/json", "{\"error\":" + quote(r.error) + "}",
                   r.retryAfterSec ? "Retry-After: " + std::to_string(r.retryAfterSec) + "\r\n" : std::string());
  }
  if (p == "/api/cmd") {
    CommandResult r;
    {
      std::lock_guard<std::mutex> g(mu_);
      r = svc_.command(token, body);
      if (r.bus) pending_.push_back(*r.bus);
    }
    return respond(c, r.status, "application/json", r.replyJson);
  }
  if (p == "/api/state") {
    std::string view;
    std::uint64_t seq;
    bool valid;
    {
      std::lock_guard<std::mutex> g(mu_);
      valid = svc_.tokenValid(token);
      view = svc_.viewJson();
      seq = svc_.seq();
    }
    if (!valid) return respond(c, 401, "application/json", "{\"error\":\"not-paired\"}");
    const auto since = queryNumber(req.query, "since");
    if (since && *since == seq) {  // nothing new yet: hold the request until something changes (long poll)
      c.polling = true;
      c.pollSince = seq;
      c.pollDeadline = nowMs() + to_.longPollMs;
      c.token = token;
      return;
    }
    return respond(c, 200, "application/json", view);
  }
  if (req.method == "OPTIONS") return respond(c, 405, "text/plain", "no");  // no CORS: other sites get nothing
  return respond(c, 404, "text/plain", "not found");
}

void Server::wsSend(Client &c, std::string_view text) {
  wsEncodeFrame(c.out, WsOp::Text, text);
  flush(c);
}

void Server::wsClose(Client &c, std::uint16_t code, std::string_view why) {
  if (c.closing) return;
  wsEncodeFrame(c.out, WsOp::Close, wsClosePayload(code, why));
  closeLater(c);
  flush(c);
}

void Server::onWs(Client &c) {
  for (;;) {
    WsParser::Event ev = c.parser.next();
    if (c.parser.failed()) return wsClose(c, c.parser.failCode(), "protocol");
    if (ev.kind == WsParser::Event::None) return;
    c.since = nowMs();
    if (c.closing) continue;
    switch (ev.kind) {
      case WsParser::Event::Ping: {
        bool allowed;
        {
          std::lock_guard<std::mutex> g(mu_);
          allowed = svc_.allowRequest(c.ip);  // pings cost a pong: the same budget as messages (skeptic-2 F1)
        }
        if (!allowed) return wsClose(c, 1008, "rate-limited");
        wsEncodeFrame(c.out, WsOp::Pong, ev.payload);
        flush(c);
        break;
      }
      case WsParser::Event::Close:
        wsEncodeFrame(c.out, WsOp::Close, wsClosePayload(1000, ""));
        closeLater(c);
        flush(c);
        return;
      case WsParser::Event::Message: {
        if (ev.binary) return wsClose(c, 1003, "text only");
        bool allowed;
        {
          std::lock_guard<std::mutex> g(mu_);
          allowed = svc_.allowRequest(c.ip);
        }
        if (!allowed) return wsClose(c, 1008, "rate-limited");
        if (!c.authed) {
          const std::string tok = stringField(ev.payload, "auth");
          std::string view;
          bool valid;
          {
            std::lock_guard<std::mutex> g(mu_);
            valid = !tok.empty() && svc_.tokenValid(tok);
            view = svc_.viewJson();
            c.sentSeq = svc_.seq();
          }
          if (!valid) return wsClose(c, 4001, "not-paired");
          c.authed = true;
          c.token = tok;
          wsSend(c, view);
          break;
        }
        if (ev.payload == "{\"ping\":1}") {
          wsSend(c, "{\"pong\":1}");
          break;
        }
        CommandResult r;
        {
          std::lock_guard<std::mutex> g(mu_);
          r = svc_.command(c.token, ev.payload);
          if (r.bus) pending_.push_back(*r.bus);
        }
        if (r.status == 401) return wsClose(c, 4001, "not-paired");
        wsSend(c, r.replyJson);
        break;
      }
      default:
        break;
    }
  }
}

/** A token dropped meanwhile (the 9th phone evicted the least recent, forgetAll): its WebSocket and long poll end
 *  too (skeptic-2 C10). At most 16 clients × 8 tokens: cheap every turn. */
void Server::dropStaleTokens() {
  std::vector<Client *> gone;
  {
    std::lock_guard<std::mutex> g(mu_);
    for (auto &c : clients_) {
      if (c->dead || c->closing) continue;
      if (((c->ws && c->authed) || c->polling) && !svc_.hasToken(c->token)) gone.push_back(c.get());
    }
  }
  for (Client *c : gone) {
    if (c->ws) wsClose(*c, 4001, "not-paired");
    else {
      c->polling = false;
      respond(*c, 401, "application/json", "{\"error\":\"not-paired\"}");
    }
  }
}

void Server::pushViews() {
  std::string view;
  std::uint64_t seq;
  {
    std::lock_guard<std::mutex> g(mu_);
    seq = svc_.seq();
    if (seq == lastSeq_) return;
    view = svc_.viewJson();
  }
  lastSeq_ = seq;
  for (auto &c : clients_) {
    if (c->dead || c->closing) continue;
    if (c->ws && c->authed && c->sentSeq != seq) {
      c->sentSeq = seq;
      wsSend(*c, view);
    } else if (c->polling && c->pollSince != seq) {
      c->polling = false;
      respond(*c, 200, "application/json", view);
    }
  }
}

// ---- addresses and QR

std::vector<std::pair<std::string, std::string>> localAddresses() {
  std::vector<std::pair<std::string, std::string>> out;
  ifaddrs *list = nullptr;
  if (getifaddrs(&list) != 0) return out;
  for (ifaddrs *i = list; i; i = i->ifa_next) {
    if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET) continue;
    if (!(i->ifa_flags & IFF_UP) || (i->ifa_flags & IFF_LOOPBACK)) continue;
    const auto *a = reinterpret_cast<const sockaddr_in *>(i->ifa_addr);
    const std::uint32_t h = ntohl(a->sin_addr.s_addr);
    if (!isLocalIPv4(h) || (h >> 24) == 127) continue;
    char buf[INET_ADDRSTRLEN] = {0};
    inet_ntop(AF_INET, &a->sin_addr, buf, sizeof buf);
    out.emplace_back(i->ifa_name ? i->ifa_name : "", buf);
  }
  freeifaddrs(list);
  auto rank = [](const std::pair<std::string, std::string> &p) {
    if (p.second.rfind("169.254.", 0) == 0) return 9;  // link-local: no DHCP; a phone rarely reaches it
    if (p.first == "en0") return 0;
    if (p.first == "en1") return 1;
    if (p.first.rfind("en", 0) == 0 || p.first.rfind("eth", 0) == 0 || p.first.rfind("wl", 0) == 0) return 2;
    if (p.first.rfind("bridge", 0) == 0) return 3;  // Internet Sharing: a phone on the Mac's own hotspot
    return 5;                                        // utun (VPN), docker…: last
  };
  std::stable_sort(out.begin(), out.end(), [&](const auto &a, const auto &b) { return rank(a) < rank(b); });
  return out;
}

std::string qrJson(const std::string &text) {
  const qrcodegen::QrCode qr = qrcodegen::QrCode::encodeText(text.c_str(), qrcodegen::QrCode::Ecc::MEDIUM);
  const int n = qr.getSize();
  std::string modules;
  modules.reserve(static_cast<std::size_t>(n * n));
  for (int y = 0; y < n; ++y) {
    for (int x = 0; x < n; ++x) modules += qr.getModule(x, y) ? '1' : '0';
  }
  return "{\"size\":" + std::to_string(n) + ",\"modules\":\"" + modules + "\"}";
}

}  // namespace rig::hostkit::remote
