// The dev host's network side: one poll() thread serving HTTP (static files + a few routes, decided by a handler)
// and WebSocket pages. Exactly one page is "active" (the newest WebSocket): engine events go to it, and a newer page
// replaces it (close 4000) the way a WKWebView reload replaces the old document. POSIX sockets (Linux and macOS).
#pragma once
#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "http.h"

namespace devhost {

struct HttpResponse {
  int code = 404;
  std::string type = "text/plain; charset=utf-8";
  std::string body;
};

struct ServerHooks {
  /** Static/route handler for a plain HTTP request (not the upgrade path). */
  std::function<HttpResponse(const HttpRequest &)> http;
  /** A text message from the active page (any other page's messages are dropped). */
  std::function<void(std::string &&)> message;
  /** The active page went away: closed, disconnected or replaced by a newer page. */
  std::function<void(const char *why)> pageGone;
  /** A new page became active. */
  std::function<void()> pageOpen;
};

struct ServerStats {
  std::uint64_t httpRequests = 0, pages = 0, inMessages = 0, outMessages = 0, droppedOut = 0, inBytes = 0,
                outBytes = 0;
};

class Server {
 public:
  Server(std::string wsPath, ServerHooks hooks) : wsPath_(std::move(wsPath)), hooks_(std::move(hooks)) {}
  ~Server();
  Server(const Server &) = delete;
  Server &operator=(const Server &) = delete;

  /** Binds and listens; port 0 picks a free port (see port()). */
  bool listen(const std::string &bindAddr, std::uint16_t port, std::string *err);
  std::uint16_t port() const { return port_; }
  /** Runs the poll loop on the calling thread until stop(). */
  void run();
  /** Ends run(). Async-signal-safe (an atomic store and a write()). */
  void stop();
  /** Queues one text message for the active page (any thread). Dropped (counted) when no page is active. */
  void send(std::string text);
  ServerStats stats() const;
  bool hasPage() const { return hasPage_.load(); }

 private:
  struct Client;
  void wake();
  void accept();
  void onReadable(Client &c);
  void onHttp(Client &c);
  void onWs(Client &c);
  void flushOut(Client &c);
  void drainQueue();
  void drop(Client &c, const char *why);
  void closeWs(Client &c, std::uint16_t code, const char *why);

  std::string wsPath_;
  ServerHooks hooks_;
  int listenFd_ = -1;
  int wakeFds_[2] = {-1, -1};
  std::uint16_t port_ = 0;
  std::atomic<bool> stop_{false};
  std::vector<std::unique_ptr<Client>> clients_;
  int nextId_ = 1;
  int active_ = 0;  // id of the active page, 0 = none
  std::atomic<bool> hasPage_{false};
  std::mutex qMu_;
  std::deque<std::string> queue_;
  mutable std::mutex statMu_;
  ServerStats stats_;
};

}  // namespace devhost
