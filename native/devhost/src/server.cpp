// HTTP + WebSocket poll loop (see server.h).
#include "server.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>

#include "ws_codec.h"

namespace devhost {

namespace {

constexpr std::size_t kMaxHead = 64 * 1024;
constexpr std::size_t kMaxOutBuffered = 64u << 20;  // a page that stopped reading is dropped past this

#ifdef MSG_NOSIGNAL
constexpr int kSendFlags = MSG_NOSIGNAL;
#else
constexpr int kSendFlags = 0;  // macOS: SO_NOSIGPIPE on each socket instead
#endif

void nonBlocking(int fd) {
  const int fl = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, fl | O_NONBLOCK);
  fcntl(fd, F_SETFD, FD_CLOEXEC);
}

}  // namespace

struct Server::Client {
  int fd = -1;
  int id = 0;
  enum State { Http, Ws } state = Http;
  std::string in, out;
  WsParser parser;
  bool closeAfterFlush = false;
  bool dead = false;
};

Server::~Server() {
  for (auto &c : clients_) {
    if (c->fd >= 0) ::close(c->fd);
  }
  if (listenFd_ >= 0) ::close(listenFd_);
  for (int fd : wakeFds_) {
    if (fd >= 0) ::close(fd);
  }
}

bool Server::listen(const std::string &bindAddr, std::uint16_t port, std::string *err) {
  auto fail = [&](const char *what) {
    if (err) *err = std::string(what) + ": " + std::strerror(errno);
    return false;
  };
  if (::pipe(wakeFds_) != 0) return fail("pipe");
  nonBlocking(wakeFds_[0]);
  nonBlocking(wakeFds_[1]);
  listenFd_ = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listenFd_ < 0) return fail("socket");
  int one = 1;
  setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  if (inet_pton(AF_INET, bindAddr.c_str(), &a.sin_addr) != 1) {
    if (err) *err = "bad bind address " + bindAddr;
    return false;
  }
  if (::bind(listenFd_, reinterpret_cast<sockaddr *>(&a), sizeof a) != 0) return fail("bind");
  if (::listen(listenFd_, 64) != 0) return fail("listen");
  socklen_t len = sizeof a;
  getsockname(listenFd_, reinterpret_cast<sockaddr *>(&a), &len);
  port_ = ntohs(a.sin_port);
  nonBlocking(listenFd_);
  return true;
}

void Server::wake() {
  const char b = 1;
  [[maybe_unused]] const auto n = ::write(wakeFds_[1], &b, 1);  // a full pipe already means "wake up"
}

void Server::stop() {
  stop_.store(true);
  if (wakeFds_[1] >= 0) wake();
}

void Server::send(std::string text) {
  if (!hasPage_.load()) {
    std::lock_guard<std::mutex> lk(statMu_);
    ++stats_.droppedOut;
    return;
  }
  {
    std::lock_guard<std::mutex> lk(qMu_);
    queue_.push_back(std::move(text));
  }
  wake();
}

ServerStats Server::stats() const {
  std::lock_guard<std::mutex> lk(statMu_);
  return stats_;
}

void Server::run() {
  std::vector<pollfd> fds;
  while (!stop_.load()) {
    fds.clear();
    fds.push_back({listenFd_, POLLIN, 0});
    fds.push_back({wakeFds_[0], POLLIN, 0});
    for (auto &c : clients_) {
      short ev = POLLIN;
      if (!c->out.empty()) ev |= POLLOUT;
      fds.push_back({c->fd, ev, 0});
    }
    const int r = ::poll(fds.data(), static_cast<nfds_t>(fds.size()), 1000);
    if (r < 0 && errno != EINTR) break;
    if (stop_.load()) break;
    if (fds[1].revents & POLLIN) {
      char buf[256];
      while (::read(wakeFds_[0], buf, sizeof buf) > 0) {
      }
    }
    drainQueue();
    for (std::size_t i = 2; i < fds.size(); ++i) {
      Client &c = *clients_[i - 2];
      if (c.dead) continue;
      if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) onReadable(c);
      if (!c.dead && !c.out.empty()) flushOut(c);
    }
    if (fds[0].revents & POLLIN) accept();
    for (auto it = clients_.begin(); it != clients_.end();) {
      if ((*it)->dead) {
        ::close((*it)->fd);
        it = clients_.erase(it);
      } else {
        ++it;
      }
    }
  }
  if (active_) {
    active_ = 0;
    hasPage_ = false;
    if (hooks_.pageGone) hooks_.pageGone("devhost shutting down");
  }
}

void Server::accept() {
  for (;;) {
    const int fd = ::accept(listenFd_, nullptr, nullptr);
    if (fd < 0) return;
    nonBlocking(fd);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);  // a note-on must not wait for Nagle
#ifdef SO_NOSIGPIPE
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
    auto c = std::make_unique<Client>();
    c->fd = fd;
    c->id = nextId_++;
    clients_.push_back(std::move(c));
  }
}

void Server::drop(Client &c, const char *why) {
  if (c.dead) return;
  c.dead = true;
  if (c.id == active_) {
    active_ = 0;
    hasPage_ = false;
    if (hooks_.pageGone) hooks_.pageGone(why);
  }
}

void Server::onReadable(Client &c) {
  char buf[65536];
  for (;;) {
    const auto n = ::recv(c.fd, buf, sizeof buf, 0);
    if (n > 0) {
      if (c.state == Client::Http) {
        c.in.append(buf, static_cast<std::size_t>(n));
      } else {
        c.parser.feed(buf, static_cast<std::size_t>(n));
        std::lock_guard<std::mutex> lk(statMu_);
        stats_.inBytes += static_cast<std::uint64_t>(n);
      }
      continue;
    }
    if (n == 0) {
      drop(c, "page disconnected");
      return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
    if (errno == EINTR) continue;
    drop(c, "socket error");
    return;
  }
  if (c.state == Client::Http) onHttp(c);
  if (!c.dead && c.state == Client::Ws) onWs(c);
}

void Server::onHttp(Client &c) {
  if (c.closeAfterFlush) return;  // the response is out; ignore pipelined bytes
  bool complete = false;
  std::size_t headLen = 0;
  auto req = parseHttpRequest(c.in, &complete, &headLen);
  if (!complete) {
    if (c.in.size() > kMaxHead) {
      c.out += httpHead(400, "text/plain; charset=utf-8", 0);
      c.closeAfterFlush = true;
    }
    return;
  }
  {
    std::lock_guard<std::mutex> lk(statMu_);
    ++stats_.httpRequests;
  }
  if (!req) {
    const std::string body = "bad request";
    c.out += httpHead(400, "text/plain; charset=utf-8", body.size()) + body;
    c.closeAfterFlush = true;
    return;
  }
  if (req->path == wsPath_) {
    if (!req->isWebSocketUpgrade()) {
      const std::string body = "WebSocket upgrade expected";
      c.out += httpHead(400, "text/plain; charset=utf-8", body.size()) + body;
      c.closeAfterFlush = true;
      return;
    }
    c.out += "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n";
    c.out += "Sec-WebSocket-Accept: " + wsAcceptKey(req->header("sec-websocket-key")) + "\r\n\r\n";
    c.state = Client::Ws;
    c.parser.feed(c.in.data() + headLen, c.in.size() - headLen);  // bytes that followed the head
    c.in.clear();
    for (auto &o : clients_) {  // the newest page wins (a reload, a second tab)
      if (o->id == active_ && !o->dead) {
        active_ = 0;
        hasPage_ = false;
        if (hooks_.pageGone) hooks_.pageGone("replaced by a newer page");
        closeWs(*o, 4000, "replaced by a newer page");
      }
    }
    active_ = c.id;
    {
      std::lock_guard<std::mutex> lk(qMu_);
      queue_.clear();  // events addressed to the previous page
    }
    hasPage_ = true;
    {
      std::lock_guard<std::mutex> lk(statMu_);
      ++stats_.pages;
    }
    if (hooks_.pageOpen) hooks_.pageOpen();
    return;
  }
  HttpResponse res;
  if (req->method != "GET" && req->method != "HEAD") {
    res.code = 405;
    res.body = "method not allowed";
  } else if (hooks_.http) {
    res = hooks_.http(*req);
  }
  c.out += httpHead(res.code, res.type.c_str(), res.body.size());
  if (req->method == "GET" && res.code != 204) c.out += res.body;
  c.closeAfterFlush = true;
}

void Server::closeWs(Client &c, std::uint16_t code, const char *why) {
  wsEncodeFrame(c.out, WsOp::Close, wsClosePayload(code, why));
  c.closeAfterFlush = true;
}

void Server::onWs(Client &c) {
  for (;;) {
    WsParser::Event ev = c.parser.next();
    if (c.parser.failed()) {
      std::fprintf(stderr, "devhost: websocket protocol error: %s\n", c.parser.failReason().c_str());
      closeWs(c, c.parser.failCode(), c.parser.failReason().c_str());
      if (c.id == active_) {
        active_ = 0;
        hasPage_ = false;
        if (hooks_.pageGone) hooks_.pageGone("websocket protocol error");
      }
      return;
    }
    switch (ev.kind) {
      case WsParser::Event::None:
        return;
      case WsParser::Event::Message:
        if (ev.binary || c.id != active_ || c.closeAfterFlush) break;  // the bridge is JSON text only
        {
          std::lock_guard<std::mutex> lk(statMu_);
          ++stats_.inMessages;
        }
        if (hooks_.message) hooks_.message(std::move(ev.payload));
        break;
      case WsParser::Event::Ping:
        wsEncodeFrame(c.out, WsOp::Pong, ev.payload);
        break;
      case WsParser::Event::Pong:
        break;
      case WsParser::Event::Close:
        if (!c.closeAfterFlush) wsEncodeFrame(c.out, WsOp::Close, wsClosePayload(1000, ""));
        c.closeAfterFlush = true;
        if (c.id == active_) {
          active_ = 0;
          hasPage_ = false;
          if (hooks_.pageGone) hooks_.pageGone("page closed the connection");
        }
        return;
    }
  }
}

void Server::drainQueue() {
  std::deque<std::string> q;
  {
    std::lock_guard<std::mutex> lk(qMu_);
    q.swap(queue_);
  }
  if (q.empty()) return;
  Client *page = nullptr;
  for (auto &c : clients_) {
    if (c->id == active_ && !c->dead && !c->closeAfterFlush) page = c.get();
  }
  std::lock_guard<std::mutex> lk(statMu_);
  if (!page) {
    stats_.droppedOut += q.size();
    return;
  }
  for (auto &m : q) {
    wsEncodeFrame(page->out, WsOp::Text, m);
    ++stats_.outMessages;
  }
  if (page->out.size() > kMaxOutBuffered) {
    std::fprintf(stderr, "devhost: page is not reading (%zu bytes queued); dropping it\n", page->out.size());
    page->out.clear();
    page->dead = true;
    active_ = 0;
    hasPage_ = false;
    if (hooks_.pageGone) hooks_.pageGone("page stopped reading");
  }
}

void Server::flushOut(Client &c) {
  while (!c.out.empty()) {
    const auto n = ::send(c.fd, c.out.data(), c.out.size(), kSendFlags);
    if (n > 0) {
      if (c.state == Client::Ws) {
        std::lock_guard<std::mutex> lk(statMu_);
        stats_.outBytes += static_cast<std::uint64_t>(n);
      }
      c.out.erase(0, static_cast<std::size_t>(n));
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    if (n < 0 && errno == EINTR) continue;
    drop(c, "socket error");
    return;
  }
  if (c.closeAfterFlush) {
    ::shutdown(c.fd, SHUT_WR);
    drop(c, "closed");
  }
}

}  // namespace devhost
