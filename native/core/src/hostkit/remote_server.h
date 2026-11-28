// The browser remote's server (remote lane, D45; REMOTE.md §2.4): one poll() thread serving the page, the pairing and
// command routes, a long-poll state route and a WebSocket, to local-network peers only. POSIX sockets (Linux, macOS,
// iOS). Every decision is RemoteService's (remote_service.h) and every parse is remote_net.h's; this file moves bytes.
// Thread-safety: start/stop/publishState/newCode/forgetAll/infoJson from any thread; hooks are called on the server
// thread (or, for `info`, on the thread that changed it), never with a lock held.
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "remote_service.h"

namespace rig::hostkit::remote {

struct ServerHooks {
  /** A bus command for the main page (`{"v":1,"type":…,"via":"remote"}`). Server thread. */
  std::function<void(const std::string &)> command;
  /** What Settings shows changed (code, paired count, pause, on/off). Refresh with infoJson(). */
  std::function<void()> info;
};

struct StartOptions {
  std::string bind;         // empty = every interface (IPv6 dual stack, else IPv4); tests use "127.0.0.1"
  int port = 0;             // 0 = the first free of 8450..8459; > 0 = exactly that port
  bool anyPort = false;     // tests: let the system pick (port is ignored)
};

struct ServerTimeouts {
  std::int64_t httpMs = 15000;     // a plain HTTP connection, start to finish
  std::int64_t longPollMs = 10000; // /api/state?since=… holds this long, then answers anyway
  std::int64_t wsAuthMs = 5000;    // the first WebSocket message must authenticate
  std::int64_t wsIdleMs = 60000;   // a WebSocket with no message at all (the page pings every 20 s)
};

class Server {
 public:
  Server(ServerHooks hooks, Limits limits = {}, ServerTimeouts timeouts = {}, Service::NowMs now = nullptr,
         Service::Random random = nullptr);
  ~Server();
  Server(const Server &) = delete;
  Server &operator=(const Server &) = delete;

  /** The page served at `/` (app/remote/index.html). */
  void setPage(std::string html);
  /** Bind, listen and start the thread. Returns false with `*err` set (port busy, no socket…). */
  bool start(const StartOptions &opt, std::string *err);
  /** Stop the thread, close every socket, end every pairing and roll the code. Idempotent. */
  void stop();
  bool running() const { return running_.load(); }
  std::uint16_t port() const { return port_.load(); }

  /** A bus state from the main page; false when it is invalid (ignored). Wakes long-polls / WebSockets. */
  bool publishState(std::string_view json);
  void newCode();
  void forgetAll();
  /**
   * Settings: {"on","port","addresses":[{"name","ip"}],"url","pairUrl","code","paired","pausedSec","pairingSec",
   * "qr":{…}}. pairingSec: seconds left to pair a phone (0 = closed: press New code).
   */
  std::string infoJson();

  /** Connection limits (tests read them). */
  static constexpr int kMaxClients = 16;
  static constexpr int kMaxClientsPerIp = 4;  // per IPv4 address / per IPv6 /64
  static constexpr std::int64_t kFirstByteMs = 3000;  // a new connection must start its request this soon
  static constexpr std::int64_t kGraceMs = 1500;     // never evicted younger than this (skeptic-2 G1)

 private:
  struct Client;
  void loop();
  void loopOnce();
  void wake();
  void acceptAll();
  void onReadable(Client &c);
  void onHttp(Client &c);
  void onWs(Client &c);
  void flush(Client &c);
  void respond(Client &c, int code, std::string_view type, std::string_view body, std::string_view extra = {});
  void wsSend(Client &c, std::string_view text);
  void wsClose(Client &c, std::uint16_t code, std::string_view why);
  void pushViews();
  void dropStaleTokens();
  void closeLater(Client &c);
  void notifyInfo();
  std::int64_t nowMs() const;

  ServerHooks hooks_;
  ServerTimeouts to_;
  Service::NowMs now_;
  std::mutex mu_;  // guards svc_, page_, and pending_ / infoSeen_
  Service svc_;
  std::string page_;
  std::vector<std::string> pending_;  // bus commands to hand out after the lock is released
  std::uint64_t infoSeen_ = 0;
  bool pairingSeen_ = false, pausedSeen_ = false;  // window / pause edges also refresh Settings (skeptic-2 N7)

  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<bool> stop_{false};
  int listenFd_ = -1;
  std::mutex wakeMu_;  // wake() (any thread) vs stop() closing the pipe (skeptic-2 C5)
  int wakeFds_[2] = {-1, -1};
  std::atomic<std::uint16_t> port_{0};
  bool destroying_ = false;  // ~Server: stop() fires no hook (the host may be tearing down; skeptic-2 C7)
  std::vector<std::unique_ptr<Client>> clients_;  // server thread only
  std::uint64_t lastSeq_ = 0;
  std::atomic<std::uint64_t> forgetEpoch_{0};
  std::uint64_t seenForgetEpoch_ = 0;
};

/** The machine's local-network IPv4 addresses, best first (en0, en1, then the rest; link-local last). */
std::vector<std::pair<std::string, std::string>> localAddresses();

/** The QR code of `text` as {"size":n,"modules":"0101…"} (row by row, 1 = dark), medium error correction. */
std::string qrJson(const std::string &text);

}  // namespace rig::hostkit::remote
